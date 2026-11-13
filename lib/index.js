/**
 * dsh-offpeak —— 按 DeepSeek 峰谷价推迟模型调用。
 *
 * 闸门挂在 `llm/stream`：这一步之前用户消息已经落盘（`agent-loop` 的 `step()`
 * 先 append `user/message` 再调 `llm.stream()`），所以等待期间崩掉最坏只是
 * 「这一轮没答」，话还在历史里。
 *
 * 不做队列、不做状态机：串行是 `while (await turn())` 的天然结果，排队是
 * `inbox.claim("next-turn")` 每次只取一条的天然结果。
 *
 * 但**重启**会留下两种残局，各由一条支路处理（都在 `agent/created` 的 resume 时机）：
 * - 排队中的消息（`resumePending`）：inbox 里的记录不丢，缺的是那一脚唤醒；
 * - 正在执行的那一轮（`resumeInterruptedTurn`）：日志尾部是 `turn/end` 的打断态，
 *   补一条续跑提示让模型接着断点做。见 `resume-turn.js`。
 */

import { isPeak, localParts, nextPeakAt, nextReleaseAt, safeTimeZone, MAX_TIMER_DELAY_MS } from './peak-window.js';
import { continueInterruptedTurn } from './resume-turn.js';

export { continueInterruptedTurn, planTurnContinuation, inspectTail, isInterruptedTurnReason, buildContinuationMessage, CONTINUATION_TEXT, NUDGE_SOURCE_KIND } from './resume-turn.js';

export const name = 'dsh-offpeak';

/**
 * 插件版本，与 package.json 的 version 必须一致（`test/version.test.mjs` 会盯着）。
 *
 * **为什么要在代码里写死一份**：宿主加载插件是「按磁盘文件重新 import」，磁盘上换了新包、
 * 内存里跑的却可能还是旧代码（安装返回 applied 只说明 reconcile 通过了，不等于这一份
 * 文件真的被求值）。`/dsh-offpeak/status` 与 `/peak` 都读这个常量，于是「报出来的版本」
 * 就是**正在运行的那份代码**的版本 —— 这才有诊断价值。读 package.json 做不到这点：
 * 那读的是磁盘，不是内存。
 */
export const VERSION = '0.1.19';

/**
 * 顶层不声明任何必需服务。
 *
 * 闸门挂在 `llm/stream` 事件上，事件派发不需要持有服务实例；把 `commands` /
 * `sessions` 写进 inject 只会让整个插件在任一服务缺席时永久 pending，连带
 * 闸门也装不上。命令、会话查询与日志改为在服务可用时再挂（见 `apply`），
 * 服务晚到也不影响已经生效的闸门。
 */
export const inject = [];

/** 配置默认值。全部可在 cordis.patch.yml 的插件 config 里改。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  timeZone: 'Asia/Shanghai',
  peakWindows: null, // null = 用 peak-window.js 的 DEFAULT_PEAK_WINDOWS
  releaseJitterSeconds: [60, 120],
  manualReleaseCommand: true,
  dryRun: false,
  resumePending: true,
  resumeInterruptedTurn: true,
});

/** `/peak now` 之后这段时间内的调用一律放行（毫秒）。 */
const MANUAL_BYPASS_MS = 60_000;

/** 高峰期会被扣住的 provider 关键词（大小写不敏感的**包含**匹配，见 `shouldHoldForCall`）。 */
const HOLD_PROVIDER_KEYWORDS = ['deepseek', 'workbuddy'];

/** 高峰期会被扣住的 model 关键词（大小写不敏感的**包含**匹配，见 `shouldHoldForCall`）。 */
const HOLD_MODEL_KEYWORD = 'deepseek';

// ---------------------------------------------------------------------------
// 纯函数（可单测）
// ---------------------------------------------------------------------------

/**
 * 把插件 config 归一成 peak-window 能吃的形状。
 *
 * **必须幂等**：`Config['~standard'].validate()` 会先归一一次，`apply()` 里
 * 又归一一次。若只认 `releaseJitterSeconds`，第二次拿到的就是自己产出的
 * `jitter` 字段，会静默退回默认值，用户改的抖动区间直接丢失。
 * 所以两个键名都认。
 */
export function normalizeConfig(config) {
  const raw = config ?? {};
  const source = Array.isArray(raw.releaseJitterSeconds) ? raw.releaseJitterSeconds : raw.jitter;
  const jitter = Array.isArray(source) && source.length === 2 ? source : DEFAULTS.releaseJitterSeconds;
  return {
    enabled: raw.enabled !== false,
    timeZone: safeTimeZone(raw.timeZone),
    // `null`/缺省 → 用内置默认窗口；显式给数组（含空数组）→ 以配置为准。
    // 空数组是一个有意义的配置：等于「没有高峰」，即完全关闭拦截。
    peakWindows: Array.isArray(raw.peakWindows) ? raw.peakWindows : null,
    jitter,
    manualReleaseCommand: raw.manualReleaseCommand !== false,
    // 只报告不拦：第一次装上时用它可以先看日志里会拦几次，确认规则没写错再关掉。
    dryRun: raw.dryRun === true,
    // 重启后自动把上次没跑完的排队消息推一把。
    resumePending: raw.resumePending !== false,
    // 重启后自动接着跑上次被重启打断的那一轮。
    resumeInterruptedTurn: raw.resumeInterruptedTurn !== false,
  };
}

/**
 * 这个会话是不是被委派出去的（子代理 / 队友）。
 *
 * 只用于「重启后不要替它们续跑」这类自动动作，**不再用于闸门豁免**：
 * 闸门是否生效由会话链上的开关继承，见 `createGate` 里的 `sessionChain`。
 * 保留三种标记的识别，因为历史日志里三种都出现过。
 */
export function isDelegatedSession(session) {
  if (session === undefined || session === null) return false;
  const header = session.header ?? {};
  if (header.origin === 'subagent') return true;
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true;
  if (typeof header.delegationDepth === 'number' && header.delegationDepth >= 1) return true;
  return false;
}

/**
 * 这次调用要不要拦。
 *
 * **只拦真正的对话请求**。宿主里所有模型调用都走同一个 `llm/stream`：
 * 会话标题生成、上下文压缩、自动审核这些后台动作**也带 sessionId**，
 * 只按「有没有 sessionId」判断会把它们一起扣到低谷 —— 用户看到的是
 * 「标题半天不出来」「压缩卡住」，而不是这个插件的提示条。
 *
 * 判据只能信 `isAgentLoopRequest`：`dsh-agent-loop` 组装完请求后会
 * `markAgentLoopRequest(request)`，而那三个后台调用都不打这个标。
 * 反过来按 `purpose` 白名单筛不可靠：真对话请求根本不传 purpose。
 *
 * @param {object} options - `llm/stream` 的 options。
 * @param {object} config - 已归一化的 config。
 * @param {{getSession?: (id: string) => object|undefined, isAgentLoopRequest?: (o: object) => boolean}} deps
 */
