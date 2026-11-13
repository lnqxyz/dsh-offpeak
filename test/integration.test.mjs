// 端到端集成测试：用 asar 里真实的 cordis，把插件当成真插件挂上去，
// 验证「高峰时不发请求、低谷时立刻发、等待期点停止能取消」这三件事。
//
// 这是整个方案最关键的验证：如果插件在真实 cordis 里跑不通，
// 前面所有单测都只是在测纯函数。
import test from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '../node_modules/cordis.js';
import { zonedInstant, localParts } from '../lib/peak-window.js';
import * as plugin from '../lib/index.js';

/** 落在拦截范围内的一对（provider, model）：高峰时会被扣住（0.1.17，用户 2026-11-13 拍板）。 */
const HELD_PROVIDER = 'workbuddy';
const HELD_MODEL = 'deepseek-chat';

/**
 * 造一个「假宿主」：提供 commands 与 sessions 两个服务，
 * 并把 llm/stream 的派发走真实 cordis waterfall。
 *
 * 注意 `ctx.plugin()` 返回的 fiber 是异步装载的（apply 还没跑），
 * 必须 `await fiber` 才能保证监听器与命令都注册完了。
 */
async function makeHost({ sessions = new Map(), config = {} } = {}) {
  const ctx = new Context();

  const registered = [];
  ctx.provide('commands', {
    register(definition) {
      registered.push(definition);
      return () => {
        const index = registered.indexOf(definition);
        if (index >= 0) registered.splice(index, 1);
      };
    },
  });

  ctx.provide('sessions', { get: (id) => sessions.get(id) });

  const logs = [];
  ctx.provide('logger', {
    info: (message) => logs.push(String(message)),
    warn: (message) => logs.push(String(message)),
    error: (message) => logs.push(String(message)),
    debug: () => {},
  });

  const fiber = ctx.plugin(plugin, config);
  await fiber;

  return { ctx, fiber, registered, logs, sessions };
}

/** 走真实 cordis 的 llm/stream waterfall，返回收到的 chunk 列表。 */
async function streamViaHost(ctx, options, inner) {
  const stream = ctx.waterfall('llm/stream', options, inner);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function countedInner(counter) {
  return async function* inner() {
    counter.calls += 1;
    yield { type: 'chunk', n: counter.calls };
  };
}

/**
 * 构造一段「今天全天都是高峰」的窗口，让测试与运行时刻无关。
 *
 * `end` 必须写 `00:00` 而不是 `23:59`：`windowBounds` 把 `endMinutes <=
 * startMinutes` 当作跨午夜，`00:00 - 00:00` 于是正好是**整 24 小时**。
 * 写成 `23:59` 会漏掉每天最后那 60 秒 —— 那一刻跑测试就是必红的假红。
 */
function allDayWindows() {
  const parts = localParts(new Date(), 'Asia/Shanghai');
  const isoDay = parts.weekday === 0 ? 7 : parts.weekday;
  return [{ days: [isoDay], start: '00:00', end: '00:00' }];
}

test('低谷：真实 cordis 派发下直接放行，next() 立刻被调', async () => {
  // 空窗口表 = 永远低谷，避免依赖测试运行时刻。
  const { ctx } = await makeHost({ config: { peakWindows: [] } });
  const counter = { calls: 0 };
  const options = { sessionId: 's-root', signal: new AbortController().signal };
  const chunks = await streamViaHost(ctx, options, countedInner(counter));
  assert.deepEqual(chunks, [{ type: 'chunk', n: 1 }]);
  assert.equal(counter.calls, 1);
});

test('高峰 + 后台调用（带 purpose）：其它插件的调用照常发出去', async () => {
  // 标题生成 / 上下文压缩 / 自动审核都带 sessionId，也都在高峰里跑。拦它们
  // 只会让标题一直空着、压缩卡住 —— 用户要的是「不影响别家插件调用模型」。
  // 裸 node 下取不到宿主的 isAgentLoopRequest，这里走的是 purpose 退化判据。
  const { ctx } = await makeHost({
    config: { peakWindows: allDayWindows(), releaseJitterSeconds: [0, 0] },
  });
  for (const purpose of ['session-title', 'compaction', 'auto-review']) {
    const counter = { calls: 0 };
    const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, purpose, signal: new AbortController().signal };
    const chunks = await streamViaHost(ctx, options, countedInner(counter));
    assert.deepEqual(chunks, [{ type: 'chunk', n: 1 }], `${purpose} 不能被拦`);
    assert.equal(counter.calls, 1);
  }
});

