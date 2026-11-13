/**
 * dsh-offpeak —— 重启后的「在途回合」续跑。
 *
 * 0.1.3 只处理了 inbox 里**排队**的消息（重启后没人 `wakeDriver()`，队列躺着不动）。
 * 这一支补的是另一半：重启时**正在执行**的那一轮。
 *
 * ## 判据从哪来
 *
 * 不需要自己记状态，宿主已经把「这一轮是怎么结束的」写进会话日志了。`turn/end`
 * 的 `data.reason` 是一个闭集，其中两种只可能由「被系统打断」产生：
 *
 * - `{ kind: 'aborted', reason: { kind: 'disposed' } }` —— 进程退出 / 生命周期销毁时
 *   `machine.cancel({ kind: 'disposed' }, { keepInbox: !ready })` 打断了在途 turn。
 *   实测本机 566 份会话里 26 例。
 * - `{ kind: 'interrupted' }` —— 进程被硬杀在 `turn/end` 落盘之前，下次 resume 时
 *   `interruptedTurnClosers()` 合成的收尾事件。实测 1 例。
 *
 * 其余取值一律**不续跑**：`completed`（正常结束）、`aborted` 且 `user`（用户自己点的
 * 停止）、`aborted` 且 `parent`（父代理取消）、`error`（上游报错，盲目重试只会再撞
 * 一次同样的错）、`blocked`、`max-tokens`、`forked`。
 *
 * ## 为什么读日志要小心
 *
 * `session.snapshotEvents()` 与 `eventAt()` 在框架里标了 `@deprecated`（"new calls are
 * prohibited"，给仓库内代码的架构约束）。但插件侧没有别的同步读法：`session/event`
 * 是 every-append 广播，**收不到 seed 里的历史事件**（append 发生在 `announce()` 之前），
 * 冷读 `sessionPersistence.open(id, 'read')` 虽然不抢写锁，却要全量读盘且拿不到尾部。
 *
 * 所以这里用 `snapshotEvents()`，并且：
 * - 只在 `agent/created`（source=resume）时调一次，不在热路径上；
 * - 整个调用兜在 try/catch 里，任何版本变化导致取不到 → 静默放弃续跑，绝不抛错；
 * - 未来若它被真正移除，退化为「不续跑」，不会让会话打不开。
 *
 * ## 幂等
 *
 * 同一个被打断的 turn 只提醒一次：
 * - 提醒消息本身带 `source.kind = plugin:dsh-offpeak`，只要它还在 inbox 里就不再注入；
 * - 提醒被消费后会产生新的 turn，其 `turn/end` 不再是打断态，判据自然失效。
 */

import { randomUUID } from 'node:crypto';

/** 自动续跑消息的 `source.kind`。带 `plugin:` 前缀，与官方词汇表区分得开。 */
export const NUDGE_SOURCE_KIND = 'plugin:dsh-offpeak';

/** 注入给模型的续跑提示。不重放原始 prompt —— 原始 prompt 已在历史里。 */
export const CONTINUATION_TEXT = [
  '（自动续跑）上一轮回复在宿主重启时被打断，还没有做完。请接着断点继续，不要从头重做已经完成的步骤。',
  '如果上下文里有「结果未知」的工具调用记录（工具已开始但没留下结果），先核实外部真实状态再决定是否重试；不要盲目重跑有副作用的操作。',
].join('\n');

/**
 * 这个 `turn/end` 的原因算不算「被系统打断」。
 * @param {unknown} reason - `turn/end` 的 `data.reason`。
 * @returns {boolean}
 */
export function isInterruptedTurnReason(reason) {
  if (reason === null || typeof reason !== 'object') return false;
  if (reason.kind === 'interrupted') return true;
  if (reason.kind === 'aborted' && reason.reason !== null && typeof reason.reason === 'object') {
    return reason.reason.kind === 'disposed';
  }
  return false;
}