export function shouldGate(options, config, deps = {}) {
  if (!config.enabled) return false;
  if (options === undefined || options === null) return false;
  // 没有 sessionId 的调用一定不是 agent-loop 发起的（真正的主循环请求必然带它）。
  if (typeof options.sessionId !== 'string' || options.sessionId === '') return false;
  const isLoop = deps.isAgentLoopRequest;
  if (typeof isLoop === 'function') return isLoop(options) === true;
  /**
   * 退化路径：拿不到宿主的标记函数时（宿主改了导出、解析失败），
   * 用「有没有 purpose」近似。三个已知后台调用都显式传了 purpose，
   * 而主循环请求不传 —— 比「有 sessionId 就拦」安全得多：
   * 宁可偶尔少拦一次，也不要把别人的标题/压缩扣在高峰里。
   */
  const purpose = options.purpose;
  return typeof purpose !== 'string' || purpose === '';
}

/** provider 这一关：转小写后按**包含**匹配，命中 `deepseek` 或 `workbuddy` 任一个即可。 */
function providerInScope(provider) {
  if (typeof provider !== 'string' || provider === '') return false;
  const lower = provider.toLowerCase();
  return HOLD_PROVIDER_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/** model 这一关：转小写后按**包含**匹配 `deepseek`。 */
function modelInScope(model) {
  if (typeof model !== 'string' || model === '') return false;
  return model.toLowerCase().includes(HOLD_MODEL_KEYWORD);
}

/**
 * 高峰时这一次调用该不该扣住（2026-11-13 用户拍板，最终口径）。
 *
 * 峰谷折扣是 **DeepSeek 官方 API 的价格规则**，但本机并没有 DeepSeek 官方直连：
 * `deepseek-*` 系列是走 `workbuddy` / `workbuddy-global` 通道进来的，挂的是那条通道的
 * 「非高峰 5 折」。反过来，同一个通道里也跑着别的模型，而 `qwenwork` 这类没有峰谷折扣的
 * 通道里也可能出现 deepseek 模型。所以**只看 model 不够**，必须 provider 与 model
 * 两个条件同时成立才值得等：
 *
 * - provider（大小写不敏感，**包含**匹配）：含 `deepseek` **或** 含 `workbuddy`；
 * - model（大小写不敏感，**包含**匹配）：含 `deepseek`。
 *
 * 这是「与」而不是「或」：provider 不命中的 deepseek 模型不扣（那个通道没折扣），
 * provider 命中但模型不是 deepseek 的也不扣（这个模型没折扣）。
 *
 * **fail-open**：provider 或 model 任一缺失 / 为 null / 空串 / 非字符串 → 放行；
 * 判定过程本身出任何意外（含读取字段抛错）也兜住并放行。与插件其余判据同一个取向 ——
 * 判据自己出问题时宁可少拦一次，也不要把一次调用扣在高峰里。宿主组装的
 * `GenerateOptions` 把 `provider` / `model` 都声明为必填 string（`dsh-llm/src/types.ts:564-567`），
 * 缺失只可能出现在别家插件手搓的请求上，而那些本来就不该由本插件管。
 *
 * 只读 `options`：宿主传进来的是 `Object.freeze` 过的请求信封，本函数不写任何字段。
 *
 * @param {{ provider?: unknown, model?: unknown }} [options] - `llm/stream` 的请求信封。
 * @returns {boolean} `true` = 高峰期扣住等低谷；`false` = 立即放行。
 */
export function shouldHoldForCall(options) {
  try {
    if (options === null || typeof options !== 'object') return false;
    return providerInScope(options.provider) && modelInScope(options.model);
  } catch {
    return false;
  }
}

/** 本次调用应当等到什么时候。已在低谷 → 返回 `null` 表示立即放行。 */
export function releaseFor(now, config, random = Math.random) {
  const releaseAt = nextReleaseAt(now, {
    timeZone: config.timeZone,
    peakWindows: config.peakWindows ?? undefined,
    jitter: config.jitter,
    random,
  });
  return releaseAt.getTime() > now.getTime() ? releaseAt : null;
}

// ---------------------------------------------------------------------------
// 等待
// ---------------------------------------------------------------------------

/**
 * 等到 `releaseAt`，或提前被 `signal` 打断 / 被手动放行。
 *
 * 必须自己 race 信号：`step()` 的两个 `throwIfAborted()` 检查点分别在
 * 发请求前和拿到 chunk 之后，等待发生在 `for await` 的第一次 pull 里，
 * 两个都够不着。不处理就是「点了停止没反应，一直挂到 18:02」。
 *
 * @returns {Promise<'due'|'manual'>} 被打断时 reject。
 */
export function waitForRelease(releaseAt, signal, options = {}) {
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? { setTimeout, clearTimeout };
  const subscribe = options.onManualRelease;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let unsubscribe = null;

    const cleanup = () => {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
      if (signal !== undefined && signal !== null) signal.removeEventListener?.('abort', onAbort);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    function onAbort() {
      fail(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }

    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (typeof subscribe === 'function') unsubscribe = subscribe(() => finish('manual'));

    // 分片等待：单次 setTimeout 上限 2^31-1 ms（约 24.8 天）。
    const step = () => {
      if (settled) return;
      const remaining = releaseAt.getTime() - now();
      if (remaining <= 0) {
        finish('due');
        return;
      }
      timer = timers.setTimeout(step, Math.min(remaining, MAX_TIMER_DELAY_MS));
    };
    step();
  });
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

/**
 * 把时刻格式化成给人看的短标签（按插件时区），只用于日志与命令输出。
 *
 * **必须带日期，但只在跨日时带**：周四 23:30 的调用排到的是**次日** 01:01，
 * 只写 `01:01` 会让人以为「等半小时就到了」，实际是等一个半小时。反过来，
 * 同一天的时刻再补上日期纯属噪音，界面提示条一窄就挤不下了。
 */
function stampOf(date, timeZone, now = new Date()) {
  const parts = localParts(date, timeZone);
  const pad = (value) => String(value).padStart(2, '0');
  const clock = `${pad(parts.hour)}:${pad(parts.minute)}`;
  const today = localParts(now, timeZone);
  if (parts.year === today.year && parts.month === today.month && parts.day === today.day) {
    return clock;
  }
  // 「明天」单拎出来：这是最常见的一种跨日，写成「明天 01:01」比「11月13日 01:01」
  // 更好懂（尤其对一天之内就被看到的提示条）。
  const tomorrow = localParts(new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone);
  if (parts.year === tomorrow.year && parts.month === tomorrow.month && parts.day === tomorrow.day) {
    return `明天 ${clock}`;
  }
  return `${parts.month}月${parts.day}日 ${clock}`;
}

// ---------------------------------------------------------------------------
// 重启后的续跑
// ---------------------------------------------------------------------------

/**
 * 重启之后，把上次没跑完的排队消息重新推起来。
 *
 * **为什么需要这一步**：`agent.followup()` 投进来的消息不会丢 —— 每次入队都会
 * 落一条 `agent/inbox/spliced` 事件，重启加载会话时 inbox 投影按事件重建，
 * 所以「队列里还有什么」是完整的。丢的是**那一脚**：`wakeDriver()` 只在三处被
 * 调用（`send()` 带 wakeup、maintenance 收尾、`kick()` 收尾），resume 路径只把
 * inbox 重建出来，没有任何人检查 `hasPending`。队列于是永远躺着不动，直到用户
 * 再发一条消息才被顺带带出来。
 *
 * **为什么在这里调是安全的**：`agent/created` 派发发生在 `initializeAgent` 的
 * `runMaintenance(...)` 内部，此刻 phase.kind 是 `"maintenance"`。`wakeDriver()`
 * 在这种状态下**不会**重入主循环，只把 `phase.wakeRequested = true` 记下来；
 * 等 announce 返回、`runMaintenance` 的 finally 执行时，框架自己判断
 * `wakeRequested && inbox.hasPending` 再开循环（`agent-loop` 的
 * `runMaintenance` 收尾那三行）。所以这里不需要（也不能）等 announce 结束。
 *
 * **必须是同步且不抛错的**：`agent/created` 走的是 cordis 的 `serial` 派发，
 * 监听器抛出的异常会一路冒到 `announce()`，把整个 agent 创建搞失败。重启时因为
 * 「顺手推一把」而导致会话打不开，是绝对不能接受的降级，所以整个函数体兜在
 * try/catch 里。
 *
 * @param {{agent?: object, source?: string}} payload - `agent/created` 的载荷。
 * @param {() => object} getConfig - 读当前配置。
 * @param {{logger?: object}} deps
 * @returns {string} 本次做了什么，仅供日志与单测断言。
 */
export function recoverPendingOnResume(payload, getConfig, deps = {}) {
  try {
    const config = normalizeConfig(typeof getConfig === 'function' ? getConfig() : getConfig);
    if (!config.resumePending) return 'disabled';

    const { agent, source } = payload ?? {};
    // 只有「重新打开一份已有会话」才需要续跑。`startup` 是新建，inbox 本来就是空的。
    if (source !== 'resume') return 'skipped:source';
    if (agent === undefined || agent === null) return 'skipped:no-agent';

    /**
     * 委派会话（子代理）不参与自动动作。
     *
     * 续跑的语义是「人重新打开自己的会话，替他把没跑完的活接上」。子代理的会话
     * 是主会话派出去的，用户不会去打开它；而且它被恢复时主会话那条路已经在驱动
     * inbox 了，这里再叫醒一次就是重复驱动同一份队列。
     *
     * 判定与 `continueInterruptedTurn`（见 lib/resume-turn.js）保持一致：拿不到
     * session 对象就当「不是委派会话」，绝不让判据本身把恢复流程卡死。
     */
    if (typeof deps.isDelegatedSession === 'function') {
      let session;
      try {
        session = agent.session ?? deps.getSession?.(agent.id);
      } catch {
        session = undefined;
      }
      if (session !== undefined && session !== null && deps.isDelegatedSession(session) === true) {
        return 'skipped:delegated';
      }
    }

    // `agent.inbox` 不在 `Agent` 的公开类型面上（那是 `ReactLoopAgent` 的运行时字段），
    // 版本一变就可能没有。缺了就当没有排队消息，绝不因此抛错。
    let inbox;
    try {
      inbox = agent.inbox;
    } catch {
      return 'skipped:no-inbox';
    }
    if (inbox === undefined || inbox === null) return 'skipped:no-inbox';
    if (inbox.hasPending !== true) return 'skipped:empty';

    const pendingTurn = Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0;
    const pendingStep = Array.isArray(inbox.nextStep) ? inbox.nextStep.length : 0;

    /**
     * 首选直接叫醒驱动器。
     *
     * 不走「remove 一条再 followup 一遍」是因为那会**打乱顺序**：inbox 是先进先出，
     * 取出队首再追加到队尾，等于把 A、B、C 变成 B、C、A。重启后接着跑，最不能
     * 接受的就是用户排好的顺序被打乱。
     */
    const wake = agent.wakeDriver;
    if (typeof wake === 'function') {
      wake.call(agent);
      deps.logger?.info?.(
        `offpeak: 重启后恢复排队（${pendingTurn} 条待发、${pendingStep} 条待注入）`,
      );
      return 'woken';
    }

    /**
     * 没有 `wakeDriver` 时的退路：挪**最后一条**。
     *
     * 取出最后一条再重新投递，位置仍然是末尾，顺序不变；只是借 `followup()` /
     * `steer()` 顺带触发那一次唤醒。前提是这条消息必须先从 inbox 里摘掉 ——
     * `inbox.mutate()` 对重复 id 会直接抛 `already pending`。
     */
    const followup = agent.followup;
    const steer = agent.steer;
    const remove = inbox.remove;
    if (typeof remove !== 'function') return 'skipped:no-remove';

    if (pendingTurn > 0 && typeof followup === 'function') {
      const message = inbox.nextTurn[pendingTurn - 1];
      if (message === undefined) return 'skipped:no-message';
      remove.call(inbox, message.id);
      followup.call(agent, message);
      deps.logger?.info?.(`offpeak: 重启后恢复排队（重投 1 条，共 ${pendingTurn} 条待发）`);
      return 'resent:turn';
    }
    if (pendingStep > 0 && typeof steer === 'function') {
      const message = inbox.nextStep[pendingStep - 1];
      if (message === undefined) return 'skipped:no-message';
      remove.call(inbox, message.id);
      steer.call(agent, message);
      deps.logger?.info?.(`offpeak: 重启后恢复排队（重投 1 条，共 ${pendingStep} 条待注入）`);
      return 'resent:step';
    }
    return 'skipped:no-transport';
  } catch (error) {
    // 见 JSDoc：这里绝不能把异常放出去，否则会连带让会话打不开。
    deps.logger?.warn?.(`offpeak: 重启续跑失败（已忽略）：${error?.message ?? error}`);
    return 'error';
  }
}

// ---------------------------------------------------------------------------
// 配置 schema
// ---------------------------------------------------------------------------

/**
 * 设置页要读的字段表。
 *
 * 没有 `Config` 导出也能跑（loader 里 `if (!runtime.Config) return config`），
 * 但那样设置页看不到任何开关，改配置只能手编 `cordis.patch.yml`。
 * 这里按 `dsh-unlag` 的同一形状给一份最小 schema，坏值一律回落默认、绝不抛错
 * ——启动期抛错会让整个插件装不上。
 */
const CONFIG_FIELDS = {
  enabled: { type: 'boolean', meta: { default: true, description: '总开关；关掉即完全不拦' } },
  dryRun: { type: 'boolean', meta: { default: false, description: '只记日志不拦截，用来先确认规则' } },
  manualReleaseCommand: { type: 'boolean', meta: { default: true, description: '注册 /peak 与 /peak now 命令' } },
  resumePending: { type: 'boolean', meta: { default: true, description: '重启后自动推一把上次没跑完的排队消息' } },
  resumeInterruptedTurn: { type: 'boolean', meta: { default: true, description: '重启后自动接着跑上次被重启打断的那一轮' } },
  timeZone: { type: 'string', meta: { default: 'Asia/Shanghai', description: '判定峰谷用的时区' } },
  releaseJitterSeconds: { type: 'array', meta: { default: [60, 120], description: '高峰结束后随机再等多少秒' } },
  // 默认写 null 而不是 []：`[]` 在本插件里是「没有高峰 = 完全不拦」这个有意义的配置，
  // 若把 schema 默认值设成 []，设置页随便改个别的东西就可能把空数组写进配置，
  // 闸门会被静默关掉。null = 用内置的周一至周五 09-12、14-18。
  peakWindows: { type: 'array', meta: { default: null, description: '高峰窗口；null 用内置的周一至周五 09-12、14-18，[] 表示没有高峰' } },
};

/** 设置页渲染用的 schema。 */
export const Config = {
  type: 'object', // ui-copy-ignore
  dict: CONFIG_FIELDS, // ui-copy-ignore
  meta: { default: {} }, // ui-copy-ignore
  toJSON() {
    return { type: 'object', refs: {}, dict: CONFIG_FIELDS }; // ui-copy-ignore
  },
  '~standard': {
    version: 1, // ui-copy-ignore
    vendor: 'dsh-offpeak', // ui-copy-ignore
    validate(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      return { value: normalizeConfig(source) };
    },
  },
};

/** 给 `ctx.on` 用的监听器工厂（单独导出便于单测）。 */
export function createGate(getConfig, deps) {
  const manualRelease = new Map(); // sessionId -> Set<() => void>
  const manualBypassUntil = new Map(); // sessionId -> epoch ms
  /**
   * 会话级开关：sessionId -> false（关）。**只记「关」**，默认即开 ——
   * 这样内存里没有条目就是开，重启后自然回到默认开（本版不做持久化）。
   *
   * 与 config.enabled 是两层：config.enabled 是全局总开关（改了要重启/重载配置），
   * 这里的是界面上那个开关，只影响当前会话，活到进程结束。
   */
  const sessionSwitch = new Map(); // sessionId -> false
  /**
   * 正在等待放行的调用：sessionId -> Set<{ releaseAt: number }>。
   *
   * 同一会话的调用理论上串行（`while (await turn())`），但停止后重试、客户端重连
   * 都可能让两个调用短暂并存。这里给每个调用一个令牌而不是存单个值：后一个调用
   * 覆盖前一个，就会在前一个还在等的时候报「没在等」。
   */
  const waiting = new Map();
  const clock = typeof deps.now === 'function' ? deps.now : () => new Date();

  const wake = (sessionId) => {
    const waiters = manualRelease.get(sessionId);
    if (waiters === undefined) return 0;
    let count = 0;
    for (const notify of [...waiters]) {
      notify();
      count += 1;
    }
    return count;
  };

  const subscribe = (sessionId) => (notify) => {
    let waiters = manualRelease.get(sessionId);
    if (waiters === undefined) {
      waiters = new Set();
      manualRelease.set(sessionId, waiters);
    }
    waiters.add(notify);
    return () => {
      waiters.delete(notify);
      if (waiters.size === 0) manualRelease.delete(sessionId);
    };
  };

  /**
   * 会话链：`[本会话, 父会话, 祖父会话, ...]`。
   *
   * 子代理的 `header.parentSession` 指回父会话（`dsh-session` 会校验这个字段），
   * 所以「主会话关掉开关」可以沿链作用到子代理。拿不到会话（服务缺席、id 不在
   * 活动表里）时链就到此为止，按「没有上级」处理 —— 缺省仍是开。
   *
   * 上限 32 层与 `seen` 同时上：日志里见过 depth 2，但坏数据不该让一次模型调用
   * 卡在解析链上。
   */
  const MAX_SESSION_CHAIN = 32;
  const sessionChain = (sessionId) => {
    const chain = [];
    const seen = new Set();
    let current = sessionId;
    while (
      typeof current === 'string' && current !== ''
      && !seen.has(current) && chain.length < MAX_SESSION_CHAIN
    ) {
      seen.add(current);
      chain.push(current);
      let session;
      try {
        session = deps.getSession?.(current);
      } catch {
        session = undefined;
      }
      const parent = session?.header?.parentSession;
      current = typeof parent === 'string' && parent !== '' ? parent : undefined;
    }
    return chain;
  };

  /** 链上除自己以外的任何一环被关掉 = 继承到「关」。 */
  const inheritedOff = (sessionId) => {
    const chain = sessionChain(sessionId);
    for (let index = 1; index < chain.length; index += 1) {
      if (sessionSwitch.get(chain[index]) === false) return true;
    }
    return false;
  };

  /** `llm/stream` 监听器本体。 */
  const listener = (options, next) => {
    const config = normalizeConfig(getConfig());
    if (!shouldGate(options, config, deps)) return next();

    const sessionId = options.sessionId;
    // 会话级开关关掉（含从主会话继承来的「关」）= 本会话一律不排队；
    // 全局能走的判断已经在 shouldGate 里过了。
    if (!sessionEnabled(sessionId)) return next();
    const now = clock();
    const bypassUntil = manualBypassUntil.get(sessionId);
    if (bypassUntil !== undefined) {
      if (bypassUntil > now.getTime()) {
        /**
         * 每次在旁路里放行都把窗口往后推。
         *
         * 手动放行的意思是「这一轮别等了」，而一轮里往往有多次模型调用（工具调用
         * 之后还要再问一次）。只给固定 60 秒的话，长回合会在第二步又被拦下来，
         * 用户点了「立即运行」却看到它中途停住——那不是他要的结果。
         * 改成「只要调用还在持续就续期，停下来 60 秒后自动失效」：
         * 本轮跑完，下一轮照常拦。
         */
        manualBypassUntil.set(sessionId, now.getTime() + MANUAL_BYPASS_MS);
        return next();
      }
      manualBypassUntil.delete(sessionId);
    }

    const releaseAt = releaseFor(now, config);
    if (releaseAt === null) return next();

    /**
     * 走到这里说明**确实是高峰**。接下来才判「这一次值不值得等」（2026-11-13 用户拍板）：
     * provider 含 `deepseek` / `workbuddy` **且** model 含 `deepseek`，两个都成立才扣；
     * 其余组合（含字段缺失）都在高峰里立即放行。
     *
     * 放在 `releaseAt === null`（低谷）之后，是为了让低谷路径**一个字节都不变**：
     * 低谷本来就全部放行，不该为它多算一次判定。放在「排到几点」那条日志之前，
     * 是为了不给一个根本没被扣住的调用留下「排到 12:00」的假日志。
     */
    if (!shouldHoldForCall(options)) {
      deps.logger?.info?.(
        `offpeak: ${sessionId} 高峰，但 provider ${typeof options.provider === 'string' && options.provider !== '' ? options.provider : '(缺)'} / 模型 ${typeof options.model === 'string' && options.model !== '' ? options.model : '(缺)'} 不在拦截范围（只等 deepseek / workbuddy 通道里的 deepseek 模型），立即放行`,
      );
      return next();
    }

    const stamp = stampOf(releaseAt, config.timeZone, now);
    deps.logger?.info?.(`offpeak: ${sessionId} 高峰，本次调用排到 ${stamp}`);
    if (config.dryRun) {
      deps.logger?.info?.('offpeak: dryRun 已开，只记录不拦截');
      return next();
    }

    return (async function* gate() {
      /**
       * 登记必须在真正开始等待之前：客户端轮询问「在等吗」时，此刻正是它该看到
       * `waiting: true` 的起点。用 finally 而不是在 waitForRelease 之后再删，
       * 是因为放行、abort、手动唤醒三条路径都以不同方式结束，漏掉任何一条都会
       * 让状态永远停在「等待中」——那比不显示更糟，用户会一直以为还在排队。
       */
      const ticket = { releaseAt: releaseAt.getTime(), provider: options.provider, model: options.model };
      let waitingSet = waiting.get(sessionId);
      if (waitingSet === undefined) {
        waitingSet = new Set();
        waiting.set(sessionId, waitingSet);
      }
      waitingSet.add(ticket);
      try {
        /**
         * 登记之后再查一次开关。
         *
         * listener() 的会话检查发生在它被调用那一刻，而生成器体要到宿主真正开始
         * 迭代时才执行；如果用户恰好在这两步之间关掉主会话（或本会话），这次调用
         * 尚未登记在 waiting 里，`setSessionEnabled` 的唤醒循环就看不到它，于是会
         * 一直排到 releaseAt。这里补一次检查，把窗口收掉。
         */
        if (!sessionEnabled(sessionId)) {
          deps.logger?.info?.(`offpeak: ${sessionId} 开关已关，登记后直接放行`);
          yield* next();
          return;
        }
        await waitForRelease(releaseAt, options.signal, {
          now: () => clock().getTime(),
          onManualRelease: subscribe(sessionId),
        });
        options.signal?.throwIfAborted();
        deps.logger?.info?.(`offpeak: ${sessionId} 放行（计划 ${stamp}）`);
      } finally {
        waitingSet.delete(ticket);
        if (waitingSet.size === 0) waiting.delete(sessionId);
      }
      yield* next();
    })();
  };

  /**
   * 手动放行：叫醒正在等的调用，并给本会话开一段旁路。
   *
   * 旁路窗口在每次命中时续期（见 `listener`），所以它的实际语义是
   * 「只要这一轮还在跑就不再拦；停下来 60 秒后自动恢复」。`/peak now`
   * 命令与界面上的「立即运行」按钮共用这一个动作——两者是同一件事。
   */
  const releaseNow = (sessionId) => {
    manualBypassUntil.set(sessionId, clock().getTime() + MANUAL_BYPASS_MS);
    return wake(sessionId);
  };

  /**
   * 本会话开关现在是开还是关（缺省开）。
   *
   * 不是只看自己的条目：链上任何一环被关掉都算关，子代理据此继承主会话的选择。
   * 空 sessionId 视为开，避免把「拿不到 id」误判成「用户关了」。
   */
  const sessionEnabled = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return true;
    for (const id of sessionChain(sessionId)) {
      if (sessionSwitch.get(id) === false) return false;
    }
    return true;
  };

  /**
   * 切换本会话的错峰开关，返回切换后的完整状态（另附 `woken`）。
   *
   * 关掉时顺手唤醒正在等的调用，并清掉手动旁路：用户点「关」的意思是
   * 「这一轮别再等了」。只改开关不叫醒的话，已经在等的那次仍会挂到低谷，
   * 而界面已经显示「已关」—— 那就是在骗人。
   */
  const setSessionEnabled = (sessionId, enabled) => {
    let woken = 0;
    if (enabled === true) {
      sessionSwitch.delete(sessionId);
    } else {
      sessionSwitch.set(sessionId, false);
      manualBypassUntil.delete(sessionId);
      woken = wake(sessionId);
      /**
       * 关掉主会话时，继承它的子代理里正在等的调用也要立刻放行。
       * 只叫醒自己，会出现「主会话显示已关、子代理还挂在低谷」的裂缝。
       */
      for (const otherId of [...waiting.keys()]) {
        if (otherId === sessionId) continue;
        if (!sessionEnabled(otherId)) {
          manualBypassUntil.delete(otherId);
          woken += wake(otherId);
        }
      }
    }
    return { ...status(sessionId), woken };
  };

  /**
   * 这个会话现在是什么状态，供 HTTP 路由与客户端半插件读取。
   *
   * `releaseAt` 优先取等待表里的真实值：那是**这一个**调用实际排到的时刻，
   * 带着当初抽到的抖动。没有调用在等时才用 `releaseFor` 预测——预测会重新抽
   * 一次随机抖动，所以它只能当作「大概会等到几点」，不能当成承诺。
   */
  const status = (sessionId) => {
    const config = normalizeConfig(getConfig());
    const now = clock();
    const peak = isPeak(now, { timeZone: config.timeZone, peakWindows: config.peakWindows ?? undefined });

    let releaseAt = null;
    // 只在真有调用在等时才有值：它就是「为什么在等」里唯一需要额外说明的那部分
    // —— 拦截范围自 0.1.17 起是「provider 含 deepseek/workbuddy 且 model 含 deepseek」，
    // 等的那个调用必然同时带这样的 provider 与模型名。
    let heldProvider = null;
    let heldModel = null;
    const waiters = waiting.get(sessionId);
    if (waiters !== undefined && waiters.size > 0) {
      // 取最早的那个：串行场景下只会有一个，并存时先放行的是最早排到的。
      for (const ticket of waiters) {
        if (releaseAt === null || ticket.releaseAt < releaseAt) {
          releaseAt = ticket.releaseAt;
          heldProvider = typeof ticket.provider === 'string' && ticket.provider !== '' ? ticket.provider : null;
          heldModel = typeof ticket.model === 'string' && ticket.model !== '' ? ticket.model : null;
        }
      }
    } else {
      const predicted = releaseFor(now, config);
      releaseAt = predicted === null ? null : predicted.getTime();
    }

    return {
      enabled: config.enabled,
      dryRun: config.dryRun,
      /**
       * 本会话**有效**的错峰开关（界面上的那个）。缺省 true；链上任一环关了
       * 这里就是 false。与 config.enabled 的全局总开关是两层，客户端据此画出
       * 开关位置。
       */
      sessionEnabled: sessionEnabled(sessionId),
      /**
       * 这个「关」是从主会话继承来的吗？
       *
       * 客户端据此把子代理会话里的开关置灰（它自己改不了主会话的决定），
       * 而不是给出一个点了也不生效的开关。
       */
      inheritedOff: inheritedOff(sessionId),
      peak,
      waiting: waiters !== undefined && waiters.size > 0,
      /**
       * 正在等的那个调用的模型名；没有调用在等时为 `null`。
       *
       * 0.1.17 起高峰期只扣「provider 含 `deepseek` / `workbuddy` 且 model 含 `deepseek`」
       * 的调用（用户 2026-11-13 拍板），所以这个值一定含 `deepseek`。留它是为了回答
       * 「它为什么在等」：0.1.18 起界面不再显示「已排队」这类文案，要回答这个问题
       * 只能看这里或宿主日志。而高峰 + 某个不打折的模型本该立即放行 —— 万一哪天判据
       * 被改坏、或宿主换了 model 的取法，从这里能一眼看出扣住的是谁，不必去翻日志。
       * 纯诊断字段，客户端不读它，界面形状也不因它改变。
       */
      heldModel,
      /**
       * 正在等的那个调用的 provider 名；没有调用在等时为 `null`。
       *
       * 与 `heldModel` 成对：两个条件都在拦截范围内才会有调用被扣住，合起来就是
       * 「它为什么在等」的完整证据。纯诊断字段，客户端不读它。
       */
      heldProvider,
      /**
       * 手动放行的旁路是否还在生效。
       *
       * 客户端靠它在旁路期隐藏「立即运行」按钮：用户刚点过它，按钮还挂着只会
       * 让人重复点。旁路一失效，只要还有人在等，按钮会按状态重新出现。
       */
      bypassing: (manualBypassUntil.get(sessionId) ?? 0) > now.getTime(),
      releaseAt,
      releaseLabel: releaseAt === null ? null : stampOf(new Date(releaseAt), config.timeZone, now),
      /**
       * 现在用的是哪一套「这次调用是不是真对话」判据。
       *
       * `agent-loop` = 拿到了宿主导出的 `isAgentLoopRequest`，后台调用（标题生成、
       * 压缩、自动审核）按宿主标记放行，这是准确判据；
       * `purpose` = 没拿到那个函数，退化成「带 purpose 的就是后台调用」。
       * 两者都工作，但退化判据漏一个 purpose 就会把别人的调用扣住 ——
       * 所以这个值必须能直接从 status 读到，而不是只能翻宿主日志。
       */
      judge: typeof deps.isAgentLoopRequest === 'function' ? 'agent-loop' : 'purpose',
      /**
       * 正在运行的这一份代码的版本。
       *
       * 放进 status 而不是只在 HTTP 路由里补，是为了让 `/peak` 命令与界面读到的
       * 是同一个来源 —— 三处各写一遍迟早会不一致。
       */
      version: VERSION,
    };
  };

  return { listener, releaseNow, wake, subscribe, status, sessionEnabled, setSessionEnabled, now: () => clock().getTime(), manualBypassUntil, waiting };
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

/** 客户端半插件必须带上的自定义请求头。跨站表单设不了它，浏览器发它之前要先预检。 */
export const ROUTE_HEADER = 'x-dsh-offpeak';

/** 三条路由的公共前缀。 */
export const BASE_PATH = '/dsh-offpeak';

/**
 * 本机能打开、或本机局域网能打开的地址。
 *
 * 只认这些：回环、私有网段、链路本地、`.local` 域名。公网域名解析到本机是
 * DNS rebinding 的经典形态——那时「同源」是别人伪造出来的，所以不能放进来。
 */
const LOCAL_ADDRESS = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|[a-z0-9-]+\.local)(:\d+)?$/u;

/**
 * 写一条 JSON 响应。
 *
 * 响应对象可能已经因为客户端断开而不可写，这里全部兜住：抛出去的异常会被宿主
 * 当成 handler 崩了，而一条答不出去的请求本来就不值得再赔上一条日志。
 */
function sendJson(res, status, payload) {
  try {
    if (res?.writableEnded === true || res?.destroyed === true) return;
    let body = '';
    try {
      body = JSON.stringify(payload);
    } catch {
      body = '{"error":"internal"}'; // ui-copy-ignore
    }
    if (res?.headersSent === true) {
      res.end();
      return;
    }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch {
    try {
      if (res?.writableEnded !== true && res?.destroyed !== true) res.end();
    } catch {
      /* 连接已经没了，除了日志没有别的可说 */
    }
  }
}

/**
 * 这条请求能不能动这个插件。
 *
 * 三层，缺一不可：
 * 1. 自定义头 —— 跨站表单设不了它，浏览器发它之前必须先预检，而宿主从不同意预检。
 * 2. Host 必须是本机地址 —— 挡住 DNS rebinding：公网域名解析到本机时，浏览器
 *    认为那是同源，第 1 层的头就白设了。
 * 3. Origin 必须为空或与 Host 同源 —— 挡住老浏览器与不带预检的跨站请求。
 *    空 Origin 是允许的：本机非浏览器客户端（curl、测试）本来就不发它。
 */
function requestAllowed(req) {
  try {
    const header = req?.headers?.[ROUTE_HEADER];
    if (typeof header !== 'string' || header === '') return false;

    const host = typeof req?.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
    if (LOCAL_ADDRESS.test(host) === false) return false;

    const origin = typeof req?.headers?.origin === 'string' ? req.headers.origin.trim().toLowerCase() : '';
    // `null` 来自沙箱 iframe、file:// 与某些重定向，是「这台机器没打开过的文档」。
    if (origin === 'null') return false;
    if (origin !== '') {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        // 读不出地址的 Origin 无法判断，只能拒绝。
        return false;
      }
      if (originHost !== host) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 从查询串里取 sessionId；缺失、空串、读不出都算没有。 */
function readSessionId(req) {
  try {
    const url = new URL(String(req?.url ?? ''), 'http://dsh.invalid');
    const raw = url.searchParams.get('sessionId');
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * 从查询串里读开关目标值。
 * 只认明确的开 / 关两种写法；缺失或含糊一律返回 null（路由回 400），
 * 免得把「参数写错了」静默当成「关掉插件」。
 */
function readEnabled(req) {
  try {
    const url = new URL(String(req?.url ?? ''), 'http://dsh.invalid');
    const raw = url.searchParams.get('enabled');
    if (typeof raw !== 'string') return null;
    const value = raw.trim().toLowerCase();
    if (value === '1' || value === 'true' || value === 'on' || value === 'yes') return true;
    if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false;
    return null;
  } catch {
    return null;
  }
}

/** 请求方法是否与路由一致。缺 `method` 的调用按文档约定的方法处理。 */
function methodMatches(req, expected) {
  const method = String(req?.method ?? '').toUpperCase();
  return method === '' || method === expected;
}

/**
 * 把 gate 包成两条可单测的 handler。
 *
 * 单独导出而不是写在 `apply` 里，是为了不起真 HTTP 服务也能测：测试拿假 req/res
 * 直接调这两个函数，路由的校验与形状就都在覆盖范围内。
 */
export function createRoutes(gate) {
  const now = () => (typeof gate?.now === 'function' ? gate.now() : Date.now());

  /** `GET /dsh-offpeak/status` */
  const status = (req, res) => {
    try {
      if (requestAllowed(req) === false) return sendJson(res, 403, { error: 'forbidden' }); // ui-copy-ignore
      if (methodMatches(req, 'GET') === false) return sendJson(res, 405, { error: 'method' }); // ui-copy-ignore
      const sessionId = readSessionId(req);
      if (sessionId === null) return sendJson(res, 400, { error: 'sessionId' }); // ui-copy-ignore
      return sendJson(res, 200, { ...gate.status(sessionId), now: now() });
    } catch (error) {
      return sendJson(res, 500, { error: 'internal', detail: String(error?.message ?? error) }); // ui-copy-ignore
    }
  };

  /** `POST /dsh-offpeak/release` */
  const release = (req, res) => {
    try {
      if (requestAllowed(req) === false) return sendJson(res, 403, { error: 'forbidden' }); // ui-copy-ignore
      if (methodMatches(req, 'POST') === false) return sendJson(res, 405, { error: 'method' }); // ui-copy-ignore
      const sessionId = readSessionId(req);
      if (sessionId === null) return sendJson(res, 400, { error: 'sessionId' }); // ui-copy-ignore
      const woken = gate.releaseNow(sessionId);
      return sendJson(res, 200, { ok: true, woken });
    } catch (error) {
      return sendJson(res, 500, { error: 'internal', detail: String(error?.message ?? error) }); // ui-copy-ignore
    }
  };

  /**
   * `POST /dsh-offpeak/toggle?sessionId=<id>&enabled=0|1`
   *
   * 只改**本会话**的开关。返回切换后的完整 status，客户端直接拿去渲染，
   * 不必再补一次 GET。
   */
  const toggle = (req, res) => {
    try {
      if (requestAllowed(req) === false) return sendJson(res, 403, { error: 'forbidden' }); // ui-copy-ignore
      if (methodMatches(req, 'POST') === false) return sendJson(res, 405, { error: 'method' }); // ui-copy-ignore
      const sessionId = readSessionId(req);
      if (sessionId === null) return sendJson(res, 400, { error: 'sessionId' }); // ui-copy-ignore
      const enabled = readEnabled(req);
      if (enabled === null) return sendJson(res, 400, { error: 'enabled' }); // ui-copy-ignore
      return sendJson(res, 200, { ok: true, ...gate.setSessionEnabled(sessionId, enabled), now: now() });
    } catch (error) {
      return sendJson(res, 500, { error: 'internal', detail: String(error?.message ?? error) }); // ui-copy-ignore
    }
  };

  return { status, release, toggle };
}

export function apply(ctx, config) {
  const state = { config: normalizeConfig(config) };
  const getConfig = () => state.config;

  /**
   * 会话查询要在 `sessions` 服务可用之后才装得上。
   *
   * `ctx.sessions` 在没 inject 该服务时会**抛错**（不是返回 undefined）：
   * cordis 的 Proxy trap 对未注入的属性直接
   * `throw new Error('cannot get property "sessions" without inject')`。
   * 所以这里先留一个解析器，由下面的 `ctx.inject(['sessions'])` 补上；
   * 服务缺席时解析器保持返回 undefined，链解析按「没有上级」处理。
   */
  let resolveSession = () => undefined;
  const deps = {
    getSession: (id) => resolveSession(id),
    // 委派会话（子代理 / 队友）默认不参与任何自动动作：它们和用户的会话不是一回事，
    // 重启后替它们续跑只会凭空烧额度。
    isDelegatedSession,
    /**
     * 宿主的「这是 agent-loop 组装的请求吗」判据，下面异步补上。
     *
     * 必须是**运行时才去拿**，不能在文件顶层 `import`：
     * - 宿主里 `@deepseek-ai/dsh-llm` 由 profile 的解析拦截层定向解析得到，
     *   插件目录自己的 `node_modules` 里并没有这个包；
     * - 单测直接 `import '../lib/index.js'` 跑在裸 node 下，顶层 import 会直接
     *   `ERR_MODULE_NOT_FOUND`，把整个插件（连同闸门）一起拖垮。
     * 所以这里留成可变字段，拿不到就退回 `shouldGate` 里按 `purpose` 的退化判据。
     */
    isAgentLoopRequest: undefined,
    logger: ctx.logger,
  };

  /**
   * 异步取宿主的标记函数。
   *
   * 不 await：`apply` 变 async 会让整个插件在解析期间处于 pending，而闸门本身
   * 不依赖这个函数（退化判据已经能挡住三个已知的后台调用）。拿到就换上，
   * 失败只记一条 warn。任何异常都必须吞掉 —— 一个诊断用的判据不值得让插件装不上。
   */
  void (async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      const marker = mod?.isAgentLoopRequest;
      if (typeof marker === 'function') {
        deps.isAgentLoopRequest = marker;
        return;
      }
      deps.logger?.warn?.('offpeak: 宿主未导出 isAgentLoopRequest，改用 purpose 判据');
    } catch (error) {
      deps.logger?.warn?.(
        `offpeak: 取不到 isAgentLoopRequest，改用 purpose 判据：${error?.message ?? error}`,
      );
    }
  })();

  const gate = createGate(getConfig, deps);

  // 与 commands / webServer 同一套路：不写进顶层 inject，服务晚到也能补挂，
  // 且任一服务缺席都不会拖住闸门。
  ctx.inject(['sessions'], (scoped) => {
    resolveSession = (id) => scoped.sessions?.get?.(id);
  });

  ctx.on('llm/stream', gate.listener, { global: true });

  /**
   * 重启续跑：挂在 `agent/created` 上，只认 `source === 'resume'`。
   *
   * 必须带 `{ global: true }` —— `agent/created` 是 agent 作用域事件，从根上下文
   * 监听时 cordis 会按 `hook.global || !filter` 过滤，不带就把自己过滤掉了。
   *
   * 返回值**必须丢弃**：`agent/created` 走的是 cordis 的 `serial` 派发，而
   * `serial` 只要看到监听器返回非 null/false/undefined 就当成 bail、立刻停止
   * 后续监听器。`recoverPendingOnResume` 为了可测返回的是状态字符串，直接透出去
   * 会把别人挂在同一个事件上的初始化逻辑静默跳过。
   */
  ctx.on(
    'agent/created',
    (payload) => {
      // 两条支路并列，互不依赖：
      // ① 正在执行的那一轮：上一轮是被重启打断的，补一条续跑提示（0.1.4）。
      //    放在前面：它要 prepend 到 next-turn 队首，先插队再唤醒语义才直观。
      // ② 排队中的消息：把 inbox 里躺着的那批推起来（0.1.3）。
      // 两个返回值都必须丢弃 —— 见上面的注释。
      continueInterruptedTurn(payload, getConfig, deps);
      recoverPendingOnResume(payload, getConfig, deps);
    },
    { global: true },
  );

  // 命令是「有 commands 服务才挂」的附加项。用 ctx.inject 而不是顶层 inject：
  // 服务晚到也能补挂，且不会拖住闸门。回调拿到的 `scoped` 是注入了 commands 的子上下文。
  const registerCommand = (scoped = ctx) => {
    const commands = (() => {
      try {
        return scoped.commands;
      } catch {
        return undefined;
      }
    })();
    const register = commands?.register?.bind(commands);
    if (typeof register !== 'function') return;
    const disposer = register({
      name: 'peak',
      description: '看峰谷状态：/peak 显示当前是否高峰与下次放行时刻；/peak now 立即放行本会话的排队调用。',
      input: { hint: '[now]' },
      recordInput: false,
      handler: (invocation) => {
        const now = new Date();
        const cfg = getConfig();
        // 只读契约上写明的 `agent.id`（= SessionId）。
        //
        // 之前这里先用 `agent.session.id` 兜 `agent.id`：`session` 是 ReactLoopAgent 的
        // 运行时字段，公开类型面没有它 —— 本机当前实现有，但那是实现细节，框架一改
        // 就静默变成 undefined（不报错，只是命令拿不到会话、放行无效）。
        // 两者取的是同一个 id（`initializeAgent` 里 `const id = session.id` 后就 `new ReactLoopAgent(loopCtx, id, ...)`），
        // 所以直接读公开字段即可，行为不变。
        const sessionId = invocation?.agent?.id;
        const arg = String(invocation?.rawInput ?? '').trim().toLowerCase();

        if (arg === 'now') {
          if (typeof sessionId !== 'string' || sessionId === '') {
            return { kind: 'error', text: '拿不到当前会话 id，无法放行。' };
          }
          const woken = gate.releaseNow(sessionId);
          return {
            kind: 'success',
            text: woken > 0
              ? `已放行本会话 ${woken} 个排队调用（接下来 60 秒内的调用也不再等待）。`
              : '已设为「接下来 60 秒内不再等待」。当前没有正在排队的调用。',
          };
        }

        const peak = isPeak(now, { timeZone: cfg.timeZone, peakWindows: cfg.peakWindows ?? undefined });
        const releaseAt = releaseFor(now, cfg);
        const nextPeak = nextPeakAt(now, { timeZone: cfg.timeZone, peakWindows: cfg.peakWindows ?? undefined });
        const stamp = (date) => stampOf(date, cfg.timeZone, now);
        const lines = [
          `dsh-offpeak ${VERSION}`,
          peak ? '现在是高峰（原价）。' : '现在是低谷（半价）。',
          `本会话错峰开关：${typeof sessionId === 'string' && sessionId !== '' && gate.sessionEnabled(sessionId) === false ? '关' : '开'}（主会话关掉时子代理一起关）`,
          releaseAt === null
            ? '本次调用立即放行。'
            : `本次调用将在 ${stamp(releaseAt)} 之后放行（仅 DeepSeek 系列：走 deepseek / workbuddy 通道的 deepseek 模型；其它模型高峰时立即发出）。`,
          nextPeak === null ? '未来 8 天内没有高峰。' : `下一个高峰：${stamp(nextPeak)}。`,
          '节假日不参与判定：工作日遇法定假日仍按高峰处理。',
        ];
        if (cfg.dryRun) lines.push('dryRun 已开：只记日志，不实际拦截。');
        return { kind: 'success', text: lines.join('\n') };
      },
    });
    if (typeof disposer === 'function') ctx.effect(() => disposer, 'offpeak.commands.register()');
  };

  // 命令是「有 commands 服务才挂」的附加项。用 ctx.inject 而不是顶层 inject：
  // 服务晚到也能补挂，且不会拖住闸门。
  if (getConfig().manualReleaseCommand) {
    ctx.inject(['commands'], registerCommand);
  }

  /**
   * HTTP 路由：客户端半插件靠它读状态、点「立即运行」。
   *
   * 同样走 ctx.inject 而不是顶层 inject —— `webServer` 只在 web profile 里有，
   * 写进顶层 inject 会让 headless / sdk 下的整个插件永久 pending，闸门也就装不上了。
   * 服务缺席时这几条路由不注册，插件的其余部分照常工作。
   */
  const registerRoutes = (scoped = ctx) => {
    const server = (() => {
      try {
        return scoped.webServer;
      } catch {
        return undefined;
      }
    })();
    const register = server?.register?.bind(server);
    if (typeof register !== 'function') return;

    const routes = createRoutes(gate);
    const disposers = [];
    for (const [path, handler] of [
      [`${BASE_PATH}/status`, routes.status],
      [`${BASE_PATH}/release`, routes.release],
      [`${BASE_PATH}/toggle`, routes.toggle],
    ]) {
      try {
        const disposer = register({ kind: 'exact', path, handler });
        if (typeof disposer === 'function') disposers.push(disposer);
      } catch (error) {
        // 一条路由注册失败不该带走另一条，更不该带走闸门。
        deps.logger?.warn?.(`offpeak: 路由 ${path} 注册失败：${error?.message ?? error}`);
      }
    }
    if (disposers.length > 0) {
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 卸载期的清理失败没有补救余地，留着日志反而会掩盖真正的问题 */
          }
        }
      }, 'offpeak.webServer.routes');
    }
  };

  ctx.inject(['webServer'], registerRoutes);
}

export { MAX_TIMER_DELAY_MS };
