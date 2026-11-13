import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Config,
  DEFAULTS,
  createGate,
  isDelegatedSession,
  normalizeConfig,
  releaseFor,
  shouldGate,
  waitForRelease,
} from '../lib/index.js';
import { zonedInstant } from '../lib/peak-window.js';

/** 落在拦截范围内的一对（provider, model）：高峰时会被扣住（0.1.17，用户 2026-11-13 拍板）。 */
const HELD_PROVIDER = 'workbuddy';
const HELD_MODEL = 'deepseek-chat';

function sh(year, month, day, hour, minute = 0) {
  return zonedInstant(year, month, day, hour, minute, 'Asia/Shanghai');
}

/** 2026-11-11 周三 10:00，处在上午高峰内。 */
const PEAK_NOW = sh(2026, 11, 11, 10, 0);
/** 同一周的 20:00，低谷。 */
const OFF_NOW = sh(2026, 11, 11, 20, 0);

function makeSession(header) {
  return { header };
}

const plainSession = makeSession({ version: 4, id: 's-root', createdAt: 0, isSeeded: false });

test('normalizeConfig 补默认值并拒绝坏值', () => {
  const cfg = normalizeConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.timeZone, 'Asia/Shanghai');
  assert.deepEqual(cfg.jitter, DEFAULTS.releaseJitterSeconds);
  assert.equal(cfg.dryRun, false);

  const bad = normalizeConfig({ releaseJitterSeconds: [1], timeZone: '' });
  assert.deepEqual(bad.jitter, DEFAULTS.releaseJitterSeconds);
  assert.equal(bad.timeZone, 'Asia/Shanghai');

  const off = normalizeConfig({ enabled: false });
  assert.equal(off.enabled, false);

  const on = normalizeConfig({ dryRun: true });
  assert.equal(on.dryRun, true);
});

test('isDelegatedSession 认三种被委派标记', () => {
  assert.equal(isDelegatedSession(plainSession), false);
  assert.equal(isDelegatedSession(makeSession({ origin: 'subagent' })), true);
  assert.equal(isDelegatedSession(makeSession({ parentSession: 'parent-id' })), true);
  assert.equal(isDelegatedSession(makeSession({ delegationDepth: 1 })), true);
  assert.equal(isDelegatedSession(makeSession({ delegationDepth: 0 })), false);
  assert.equal(isDelegatedSession(undefined), false);
  assert.equal(isDelegatedSession({}), false);
});

test('shouldGate 放行没有 sessionId 的旁路调用', () => {
  const config = normalizeConfig({});
  assert.equal(shouldGate({}, config, {}), false);
  assert.equal(shouldGate({ sessionId: '' }, config, {}), false);
  assert.equal(shouldGate(undefined, config, {}), false);
});

test('shouldGate 用 isAgentLoopRequest 排除非 loop 请求', () => {
  const config = normalizeConfig({});
  const options = { sessionId: 's-root' };
  assert.equal(shouldGate(options, config, { isAgentLoopRequest: () => false }), false);
  assert.equal(shouldGate(options, config, { isAgentLoopRequest: () => true }), true);
});

test('拿不到 isAgentLoopRequest 时按 purpose 退化：带 purpose 的后台调用一律放行', () => {
  // 宿主的标记函数要异步才取得到；单测裸跑时永远拿不到。此时退回
  // 「有没有 purpose」：会话标题 / 上下文压缩 / 自动审核都显式带 purpose，
  // 而 agent-loop 组装的真对话请求不带。三个已知后台调用靠这条不被拦。
  const config = normalizeConfig({});
  assert.equal(shouldGate({ sessionId: 's-root' }, config, {}), true, '无 purpose = 真对话');
  for (const purpose of ['session-title', 'compaction', 'auto-review']) {
    assert.equal(shouldGate({ sessionId: 's-root', purpose }, config, {}), false, purpose);
  }
  assert.equal(shouldGate({ sessionId: 's-root', purpose: '' }, config, {}), true, '空 purpose 当没有');
});

test('shouldGate 尊重 enabled 总开关', () => {
  const config = normalizeConfig({ enabled: false });
  assert.equal(shouldGate({ sessionId: 's-root' }, config, {}), false);
});

test('shouldGate 不再按「被委派」身份豁免，开关交给会话链', () => {
  const config = normalizeConfig({});
  const sub = makeSession({ origin: 'subagent', parentSession: 's-root' });
  assert.equal(shouldGate({ sessionId: 's-sub' }, config, { getSession: () => sub }), true);
});

test('releaseFor 在低谷返回 null（立即放行）', () => {
  const config = normalizeConfig({ releaseJitterSeconds: [0, 0] });
  assert.equal(releaseFor(OFF_NOW, config), null);
});