test('高峰 + 非 deepseek 模型：真实 cordis 派发下立即放行', async () => {
  // 0.1.17（用户 2026-11-13 拍板）：峰谷折扣是 DeepSeek 官方 API 的价格规则，
  // 别的 provider 在高峰账单不变，扣住它们只是白等。这条走真实 waterfall，
  // 是为了确认 model 就是从派发参数那一个对象上读的（宿主把 `model` 声明为
  // GenerateOptions 的必填字段，见 dsh-llm/src/types.ts:564-567）。
  const { ctx } = await makeHost({
    config: { peakWindows: allDayWindows(), releaseJitterSeconds: [0, 0] },
  });
  for (const model of ['qwen3.8-max-preview', 'glm-4.6', 'kimi-k2-instruct']) {
    const counter = { calls: 0 };
    const options = { provider: 'some-provider', model, sessionId: 's-root', signal: new AbortController().signal };
    const chunks = await streamViaHost(ctx, options, countedInner(counter));
    assert.deepEqual(chunks, [{ type: 'chunk', n: 1 }], `${model} 高峰时必须立即放行`);
    assert.equal(counter.calls, 1);
  }
});

test('高峰 + model 缺失：真实派发下 fail-open 放行', async () => {
  const { ctx } = await makeHost({
    config: { peakWindows: allDayWindows(), releaseJitterSeconds: [0, 0] },
  });
  const counter = { calls: 0 };
  const options = { provider: 'some-provider', sessionId: 's-root', signal: new AbortController().signal };
  const chunks = await streamViaHost(ctx, options, countedInner(counter));
  assert.deepEqual(chunks, [{ type: 'chunk', n: 1 }]);
  assert.equal(counter.calls, 1, '判据自己出问题时宁可放行，不要把调用扣在高峰里');
});

test('高峰 + deepseek 模型但通道不对（qwenwork）：真实派发下立即放行', async () => {
  // 双条件的核心证据：模型名与扣住那条一模一样，只把 provider 换成没有峰谷折扣的
  // qwenwork，就必须立刻发出去。这条走真实 waterfall，确认 provider 确实是从派发
  // 参数那个对象上读的（GenerateOptions 的必填字段，与 model 并列）。
  const { ctx } = await makeHost({
    config: { peakWindows: allDayWindows(), releaseJitterSeconds: [0, 0] },
  });
  const counter = { calls: 0 };
  const options = {
    provider: 'qwenwork',
    model: 'deepseek-chat',
    sessionId: 's-root',
    signal: new AbortController().signal,
  };
  const chunks = await streamViaHost(ctx, options, countedInner(counter));
  assert.deepEqual(chunks, [{ type: 'chunk', n: 1 }], '模型是 deepseek 但通道没折扣，必须立即放行');
  assert.equal(counter.calls, 1);
});

test('高峰 + deepseek 模型：真实派发下仍然扣得住', async () => {
  // 与上一条互为对照：双条件都成立的那个组合行为必须一字不变。
  const { ctx } = await makeHost({
    config: { peakWindows: allDayWindows(), releaseJitterSeconds: [0, 0] },
  });
  const counter = { calls: 0 };
  const controller = new AbortController();
  const options = { provider: HELD_PROVIDER, model: HELD_MODEL, sessionId: 's-root', signal: controller.signal };
  const stream = ctx.waterfall('llm/stream', options, countedInner(counter));
  assert.equal(counter.calls, 0, '放行前不得调用下游');

  const reason = Object.assign(new Error('stop'), { name: 'AbortError' });
  setTimeout(() => controller.abort(reason), 20);
  await assert.rejects(async () => {
    for await (const _ of stream) { /* 不会到这里 */ }
  }, (error) => error === reason);
  assert.equal(counter.calls, 0);
});