/**
 * 看会话日志尾部最后一个 turn 是怎么结束的。
 *
 * @param {readonly {type?: string, seq?: number, data?: object}[]} events
 * @returns {{kind: 'empty'|'no-turn'|'running'|'idle', reason: object|null, seq: number|null, turn: number|null}}
 */
export function inspectTail(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { kind: 'empty', reason: null, seq: null, turn: null };
  }
  let endIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') {
      endIndex = index;
      break;
    }
  }
  if (endIndex < 0) return { kind: 'no-turn', reason: null, seq: null, turn: null };

  const event = events[endIndex];
  const seq = typeof event.seq === 'number' ? event.seq : null;
  const turn = typeof event.data?.turn === 'number' ? event.data.turn : null;

  // 末尾还有 turn/start 说明现在有一轮正在跑（正常不会在 agent/created 时出现）。
  for (let index = endIndex + 1; index < events.length; index += 1) {
    if (events[index]?.type === 'turn/start') return { kind: 'running', reason: null, seq, turn };
  }

  return { kind: 'idle', reason: event.data?.reason ?? null, seq, turn };
}

/**
 * inbox 里是否已经有我们自己注入的续跑提醒。
 * @param {object|undefined} inbox
 * @returns {boolean}
 */
export function hasPendingNudge(inbox) {
  if (inbox === null || typeof inbox !== 'object') return false;
  const buckets = [inbox.nextTurn, inbox.nextStep];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const message of bucket) {
      if (message?.source?.kind === NUDGE_SOURCE_KIND) return true;
    }
  }
  return false;
}

/**
 * 要不要续跑这一轮。纯函数，便于单测。
 *
 * @param {{events?: unknown[], inbox?: object, config?: object, delegated?: boolean}} input
 * @returns {string} 判定结果，同时用作日志与断言。
 */
export function planTurnContinuation(input = {}) {
  const { events, inbox, config, delegated } = input;
  const cfg = config ?? {};
  if (cfg.resumeInterruptedTurn === false) return 'disabled';
  if (delegated === true) return 'skipped:delegated';
  if (hasPendingNudge(inbox)) return 'skipped:already';

  const tail = inspectTail(events);
  if (tail.kind === 'empty') return 'skipped:empty';
  if (tail.kind === 'no-turn') return 'skipped:no-turn';
  if (tail.kind === 'running') return 'skipped:running';
  if (!isInterruptedTurnReason(tail.reason)) return 'skipped:clean';
  return 'continue';
}

/**
 * 造一条能直接投递的 user 消息。
 *
 * 形状要求来自 `assertMessageEventShape`：`user/message` 只查四件事 —— `id` 是非空字符串、
 * `role === 'user'`、`source.kind` 是非空字符串、`content` 是数组。**没有 kind 白名单**。
 *
 * @param {object} [options]
 * @returns {{id: string, role: 'user', content: object[], source: {kind: string}}}
 */
export function buildContinuationMessage(options = {}) {
  const text = typeof options.text === 'string' && options.text !== '' ? options.text : CONTINUATION_TEXT;
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NUDGE_SOURCE_KIND },
  };
}

/**
 * 把续跑提示投进这个 agent 的队列并叫醒驱动器。
 *
 * 优先 `inbox.prepend('next-turn', message)` + `wakeDriver()`，而不是 `followup()`：
 *
 * - **顺序**：被打断的那一轮是「正在跑」的那一轮，任何排队消息都是在它之后提交的。
 *   续跑提示必须插到队首，否则重启后会先把后来提交的消息跑完、再回头接着做上一轮，
 *   中间穿插着两段不相关的上下文。`followup()` 只能追加到队尾。
 * - **唤醒**：此刻 phase 是 `maintenance`（`agent/created` 在 `runMaintenance` 内部派发），
 *   `wakeDriver()` 只记 `wakeRequested` 不重入，等 `runMaintenance` 的 finally 看到
 *   `wakeRequested && inbox.hasPending` 才真正开循环。所以先 prepend 再 wake 是对的。
 * - **退路**：`inbox` 或 `wakeDriver` 缺任何一样都退回 `followup()`（它自带唤醒）。
 *
 * @returns {'prepended'|'followed'}
 */