test('releaseFor 在高峰返回 12:00 之后', () => {
  const config = normalizeConfig({ releaseJitterSeconds: [0, 0] });
  const releaseAt = releaseFor(PEAK_NOW, config);
  assert.ok(releaseAt !== null);
  assert.equal(releaseAt.getTime(), sh(2026, 11, 11, 12, 0).getTime());
});

test('waitForRelease 到点返回 due', async () => {
  const result = await waitForRelease(new Date(Date.now() + 40), undefined);
  assert.equal(result, 'due');
});

test('waitForRelease 被 abort 时以 reason reject', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop'), { name: 'AbortError' });
  const pending = waitForRelease(new Date(Date.now() + 60_000), controller.signal);
  setTimeout(() => controller.abort(reason), 20);
  await assert.rejects(pending, (error) => error === reason);
});

test('waitForRelease 遇到已 abort 的 signal 立刻 reject', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already'));
  await assert.rejects(waitForRelease(new Date(Date.now() + 60_000), controller.signal));
});

test('waitForRelease 可被手动放行提前结束', async () => {
  let notify;
  const pending = waitForRelease(new Date(Date.now() + 60_000), undefined, {
    onManualRelease: (fn) => {
      notify = fn;
      return () => {};
    },
  });
  setTimeout(() => notify(), 20);
  assert.equal(await pending, 'manual');
});

test('waitForRelease 分片等待不会超过 setTimeout 上限', async () => {
  const delays = [];
  // 假时钟必须跟着假 timer 一起前进，否则 remaining 永远 > 0，step() 无限递归。
  let clock = Date.now();
  const fakeTimers = {
    setTimeout: (fn, delay) => {
      delays.push(delay);
      clock += delay;
      queueMicrotask(fn);
      return 1;
    },
    clearTimeout: () => {},
  };
  // 30 天后才放行，超过 2^31-1 ms（约 24.8 天）
  const far = new Date(clock + 30 * 86_400_000);
  const result = await waitForRelease(far, undefined, {
    timers: fakeTimers,
    now: () => clock,
  });
  assert.equal(result, 'due');
  assert.ok(delays.length >= 2, '应分片，实际只等了一次');
  for (const delay of delays) assert.ok(delay <= 2_147_483_647);
});

// ---------------------------------------------------------------------------
// 监听器行为（用假 next，不碰真实框架）
// ---------------------------------------------------------------------------

function makeGate(configOverrides = {}, depsOverrides = {}) {
  const config = normalizeConfig(configOverrides);
  const calls = [];
  const gate = createGate(
    () => config,
    {
      getSession: () => plainSession,
      isAgentLoopRequest: () => true,
      logger: { info: (message) => calls.push(message) },
      ...depsOverrides,
    },
  );
  return { gate, config, calls };
}

/** 会话表：id -> 带 header 的活动会话，用来构造父子链。 */
function makeSessions(entries) {
  return new Map(entries.map(([id, header]) => [id, makeSession(header)]));
}

const ROOT_HEADER = { version: 4, id: 's-root' };
const SUB_HEADER = { version: 4, id: 's-sub', origin: 'subagent', delegationDepth: 1, parentSession: 's-root' };
const GRAND_HEADER = { version: 4, id: 's-grand', origin: 'subagent', delegationDepth: 2, parentSession: 's-sub' };

test('主会话关掉开关后，会话链上的子代理一起关', () => {
  const sessions = makeSessions([
    ['s-root', ROOT_HEADER],
    ['s-sub', SUB_HEADER],
    ['s-grand', GRAND_HEADER],
    ['s-other', { version: 4, id: 's-other' }],
  ]);
  const { gate } = makeGate({}, { getSession: (id) => sessions.get(id) });

  assert.equal(gate.sessionEnabled('s-sub'), true, '缺省继承到「开」');
  gate.setSessionEnabled('s-root', false);

  assert.equal(gate.sessionEnabled('s-sub'), false, '子代理应继承主会话的「关」');
  assert.equal(gate.sessionEnabled('s-grand'), false, '两层委派也应继承');
  assert.equal(gate.sessionEnabled('s-other'), true, '无关会话不受影响');
  assert.equal(gate.status('s-sub').inheritedOff, true);
  assert.equal(gate.status('s-other').inheritedOff, false);

  gate.setSessionEnabled('s-root', true);
  assert.equal(gate.sessionEnabled('s-sub'), true, '重新打开后子代理恢复');
  assert.equal(gate.status('s-sub').inheritedOff, false);
});