test('高峰：请求被扣住，直到 abort 都没有调用下游', async () => {
  const { ctx } = await makeHost({
    config: { peakWindows: allDayWindows(), releaseJitterSeconds: [0, 0] },
  });
  const counter = { calls: 0 };
  const controller = new AbortController();
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: controller.signal };

  const stream = ctx.waterfall('llm/stream', options, countedInner(counter));
  assert.equal(typeof stream[Symbol.asyncIterator], 'function');
  assert.equal(typeof stream.then, 'undefined', 'waterfall 必须同步拿到 AsyncIterable');
  assert.equal(counter.calls, 0, '放行前不得调用下游');

  const reason = Object.assign(new Error('stop'), { name: 'AbortError' });
  setTimeout(() => controller.abort(reason), 20);
  await assert.rejects(async () => {
    for await (const _ of stream) { /* 不会到这里 */ }
  }, (error) => error === reason);
  assert.equal(counter.calls, 0, 'abort 后仍不得调用下游');
});

test('高峰等待期用 /peak now 放行后，请求真的发出去', async () => {
  const { ctx, registered } = await makeHost({
    config: { peakWindows: allDayWindows(), releaseJitterSeconds: [0, 0] },
  });
  const command = registered.find((definition) => definition.name === 'peak');
  assert.ok(command, '应注册 /peak 命令');

  const counter = { calls: 0 };
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  const stream = ctx.waterfall('llm/stream', options, countedInner(counter));

  const collected = (async () => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  })();
  assert.equal(counter.calls, 0);

  const result = command.handler({ rawInput: 'now', agent: { id: 's-root' } });
  assert.equal(result.kind, 'success');

  assert.deepEqual(await collected, [{ type: 'chunk', n: 1 }]);
  assert.equal(counter.calls, 1);
});

test('/peak 报告当前状态，不抛异常', async () => {
  const { registered } = await makeHost({ config: {} });
  const command = registered.find((definition) => definition.name === 'peak');
  assert.ok(command);
  const result = command.handler({ rawInput: '', agent: { id: 's-root' } });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /高峰|低谷/);
});

// 0.1.20：用户 2026-11-13 拍板「界面不显示版本号」，这条口径一并管到 /peak 输出。
// 版本只剩 `GET /dsh-offpeak/status` 与 `status()` 两条路能查，所以这里钉死：
// 命令的正文里不许再出现 `VERSION` 那个值。
test('/peak 不再报版本号（用户 2026-11-13 拍板）', async () => {
  const { registered } = await makeHost({ config: {} });
  const command = registered.find((definition) => definition.name === 'peak');
  const result = command.handler({ rawInput: '', agent: { id: 's-root' } });
  assert.equal(result.kind, 'success');
  assert.doesNotMatch(result.text, new RegExp(plugin.VERSION.replace(/\./g, '\\.')), '首行版本号已删除，正文里不该再出现');
  // 第一行现在是峰谷状态。这里不断言具体是高峰还是低谷 —— makeHost 用的是真实时钟，
  // 断言具体值会让这条用例在一天的某些时段变红。
  assert.match(result.text.split('\n')[0], /^(现在是高峰（原价）。|现在是低谷（半价）。)$/, '第一行应为峰谷状态，不再是版本号');
});

test('/peak now 拿不到会话 id 时返回错误而不是抛异常', async () => {
  const { registered } = await makeHost({ config: {} });
  const command = registered.find((definition) => definition.name === 'peak');
  const result = command.handler({ rawInput: 'now', agent: undefined });
  assert.equal(result.kind, 'error');
});

test('enabled=false 时真实派发完全透传', async () => {
  const { ctx } = await makeHost({ config: { enabled: false } });
  const counter = { calls: 0 };
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  const chunks = await streamViaHost(ctx, options, countedInner(counter));
  assert.equal(chunks.length, 1);
  assert.equal(counter.calls, 1);
});