function deliver(agent, message) {
  const inbox = (() => {
    try {
      return agent.inbox;
    } catch {
      return undefined;
    }
  })();
  const prepend = inbox?.prepend?.bind(inbox);
  const wake = typeof agent.wakeDriver === 'function' ? agent.wakeDriver.bind(agent) : undefined;

  if (typeof prepend === 'function' && typeof wake === 'function') {
    prepend('next-turn', message);
    wake();
    return 'prepended';
  }

  agent.followup(message);
  return 'followed';
}

/**
 * `agent/created`（source=resume）时，若上一轮被打断就补一条续跑提示。
 *
 * **必须同步且不抛错**：`agent/created` 走 cordis 的 `serial` 派发，监听器抛错会沿
 * `announce()` 上冒，把整次 resume 搞失败。整个函数体兜在 try/catch 里。
 *
 * @param {{agent?: object, source?: string}} payload
 * @param {() => object} getConfig
 * @param {{logger?: object, isDelegatedSession?: (session: object) => boolean}} deps
 * @returns {string}
 */
export function continueInterruptedTurn(payload, getConfig, deps = {}) {
  try {
    const raw = typeof getConfig === 'function' ? getConfig() : getConfig;
    const config = raw ?? {};
    if (config.resumeInterruptedTurn === false) return 'disabled';

    const { agent, source } = payload ?? {};
    if (source !== 'resume') return 'skipped:source';
    if (agent === null || agent === undefined) return 'skipped:no-agent';
    if (typeof agent.followup !== 'function') return 'skipped:no-transport';

    // `agent.session` 不在 `Agent` 的公开类型面上（那是 `ReactLoopAgent` 的运行时字段），
    // 版本一变就可能没有。拿不到就当「读不到历史」，放弃续跑。
    let session;
    try {
      session = agent.session;
    } catch {
      return 'skipped:no-session';
    }
    if (session === null || session === undefined) return 'skipped:no-session';
    if (typeof session.snapshotEvents !== 'function') return 'skipped:no-session';

    let events;
    try {
      events = session.snapshotEvents();
    } catch (error) {
      deps.logger?.warn?.(`offpeak: 读不到会话历史，跳过启动续跑：${error?.message ?? error}`);
      return 'skipped:no-session';
    }

    // `agent.inbox` 同样是运行时字段；缺了不影响判定，只是少一层幂等保护。
    let inbox;
    try {
      inbox = agent.inbox;
    } catch {
      inbox = undefined;
    }

    const isDelegated = typeof deps.isDelegatedSession === 'function' && session !== undefined
      ? deps.isDelegatedSession(session) === true
      : false;

    const verdict = planTurnContinuation({ events, inbox, config, delegated: isDelegated });
    if (verdict !== 'continue') return verdict;

    const tail = inspectTail(events);
    const message = buildContinuationMessage();
    const via = deliver(agent, message);
    deps.logger?.info?.(
      `offpeak: 重启前第 ${tail.turn ?? '?'} 轮被打断（${describeReason(tail.reason)}），已排入续跑提示（${via}）`,
    );
    return 'continued';
  } catch (error) {
    deps.logger?.warn?.(`offpeak: 启动续跑失败（已忽略）：${error?.message ?? error}`);
    return 'error';
  }
}

/** 给日志用的一句话原因描述。 */
export function describeReason(reason) {
  if (reason === null || typeof reason !== 'object') return 'unknown';
  if (reason.kind === 'aborted' && reason.reason !== null && typeof reason.reason === 'object') {
    return `aborted/${reason.reason.kind}`;
  }
  if (reason.kind === 'error') return `error/${reason.error?.code ?? 'UNKNOWN'}`;
  return String(reason.kind);
}