test('主会话关掉后，子代理的调用直接透传', async () => {
  const sessions = makeSessions([['s-root', ROOT_HEADER], ['s-sub', SUB_HEADER]]);
  const { gate } = makeGate({ peakWindows: [] }, { getSession: (id) => sessions.get(id) });
  gate.setSessionEnabled('s-root', false);

  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'pass' }; })();
  };
  const out = gate.listener({ sessionId: 's-sub', signal: new AbortController().signal }, next);
  assert.equal(called, 1, '继承到「关」的子代理必须立刻调下游');
  assert.deepEqual(await drain(out), [{ type: 'pass' }]);
});

test('关主会话会把正在等着的子代理调用一起放行', async () => {
  const sessions = makeSessions([['s-root', ROOT_HEADER], ['s-sub', SUB_HEADER]]);
  const { gate } = makeGate(
    { releaseJitterSeconds: [0, 0] },
    { now: () => PEAK_NOW, getSession: (id) => sessions.get(id) },
  );
  const options = { sessionId: 's-sub', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };

  const pending = drain(gate.listener(options, next));
  assert.equal(called, 0, '放行前不得调用 next()');
  const result = gate.setSessionEnabled('s-root', false);
  assert.ok(result.woken >= 1, '应报告唤醒了子代理的等待');
  assert.deepEqual(await pending, [{ type: 'chunk' }]);
  assert.equal(called, 1, '被唤醒后必须真的发出请求');
});

test('listener 已通过检查、生成器还没开始时关主会话，也不会排到 12:01', async () => {
  const sessions = makeSessions([['s-root', ROOT_HEADER], ['s-sub', SUB_HEADER]]);
  const { gate } = makeGate(
    { releaseJitterSeconds: [0, 0] },
    { now: () => PEAK_NOW, getSession: (id) => sessions.get(id) },
  );
  const options = { sessionId: 's-sub', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'late' }; })();
  };

  // 生成器只创建、还没开始迭代：此时 ticket 尚未登记。
  const iterable = gate.listener(options, next);
  assert.equal(called, 0);
  gate.setSessionEnabled('s-root', false);

  const chunks = await Promise.race([
    drain(iterable),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('登记后未重新检查开关，调用仍挂在 12:01')),
      1000,
    )),
  ]);
  assert.deepEqual(chunks, [{ type: 'late' }]);
  assert.equal(called, 1);
});

test('子代理自己打不开被主会话关掉的开关', () => {
  const sessions = makeSessions([['s-root', ROOT_HEADER], ['s-sub', SUB_HEADER]]);
  const { gate } = makeGate({ peakWindows: [] }, { getSession: (id) => sessions.get(id) });
  gate.setSessionEnabled('s-root', false);
  const status = gate.setSessionEnabled('s-sub', true);
  assert.equal(status.sessionEnabled, false, '自己的条目删掉也打不开，主会话仍然关着');
  assert.equal(status.inheritedOff, true);
});

test('会话链成环时不会卡死，关掉一环整环都关', () => {
  const sessions = makeSessions([
    ['s-a', { version: 4, id: 's-a', parentSession: 's-b' }],
    ['s-b', { version: 4, id: 's-b', parentSession: 's-a' }],
  ]);
  const { gate } = makeGate({ peakWindows: [] }, { getSession: (id) => sessions.get(id) });
  gate.setSessionEnabled('s-a', false);
  assert.equal(gate.sessionEnabled('s-a'), false);
  assert.equal(gate.sessionEnabled('s-b'), false, '成环时也要在有限步内得出结论');
});

/** 模拟 agent-loop 的消费方式，返回收到的 chunk。 */
async function drain(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

test('低谷时监听器直接透传，不产生等待', async () => {
  // 空窗口表 = 永远低谷，绕开「测试跑在几点」的不确定性。
  const { gate } = makeGate({ peakWindows: [] });
  const options = { sessionId: 's-root', signal: new AbortController().signal };
  const next = () => (async function* () { yield { type: 'text', text: 'hi' }; })();
  const iterable = gate.listener(options, next);
  assert.deepEqual(await drain(iterable), [{ type: 'text', text: 'hi' }]);
});

test('高峰 + dryRun：直接放行，且不留等待登记（演练不能真扣住人）', async () => {
  const { gate, calls } = makeGate({ releaseJitterSeconds: [0, 0], dryRun: true }, { now: () => PEAK_NOW });
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };

  const iterable = gate.listener(options, next);
  assert.equal(typeof iterable.then, 'undefined', '演练也必须同步返回 iterable');
  assert.deepEqual(await drain(iterable), [{ type: 'chunk' }]);
  assert.equal(called, 1, '演练模式下必须真的放行');
  assert.equal(gate.status('s-root').waiting, false, '演练不能留下等待登记');
  assert.equal(gate.status('s-root').dryRun, true);
  assert.ok(
    calls.some((m) => /dryRun/u.test(m)),
    '演练要留一条能看出来的日志，否则没人知道它拦过',
  );
});