test('没有 sessionId 的旁路调用不被拦', async () => {
  const { ctx } = await makeHost({ config: {} });
  const counter = { calls: 0 };
  const options = { signal: new AbortController().signal };
  const chunks = await streamViaHost(ctx, options, countedInner(counter));
  assert.equal(chunks.length, 1);
  assert.equal(counter.calls, 1);
});

test('子代理会话在低谷继承主会话的「开」，直接放行', async () => {
  const sessions = new Map([['s-sub', { header: { origin: 'subagent', parentSession: 's-root' } }]]);
  const { ctx } = await makeHost({ config: { peakWindows: [] }, sessions });
  const counter = { calls: 0 };
  const options = { sessionId: 's-sub', signal: new AbortController().signal };
  const chunks = await streamViaHost(ctx, options, countedInner(counter));
  assert.equal(chunks.length, 1);
  assert.equal(counter.calls, 1);
});

test('插件卸载后监听器一并移除', async () => {
  const { ctx, fiber } = await makeHost({ config: { peakWindows: [] } });
  const counter = { calls: 0 };
  const options = { sessionId: 's-root', signal: new AbortController().signal };
  await streamViaHost(ctx, options, countedInner(counter));
  assert.equal(counter.calls, 1);

  await fiber.dispose();
  // 卸载后 waterfall 退化为直通：只有 inner 本身。
  const chunks = await streamViaHost(ctx, options, countedInner(counter));
  assert.equal(chunks.length, 1);
  assert.equal(counter.calls, 2);
});

test('没有 commands 服务时，闸门照样生效（命令只是不注册）', async () => {
  // 这是 inject 留空的核心理由：服务缺席不能拖住闸门。
  const ctx = new Context();
  ctx.provide('sessions', { get: () => undefined });
  const fiber = ctx.plugin(plugin, { peakWindows: [] });
  await fiber;

  const counter = { calls: 0 };
  const options = { sessionId: 's-root', signal: new AbortController().signal };
  const chunks = [];
  for await (const chunk of ctx.waterfall('llm/stream', options, countedInner(counter))) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.equal(counter.calls, 1, '闸门必须已经挂上并放行');
  await fiber.dispose();
});

test('没有 sessions 服务时，高峰依然扣得住', async () => {
  const ctx = new Context();
  ctx.provide('commands', { register: () => () => {} });
  const fiber = ctx.plugin(plugin, { peakWindows: allDayWindows(), releaseJitterSeconds: [0, 0] });
  await fiber;

  const counter = { calls: 0 };
  const controller = new AbortController();
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: controller.signal };
  const stream = ctx.waterfall('llm/stream', options, countedInner(counter));
  assert.equal(counter.calls, 0);

  const reason = Object.assign(new Error('stop'), { name: 'AbortError' });
  setTimeout(() => controller.abort(reason), 20);
  await assert.rejects(async () => { for await (const _ of stream) { /* 不会到这里 */ } }, (e) => e === reason);
  assert.equal(counter.calls, 0);
  await fiber.dispose();
});

test('装进真 cordis 后：agent/created（resume）经真实 serial 派发触发续跑', async () => {
  const { ctx, fiber } = await makeHost({ config: { peakWindows: [] } });

  let woken = 0;
  const agent = {
    inbox: {
      nextTurn: [{ id: 'queued-1' }],
      nextStep: [],
      get hasPending() {
        return true;
      },
    },
    wakeDriver() {
      woken += 1;
    },
  };

  // agent/created 在宿主里走 `ctx.serial(...)`（`agents.announce()` → `dispatch.serial`）。
  // 用真实 serial 派发才能验证「监听器带了 global: true、从根上下文也收得到」。
  //
  // 同时挂一个排在后面的监听器：`serial` 一旦看到前一个监听器返回非
  // null/false/undefined 就当成 bail、跳过后面所有人。重启续跑绝不能把别人
  // 挂在这个事件上的初始化逻辑吞掉 —— 这条断言就是防那个。
  let downstream = 0;
  ctx.on('agent/created', () => {
    downstream += 1;
  }, { global: true });

  await ctx.serial('agent/created', { agent, source: 'resume' });
  assert.equal(woken, 1, '重启后应当被推一把');
  assert.equal(downstream, 1, '续跑监听器不能 bail 掉后面的监听器');

  await ctx.serial('agent/created', { agent, source: 'startup' });
  assert.equal(woken, 1, '新建会话不该被续跑逻辑碰');

  await fiber.dispose();
});