test('后台调用（非 agent-loop 请求）在高峰也不排队', async () => {
  // 会话标题、上下文压缩、自动审核这些都会带 sessionId，但它们不是用户那一轮对话。
  // 拦它们只会让标题一直空着、压缩卡住 —— 这正是「不影响别家插件」要守的那条线。
  const { gate } = makeGate(
    { releaseJitterSeconds: [0, 0] },
    { now: () => PEAK_NOW, isAgentLoopRequest: () => false },
  );
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  const sentinel = { marker: 'passthrough' };
  assert.equal(gate.listener(options, () => sentinel), sentinel);
  assert.equal(gate.status('s-root').waiting, false);
});

test('高峰时监听器返回 AsyncGenerator（不是 Promise），且等待期可被 abort', async () => {
  // 用假时钟把「现在」钉在周三 10:00，与真实运行时刻无关。
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const controller = new AbortController();
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: controller.signal };
  const next = () => (async function* () { yield { type: 'chunk' }; })();

  const iterable = gate.listener(options, next);
  assert.equal(typeof iterable[Symbol.asyncIterator], 'function');
  assert.equal(typeof iterable.then, 'undefined', '不能是 Promise');

  // abort 后应以 signal.reason 结束，而不是挂到 12:00。
  const reason = Object.assign(new Error('stop'), { name: 'AbortError' });
  setTimeout(() => controller.abort(reason), 10);
  await assert.rejects(drain(iterable), (error) => error === reason);
});

test('高峰等待期内 releaseNow 能放行，且随后真的发出请求', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };

  const iterable = gate.listener(options, next);
  const pending = drain(iterable);
  assert.equal(called, 0, '放行前不得调用 next()');

  setTimeout(() => gate.releaseNow('s-root'), 20);
  assert.deepEqual(await pending, [{ type: 'chunk' }]);
  assert.equal(called, 1);
});

test('60 秒旁路有效期内，新的调用直接透传', () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  gate.releaseNow('s-root');
  const sentinel = { marker: 'bypass' };
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  assert.equal(gate.listener(options, () => sentinel), sentinel);
});

test('旁路过期后重新开始拦截', () => {
  let clock = PEAK_NOW;
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => clock });
  gate.releaseNow('s-root');
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  const next = () => (async function* () {})();
  const bypassed = gate.listener(options, () => ({ marker: 'bypass' }));
  assert.equal(bypassed.marker, 'bypass');

  // 61 秒后
  clock = new Date(PEAK_NOW.getTime() + 61_000);
  const gated = gate.listener(options, next);
  assert.equal(typeof gated[Symbol.asyncIterator], 'function');
  options.signal.dispatchEvent?.(new Event('abort'));
});

test('被 shouldGate 拒绝时原样返回 next() 的结果', () => {
  const { gate } = makeGate({ enabled: false });
  const sentinel = { marker: 'passthrough' };
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  const next = () => sentinel;
  assert.equal(gate.listener(options, next), sentinel);
});

test('subscribe 登记的等待者会被 releaseNow 唤醒', () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  let hits = 0;
  const unsubscribe = gate.subscribe('s-root')(() => { hits += 1; });

  assert.equal(gate.releaseNow('s-root'), 1, '应报告唤醒了 1 个等待者');
  assert.equal(hits, 1);

  // 已注销的不再被唤醒
  unsubscribe();
  assert.equal(gate.releaseNow('s-root'), 0);
  assert.equal(hits, 1);
});

test('不同会话的手动放行互不影响', () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  let other = 0;
  gate.subscribe('s-other')(() => { other += 1; });
  assert.equal(gate.releaseNow('s-root'), 0);
  assert.equal(other, 0);
});

test('旁路在持续调用中续期：50 秒后又一次调用，仍然透传', () => {
  /**
   * 一轮里往往有多次模型调用（工具调用之后还要再问一次）。固定 60 秒会让
   * 长回合在第二步又被拦下来——用户点了「立即运行」却看到它中途停住。
   * 这里走完 50 秒再调一次，断言它照样透传，且窗口被推到了新的 now+60s。
   */
  let clock = PEAK_NOW;
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => clock });
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  const next = () => ({ marker: 'bypass' });

  gate.releaseNow('s-root');
  assert.equal(gate.listener(options, next).marker, 'bypass');

  clock = new Date(PEAK_NOW.getTime() + 50_000);
  assert.equal(gate.listener(options, next).marker, 'bypass', '续期后仍然透传');
  assert.equal(
    gate.manualBypassUntil.get('s-root'),
    clock.getTime() + 60_000,
    '窗口应被推到这一次调用的 now+60s',
  );
});

test('旁路失效后不再续期：停下来 61 秒就重新开始拦', () => {
  let clock = PEAK_NOW;
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => clock });
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  gate.releaseNow('s-root');
  assert.equal(gate.listener(options, () => ({ marker: 'bypass' })).marker, 'bypass');

  clock = new Date(PEAK_NOW.getTime() + 61_000);
  const gated = gate.listener(options, () => (async function* () {})());
  assert.equal(typeof gated[Symbol.asyncIterator], 'function', '过期后应重新排队');
  assert.equal(gate.manualBypassUntil.has('s-root'), false, '过期的旁路条目应被删掉');
});

test('status().bypassing 反映旁路是否还在生效', () => {
  let clock = PEAK_NOW;
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => clock });

  assert.equal(gate.status('s-root').bypassing, false, '没点过就不该说在旁路');

  gate.releaseNow('s-root');
  assert.equal(gate.status('s-root').bypassing, true, '刚点完应报 bypassing');

  clock = new Date(PEAK_NOW.getTime() + 61_000);
  assert.equal(gate.status('s-root').bypassing, false, '过期后应报 false');
});

test('status() 低谷时 releaseAt 为 null、peak 为 false', () => {
  const { gate } = makeGate({}, { now: () => OFF_NOW });
  const status = gate.status('s-root');
  assert.equal(status.peak, false);
  assert.equal(status.waiting, false);
  assert.equal(status.releaseAt, null);
  assert.equal(status.releaseLabel, null);
  assert.equal(status.bypassing, false);
});

test('status() 高峰无等待时给出预测的 releaseAt', () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const status = gate.status('s-root');
  assert.equal(status.peak, true);
  assert.equal(status.waiting, false);
  assert.equal(status.releaseAt, sh(2026, 11, 11, 12, 0).getTime(), '应预测到 12:00');
  assert.equal(status.releaseLabel, '12:00');
});

/**
 * judge 是「这次调用是不是真对话」用的哪一套判据，必须能从 status 直接读到。
 *
 * 退化判据（purpose）漏一个 purpose 就会把别人的调用扣住，而那种坏只在
 * 高峰期才显形 —— 事后翻日志才知道当时用的哪一套就太晚了。
 */
test('status().judge 报告当前用的是哪一套判据', () => {
  const strict = makeGate({}, { isAgentLoopRequest: () => true });
  assert.equal(strict.gate.status('s-root').judge, 'agent-loop', '拿到宿主标记函数就是精确判据');

  const fallback = makeGate({}, { isAgentLoopRequest: undefined });
  assert.equal(fallback.gate.status('s-root').judge, 'purpose', '没拿到就走 purpose 退化判据');
});

// ---------------------------------------------------------------------------
// config 归一
// ---------------------------------------------------------------------------