test('续跑监听器被关掉后不再动作（resumePending:false）', async () => {
  const { ctx, fiber } = await makeHost({ config: { peakWindows: [], resumePending: false } });
  let woken = 0;
  const agent = {
    inbox: {
      nextTurn: [{ id: 'q' }],
      nextStep: [],
      hasPending: true,
    },
    wakeDriver() {
      woken += 1;
    },
  };
  await ctx.serial('agent/created', { agent, source: 'resume' });
  assert.equal(woken, 0);
  await fiber.dispose();
});

test('装进真 cordis 后：在途回合被打断 → 注入续跑提示（且不 bail 别人）', async () => {
  const { ctx, fiber, logs } = await makeHost({ config: { peakWindows: [] } });

  // 上一轮跑到一半被进程退出打断：尾部 turn/end 是 aborted/disposed。
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 3 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 3, step: 1 } },
    { type: 'step/end', seq: 2, time: 3, data: { turn: 3, step: 1 } },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
  ];

  const delivered = [];
  const agent = {
    session: { id: 's-resume', header: {}, snapshotEvents: () => events },
    inbox: { nextTurn: [], nextStep: [] },
    wakeDriver() {},
    followup(message) {
      delivered.push(message);
      this.inbox.nextTurn.push(message);
    },
  };

  let downstream = 0;
  ctx.on('agent/created', () => {
    downstream += 1;
  }, { global: true });

  await ctx.serial('agent/created', { agent, source: 'resume' });
  assert.equal(delivered.length, 1, '打断态应当补一条续跑提示');
  assert.equal(delivered[0].role, 'user');
  assert.equal(delivered[0].source.kind, 'plugin:dsh-offpeak');
  assert.equal(downstream, 1, '续跑监听器不能 bail 掉后面的监听器');
  // 不断言 `logs`：cordis 自带 logger 服务，`ctx.provide('logger', ...)` 覆盖不了它
  // （实测 `ctx.logger` 仍是框架那个 callable），日志文案由 resume-turn 单测覆盖。

  // 再 resume 一次：提示还在 inbox 里，不该重复注入。
  await ctx.serial('agent/created', { agent, source: 'resume' });
  assert.equal(delivered.length, 1, '同一轮不重复提醒');

  await fiber.dispose();
});

test('装进真 cordis 后：在途续跑被关掉时不动手（resumeInterruptedTurn:false）', async () => {
  const { ctx, fiber } = await makeHost({ config: { peakWindows: [], resumeInterruptedTurn: false } });
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
  ];
  let delivered = 0;
  const agent = {
    session: { id: 's1', header: {}, snapshotEvents: () => events },
    inbox: { nextTurn: [], nextStep: [] },
    followup() {
      delivered += 1;
    },
  };
  await ctx.serial('agent/created', { agent, source: 'resume' });
  assert.equal(delivered, 0);
  await fiber.dispose();
});

test('装进真 cordis 后：子代理会话被打断也不替它续跑', async () => {
  const { ctx, fiber } = await makeHost({ config: { peakWindows: [] } });
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
  ];
  let delivered = 0;
  const agent = {
    session: { id: 'sub-1', header: { origin: 'subagent' }, snapshotEvents: () => events },
    inbox: { nextTurn: [], nextStep: [] },
    followup() {
      delivered += 1;
    },
  };
  await ctx.serial('agent/created', { agent, source: 'resume' });
  assert.equal(delivered, 0, '委派会话不该被替它烧额度');
  await fiber.dispose();
});