test('normalizeConfig 幂等：归一两次结果不变', () => {
  const raw = { releaseJitterSeconds: [30, 45], peakWindows: [{ days: [1], start: '10:00', end: '11:00' }] };
  const once = normalizeConfig(raw);
  const twice = normalizeConfig(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(once.jitter, [30, 45], '用户改的抖动区间不能在第二次归一里丢掉');
});

test('normalizeConfig：peakWindows 缺省是 null，显式空数组保持空', () => {
  assert.equal(normalizeConfig({}).peakWindows, null, '缺省必须交给内置窗口');
  assert.deepEqual(normalizeConfig({ peakWindows: [] }).peakWindows, [], '空数组 = 没有高峰，不能被当成缺省');
});

test('normalizeConfig：坏值一律回落默认，不抛错', () => {
  const config = normalizeConfig({
    enabled: 'yes',
    timeZone: '',
    releaseJitterSeconds: [1],
    peakWindows: 'nope',
  });
  assert.equal(config.enabled, true, '非 false 一律当开');
  assert.equal(config.timeZone, 'Asia/Shanghai');
  assert.deepEqual(config.jitter, [60, 120], '长度不是 2 的数组要回落');
  assert.equal(config.peakWindows, null);
});

test('Config schema 的 validate 走同一套归一', () => {
  const result = Config['~standard'].validate({ enabled: false, releaseJitterSeconds: [5, 10] });
  assert.equal(result.issues, undefined);
  assert.equal(result.value.enabled, false);
  assert.deepEqual(result.value.jitter, [5, 10]);
});

// ---------------------------------------------------------------------------
// 醒来时还在高峰就续排（0.1.20，P0-2）
// ---------------------------------------------------------------------------

/** 周五 10:00 —— 「提交时在高峰」。 */
const FRI_10 = sh(2026, 11, 13, 10, 0);
/** 周五 12:00 —— 按当时的钟算出来的放行时刻。 */
const FRI_12 = sh(2026, 11, 13, 12, 0);

/**
 * 假时钟 + 假 timer：每次 `setTimeout` 直接把「现在」拨到 `wakeAts` 里的下一个时刻，
 * 再在微任务里回调。
 *
 * 这正是「等完之后才发现钟不对」的机器：真实场景是笔记本合盖休眠、系统时间被改，
 * 定时器到点时人已经不在原来那个时刻上了。
 */
function makeSkippingClock(start, wakeAts) {
  let now = start;
  const queue = [...wakeAts];
  const fired = [];
  return {
    now: () => now,
    fired,
    timers: {
      setTimeout: (fn, delay) => {
        fired.push(delay);
        const next = queue.shift();
        // 队列空了就按正常时钟前进：让等待能收敛，测试不会吊死。
        now = next === undefined ? new Date(now.getTime() + delay) : next;
        queueMicrotask(fn);
        return fired.length;
      },
      clearTimeout: () => {},
    },
  };
}

/**
 * 假时钟 + 假 timer：等待正常走到 `plan`，**刚放行的那一刻**把钟往回拨到 `rewindTo`。
 *
 * 这对应「系统时间被改」：等待结束的瞬间钟还是对的，紧接着被拨回去。
 * 续排逻辑于是会算出「下一次放行时刻不晚于上一次」，必须认输放行而不是原地打转。
 */
function makeRewindingClock(start, plan, rewindTo) {
  let now = start;
  let finished = false;
  const fired = [];
  return {
    fired,
    now: () => {
      if (finished) return rewindTo;
      const snapshot = now;
      if (snapshot.getTime() >= plan.getTime()) finished = true;
      return snapshot;
    },
    timers: {
      setTimeout: (fn, delay) => {
        fired.push(delay);
        now = new Date(now.getTime() + delay);
        queueMicrotask(fn);
        return fired.length;
      },
      clearTimeout: () => {},
    },
  };
}

/**
 * 假时钟 + **永不触发**的 timer：把等待冻在原地。
 *
 * 用来观察「等待登记」与「手动放行」这类只在等待期间成立的状态。
 * 自动推进的时钟会让等待瞬间走完，`releaseNow` 就再也叫不到人了。
 */
function makeFrozenClock(start) {
  const fired = [];
  return {
    now: () => start,
    fired,
    timers: {
      setTimeout: (_fn, delay) => {
        fired.push(delay);
        return fired.length;
      },
      clearTimeout: () => {},
    },
  };
}

test('醒来仍在高峰：续排到下一个低谷，而不是按原价直接发出去', async () => {
  // 只算一次放行时刻的老实现：周五 10:00 排到 12:00，醒来是周一 10:00（还在高峰），
  // 于是「等了个寂寞」还按原价把请求发了出去。正确行为是看到钟不对再排一轮。
  const clock = makeSkippingClock(FRI_10, [sh(2026, 11, 16, 10, 0), sh(2026, 11, 16, 12, 0)]);
  const logs = [];
  const { gate } = makeGate(
    { releaseJitterSeconds: [0, 0] },
    {
      now: clock.now,
      timers: clock.timers,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn:${m}`) },
    },
  );

  let called = 0;
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };

  const iterable = gate.listener(options, next);
  const chunks = await Promise.race([
    drain(iterable),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('醒来后没有续排，也没有收敛')),
      2000,
    )),
  ]);

  assert.deepEqual(chunks, [{ type: 'chunk' }]);
  assert.equal(called, 1, '整条链路只该发一次请求');
  assert.ok(
    logs.some((m) => /醒来仍在高峰，续排到/u.test(m)),
    `要留下能看懂的续排日志，实际：${logs.join(' | ')}`,
  );
  assert.ok(logs.some((m) => /放行（计划/u.test(m)), '放行日志仍然要有');
  assert.equal(gate.status('s-root').waiting, false, '放行后不该留下等待登记');
  assert.ok(clock.fired.length >= 2, '第二次等待真的发生过');
});

test('续排时刻没有前进时直接放行，不死循环', async () => {
  // 系统时间被往回拨、或窗口配置绕成环：重算出来的放行时刻不晚于上一次。
  // 此时必须认输放行并告警 —— 卡在这里等于把用户的会话挂死。
  const clock = makeRewindingClock(FRI_10, FRI_12, FRI_10);
  const logs = [];
  const { gate } = makeGate(
    { releaseJitterSeconds: [0, 0] },
    { now: clock.now, timers: clock.timers, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn:${m}`) } },
  );
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };

  const chunks = await Promise.race([
    drain(gate.listener(options, next)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('续排没有进展却不退出，疑似死循环')), 2000)),
  ]);
  assert.deepEqual(chunks, [{ type: 'chunk' }]);
  assert.equal(called, 1);
  assert.ok(
    logs.some((m) => /没有晚于上一次/u.test(m)),
    `应告警说明为什么放行，实际：${logs.join(' | ')}`,
  );
});

test('醒来仍高峰最多续排 8 次，之后先放行这一轮', async () => {
  // 合盖休眠一个月也能每次都醒在高峰里。必须有个上限，否则会话永远等不到头。
  // 用「每天 00:00-23:59 全时段高峰」的窗口，保证每一次醒来都还在高峰。
  const allDay = [{ days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' }];
  const wakes = [];
  for (let index = 1; index <= 9; index += 1) {
    wakes.push(sh(2026, 11, 16 + index, 10, 0)); // 连续几个工作日的上午
  }
  const clock = makeSkippingClock(FRI_10, wakes);
  const logs = [];
  const { gate } = makeGate(
    { peakWindows: allDay, releaseJitterSeconds: [0, 0] },
    { now: clock.now, timers: clock.timers, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn:${m}`) } },
  );
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };

  const chunks = await Promise.race([
    drain(gate.listener(options, next)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('续排次数没有上限')), 2000)),
  ]);
  assert.deepEqual(chunks, [{ type: 'chunk' }]);
  assert.equal(called, 1);
  assert.equal(
    logs.filter((m) => /续排到/u.test(m)).length,
    8,
    '续排 8 次后应停手（第 9 次只告警放行）',
  );
  assert.ok(logs.some((m) => /已续排 8 次/u.test(m)), `应说明为什么不再等，实际：${logs.join(' | ')}`);
});

test('手动放行仍然立刻结束等待，不会被续排逻辑拖住', async () => {
  // 用户点了「立即运行」的意思是「这一轮别等了」，续排不能把它又挂回去。
  const clock = makeFrozenClock(FRI_10);
  const logs = [];
  const { gate } = makeGate(
    { releaseJitterSeconds: [0, 0] },
    { now: clock.now, timers: clock.timers, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn:${m}`) } },
  );
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };

  const iterable = gate.listener(options, next);
  const pending = drain(iterable);
  // 生成器体在第一次 next() 时同步跑到第一个 await 之前，登记应当已经在了；
  // 再让出几轮，确保订阅也挂上，否则 releaseNow 会叫不到人。
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gate.status('s-root').waiting, true, '开始等待后应留下登记');

  assert.ok(gate.releaseNow('s-root') >= 1, '应叫醒正在等的那一个');
  assert.deepEqual(await pending, [{ type: 'chunk' }]);
  assert.equal(called, 1);
  assert.equal(logs.some((m) => /续排到/u.test(m)), false, '手动放行不该再续排');
});

// ---------------------------------------------------------------------------
// 坏窗口项：不崩、被过滤、告警一次（0.1.20，P0-1 / P1-1）
// ---------------------------------------------------------------------------

test('normalizeConfig：peakWindows 里的非对象项被丢掉，数组仍是数组', () => {
  const config = normalizeConfig({
    peakWindows: [null, undefined, 42, 'oops', { days: [3], start: '09:00', end: '12:00' }],
  });
  assert.deepEqual(config.peakWindows, [{ days: [3], start: '09:00', end: '12:00' }]);
  // 空数组仍然是有意义的配置：等于「没有高峰」，不能被当成坏值抹成 null。
  assert.deepEqual(normalizeConfig({ peakWindows: [] }).peakWindows, []);
  assert.equal(normalizeConfig({}).peakWindows, null, '缺省必须交给内置窗口');
});

test('peakWindows 全是坏项时退化成空表（没有高峰），并告警说明丢了几项', () => {
  const warns = [];
  const config = normalizeConfig(
    { peakWindows: [null, 42] },
    { warn: (message) => warns.push(message) },
  );
  assert.deepEqual(config.peakWindows, [], '全坏 = 没有可用窗口，不是「用默认窗口」');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /2 项/u);
  assert.match(warns[0], /null/u, '告警要带原始值，否则用户不知道改了哪一项');
});

test('同一处坏窗口只告警一次：归一化每个请求都跑，不能刷屏', () => {
  const warns = [];
  const logger = { warn: (message) => warns.push(message) };
  for (let round = 0; round < 5; round += 1) {
    normalizeConfig({ peakWindows: [null] }, logger);
  }
  assert.equal(warns.length, 1, '同一个 logger 下同一处坏值只报一次');
  // 换一个 logger（= 换一个观察者）仍应拿到完整告警
  const other = [];
  normalizeConfig({ peakWindows: [null] }, { warn: (message) => other.push(message) });
  assert.equal(other.length, 1);
});

test('时段写错（start / end / days）逐项告警并丢弃，不再静默变成永不拦截', () => {
  // P1-1：一个字符写错就让插件悄悄失去作用，而 /peak 还反过来报「现在是低谷」。
  // 断言用具体的「坏在哪」措辞，不用裸的 start/end/days —— 告警里带着原始值，
  // 那串 JSON 本身就有这几个键名，裸匹配会让「说错了原因」也照样绿。
  const cases = [
    { window: { days: [3], start: '9点', end: '12:00' }, expect: /start 无法解析/u },
    { window: { days: [3], start: '09:00', end: '25:00' }, expect: /end 无法解析/u },
    { window: { days: '1-5', start: '09:00', end: '12:00' }, expect: /days 必须是/u },
    { window: { days: [0, 3], start: '09:00', end: '12:00' }, expect: /不是 1-7 的整数/u },
    { window: { days: [3.5], start: '09:00', end: '12:00' }, expect: /不是 1-7 的整数/u },
    { window: { days: [], start: '09:00', end: '12:00' }, expect: /days 为空数组/u },
    { window: { start: '09:00', end: '12:00' }, expect: /days 必须是/u },
    { window: 'oops', expect: /不是对象/u },
  ];
  for (const item of cases) {
    const warns = [];
    const config = normalizeConfig({ peakWindows: [item.window] }, { warn: (m) => warns.push(m) });
    assert.deepEqual(config.peakWindows, [], `${JSON.stringify(item.window)} 应被丢弃`);
    assert.equal(warns.length, 1, `${JSON.stringify(item.window)} 应告警一次`);
    assert.match(warns[0], item.expect, `${JSON.stringify(item.window)} 的告警没说清坏在哪：${warns[0]}`);
  }
});

test('坏窗口不会被当成「没有高峰」而放行：合法那项照常拦住', async () => {
  const warns = [];
  const clock = makeFrozenClock(PEAK_NOW);
  // 直接建 gate，不经过 makeGate：makeGate 会先归一化一次，
  // 坏项在带 logger 的路径跑到之前就已经被丢掉，告警就观察不到了。
  const gate = createGate(
    () => ({
      // 周三 09:00-12:00 是高峰；前一后两个坏项必须被丢掉且不影响这一项。
      peakWindows: [null, { days: [3], start: '09:00', end: '12:00' }, { days: '3', start: '09:00', end: '12:00' }],
      releaseJitterSeconds: [0, 0],
    }),
    {
      getSession: () => plainSession,
      isAgentLoopRequest: () => true,
      now: clock.now,
      timers: clock.timers,
      logger: { info: () => {}, warn: (m) => warns.push(m) },
    },
  );
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  const out = gate.listener(options, () => (async function* () { yield { type: 'chunk' }; })());
  assert.equal(typeof out[Symbol.asyncIterator], 'function', '合法窗口仍应扣住这次调用');
  const pending = drain(out);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gate.status('s-root').waiting, true, '合法那项必须仍然拦住这次调用');
  assert.ok(warns.some((m) => /peakWindows/u.test(m)), '坏项要留一条告警');
  gate.releaseNow('s-root');
  assert.deepEqual(await pending, [{ type: 'chunk' }]);
});

test('peakWindows: [null] 时连非拦截范围的模型也能发出去（不再整机停摆）', async () => {
  // 这是 P0-1 的原始症状：一次配置手滑让所有模型调用都抛 TypeError，
  // 连 qwen 模型、连半夜低谷一起陪葬。
  const { gate } = makeGate({ peakWindows: [null] }, { now: () => PEAK_NOW });
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };
  const options = { sessionId: 's-root', provider: 'qwenwork', model: 'qwen3.8-max-preview', signal: new AbortController().signal };
  const out = gate.listener(options, next);
  assert.equal(typeof out.then, 'undefined');
  assert.deepEqual(await drain(out), [{ type: 'chunk' }]);
  assert.equal(called, 1);
});

test('peakWindows: [null] 时半夜低谷照样立刻放行', async () => {
  const { gate } = makeGate({ peakWindows: [null] }, { now: () => sh(2026, 11, 11, 3, 0) });
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };
  const options = { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal };
  await drain(gate.listener(options, next));
  assert.equal(called, 1);
});
