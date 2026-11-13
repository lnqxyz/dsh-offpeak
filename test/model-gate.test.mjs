// 双条件判定（0.1.17，用户 2026-11-13 拍板 · 最终口径）：
// 高峰期只有 **provider 命中（含 deepseek 或 workbuddy）且 model 命中（含 deepseek）**
// 的调用才会被扣住，其余组合（含字段缺失）一律立即放行；低谷时一切照旧。
//
// 为什么不能只看 model：本机 deepseek-* 是走 workbuddy / workbuddy-global 通道进来的，
// 挂那条通道的非高峰 5 折；而 qwenwork 这类没有峰谷折扣的通道里也可能出现 deepseek 模型。
// 所以「同一个模型换个通道」与「同一个通道换个模型」都不该等。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createGate, normalizeConfig, shouldHoldForCall } from '../lib/index.js';
import { zonedInstant } from '../lib/peak-window.js';

function sh(year, month, day, hour, minute = 0) {
  return zonedInstant(year, month, day, hour, minute, 'Asia/Shanghai');
}

/** 2026-11-11 周三 10:00，上午高峰内。 */
const PEAK_NOW = sh(2026, 11, 11, 10, 0);
/** 同一天 20:00，低谷。 */
const OFF_NOW = sh(2026, 11, 11, 20, 0);

/** 一对命中双条件的（provider, model）：高峰时必须扣住。 */
const HELD_PROVIDER = 'workbuddy';
const HELD_MODEL = 'deepseek-chat';

const plainSession = { header: { version: 4, id: 's-root' } };

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('shouldHoldForCall：provider 与 model 都命中才扣住', () => {
  const held = [
    ['workbuddy', 'deepseek-chat'],
    ['workbuddy-global', 'deepseek-v4.1-flash'],
    ['deepseek-official', 'deepseek-chat'],
    ['DEEPSEEK-ACCOUNT', 'DeepSeek-V4-Pro'],
    ['WorkBuddy', 'DeepSeek-Chat'],
    ['WORKBUDDY-GLOBAL', 'deepSeek-v3'],
  ];
  for (const [provider, model] of held) {
    assert.equal(shouldHoldForCall({ provider, model }), true, `${provider} + ${model}`);
  }
});

test('shouldHoldForCall：model 是 deepseek、但 provider 不命中 → 放行（双条件的核心）', () => {
  // 这条最能证明判据不是「只看 model」：模型名一模一样，换个没折扣的通道就不该等。
  const released = [
    ['qwenwork', 'deepseek-chat'],
    ['unknown', 'deepseek-v4-flash'],
    ['some-provider', 'deepseek-reasoner'],
    ['openrouter', 'deepSeek-chat'],
    ['my-proxy', 'my-deepseek-chat'],
  ];
  for (const [provider, model] of released) {
    assert.equal(shouldHoldForCall({ provider, model }), false, `${provider} + ${model}`);
  }
});

test('shouldHoldForCall：provider 命中、但 model 不是 deepseek → 放行', () => {
  const released = [
    ['workbuddy', 'qwen3.8-max-preview'],
    ['workbuddy', 'glm-4.6'],
    ['workbuddy', 'kimi-k2-instruct'],
    ['workbuddy-global', 'gpt-4o'],
    ['deepseek-official', 'claude-sonnet-4-5'],
  ];
  for (const [provider, model] of released) {
    assert.equal(shouldHoldForCall({ provider, model }), false, `${provider} + ${model}`);
  }
});

test('shouldHoldForCall：两个都不命中 → 放行', () => {
  for (const [provider, model] of [
    ['qwenwork', 'qwen3.8-max-preview'],
    ['glm', 'glm-4.6'],
    ['kimi', 'kimi-k2-instruct'],
  ]) {
    assert.equal(shouldHoldForCall({ provider, model }), false, `${provider} + ${model}`);
  }
});

test('shouldHoldForCall：provider 两个关键词是「或」，任一个出现就够', () => {
  // provider 这一关不能写成「必须同时含 deepseek 与 workbuddy」。
  assert.equal(shouldHoldForCall({ provider: 'workbuddy', model: 'deepseek-chat' }), true);
  assert.equal(shouldHoldForCall({ provider: 'deepseek', model: 'deepseek-chat' }), true);
  assert.equal(shouldHoldForCall({ provider: 'deepseek-workbuddy-relay', model: 'deepseek-chat' }), true);
});

test('shouldHoldForCall：只做包含匹配，不要求出现在开头、也不 trim', () => {
  // 按字面包含：名字里带这两个词就算通道命中（用户明确接受这个风险）。
  assert.equal(shouldHoldForCall({ provider: 'my-workbuddy-proxy', model: 'deepseek-chat' }), true);
  assert.equal(shouldHoldForCall({ provider: 'workbuddy-global', model: 'deepseek-chat' }), true);
  assert.equal(shouldHoldForCall({ provider: ' deepseek-account ', model: 'deepseek-chat' }), true);

  assert.equal(shouldHoldForCall({ provider: 'workbuddy', model: 'my-deepseek-chat' }), true);
  assert.equal(shouldHoldForCall({ provider: 'workbuddy', model: 'x-deepseek-y' }), true);
  assert.equal(shouldHoldForCall({ provider: 'workbuddy', model: 'deepseek' }), true);
  assert.equal(shouldHoldForCall({ provider: 'workbuddy', model: ' deepseek-chat ' }), true);
});

test('shouldHoldForCall：大小写不敏感（provider 与 model 各自都覆盖）', () => {
  const combos = [
    ['WorkBuddy', 'DeepSeek-Chat'],
    ['DEEPSEEK-Official', 'DEEPSEEK-REASONER'],
    ['workBuddy-GLOBAL', 'deepSeek-v4.1-flash'],
    ['DeEpSeEk-AcCoUnT', 'DeEpSeEk-V4-Pro'],
  ];
  for (const [provider, model] of combos) {
    assert.equal(shouldHoldForCall({ provider, model }), true, `${provider} + ${model}`);
  }
  // 大小写不敏感也不能把「都不命中」误判成命中。
  assert.equal(shouldHoldForCall({ provider: 'QwenWork', model: 'QWEN3.8-MAX-PREVIEW' }), false);
});

test('shouldHoldForCall：provider 缺失 / 空 / 非字符串 → 放行（fail-open）', () => {
  for (const provider of [
    undefined,
    null,
    '',
    0,
    42,
    NaN,
    true,
    false,
    {},
    [],
    ['workbuddy'],
    () => 'workbuddy',
    Symbol('workbuddy'),
    new String('workbuddy'),
  ]) {
    assert.equal(
      shouldHoldForCall({ provider, model: 'deepseek-chat' }),
      false,
      `provider=${String(provider)}`,
    );
  }
});

test('shouldHoldForCall：model 缺失 / 空 / 非字符串 → 放行（fail-open）', () => {
  for (const model of [
    undefined,
    null,
    '',
    0,
    42,
    NaN,
    true,
    false,
    {},
    [],
    ['deepseek-chat'],
    () => 'deepseek-chat',
    Symbol('deepseek'),
    new String('deepseek-chat'),
  ]) {
    assert.equal(
      shouldHoldForCall({ provider: 'workbuddy', model }),
      false,
      `model=${String(model)}`,
    );
  }
});

test('shouldHoldForCall：options 本身缺失 / 怪值 → 放行且不抛错', () => {
  for (const options of [undefined, null, 0, 42, 'deepseek', true, Symbol('x'), new String('x'), () => ({})]) {
    assert.doesNotThrow(() => shouldHoldForCall(options), String(options));
    assert.equal(shouldHoldForCall(options), false, String(options));
  }
  // 两个字段都缺
  assert.equal(shouldHoldForCall({}), false);
  assert.equal(shouldHoldForCall(Object.create(null)), false);
});

test('shouldHoldForCall：读字段抛错也兜住并放行', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'provider', {
    enumerable: true,
    get() {
      throw new Error('provider getter boom');
    },
  });
  Object.defineProperty(hostile, 'model', { value: 'deepseek-chat' });
  assert.doesNotThrow(() => shouldHoldForCall(hostile));
  assert.equal(shouldHoldForCall(hostile), false, '判定本身抛错时不能把调用卡在高峰里');
});

// ---------------------------------------------------------------------------
// 闸门行为
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

/** 模拟 agent-loop 的消费方式，返回收到的 chunk。 */
async function drain(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** 立即放行的一侧：调一次 listener，断言下游被立刻调用且没有留下等待登记。 */
async function assertReleased(provider, model, label) {
  const { gate, calls } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };
  const options = { sessionId: 's-root', provider, model, signal: new AbortController().signal };
  const out = gate.listener(options, next);
  assert.equal(typeof out.then, 'undefined', '必须同步返回 iterable，不能是 Promise');
  assert.deepEqual(await drain(out), [{ type: 'chunk' }], label);
  assert.equal(called, 1, `${label}：必须立刻调下游`);
  assert.equal(gate.status('s-root').waiting, false, `${label}：不该留下等待登记`);
  assert.equal(calls.some((m) => /排到/u.test(m)), false, `${label}：不该有「排到 12:00」的假日志`);
  return calls;
}

test('高峰 + provider 命中且 model 命中：扣住，直到 abort 都不调下游', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const controller = new AbortController();
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };

  const iterable = gate.listener(
    { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: controller.signal },
    next,
  );
  assert.equal(typeof iterable[Symbol.asyncIterator], 'function');
  assert.equal(typeof iterable.then, 'undefined', '必须同步返回 iterable');

  // 生成器体要到宿主开始迭代时才执行（ticket 也在那一刻登记），所以先起 drain。
  const pending = drain(iterable);
  await tick();
  assert.equal(called, 0, '放行前不得调用下游');
  const status = gate.status('s-root');
  assert.equal(status.waiting, true);
  assert.equal(status.heldProvider, HELD_PROVIDER, '诊断字段要报出扣住的通道');
  assert.equal(status.heldModel, HELD_MODEL, '诊断字段要报出扣住的模型');
  assert.equal(status.releaseAt, sh(2026, 11, 11, 12, 0).getTime(), '排到 12:00 的行为不变');

  const reason = Object.assign(new Error('stop'), { name: 'AbortError' });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(called, 0, 'abort 后仍不得调用下游');
});

test('高峰 + workbuddy-global 通道的 deepseek-v4.1-flash：扣住', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const controller = new AbortController();
  let called = 0;
  const pending = drain(gate.listener(
    {
      sessionId: 's-root',
      provider: 'workbuddy-global',
      model: 'deepseek-v4.1-flash',
      signal: controller.signal,
    },
    () => {
      called += 1;
      return (async function* () { yield { type: 'chunk' }; })();
    },
  ));
  await tick();
  assert.equal(called, 0);
  assert.equal(gate.status('s-root').heldProvider, 'workbuddy-global');
  assert.equal(gate.status('s-root').heldModel, 'deepseek-v4.1-flash');
  gate.releaseNow('s-root');
  assert.deepEqual(await pending, [{ type: 'chunk' }]);
});

test('高峰 + deepseek-official 官方直连（将来会配）：扣住', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const controller = new AbortController();
  let called = 0;
  const pending = drain(gate.listener(
    { sessionId: 's-root', provider: 'deepseek-official', model: 'deepseek-chat', signal: controller.signal },
    () => {
      called += 1;
      return (async function* () { yield { type: 'chunk' }; })();
    },
  ));
  await tick();
  assert.equal(called, 0, '官方直连同样打折，应扣住');
  gate.releaseNow('s-root');
  await pending;
});

test('高峰 + provider / model 混合大小写：同样扣住', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const controller = new AbortController();
  let called = 0;
  const pending = drain(gate.listener(
    { sessionId: 's-root', provider: 'WorkBuddy', model: 'DeepSeek-Chat', signal: controller.signal },
    () => {
      called += 1;
      return (async function* () { yield { type: 'chunk' }; })();
    },
  ));
  await tick();
  assert.equal(called, 0, '大小写不影响命中');
  assert.equal(gate.status('s-root').waiting, true);
  gate.releaseNow('s-root');
  await pending;
});

test('高峰 + qwenwork 通道的 deepseek：立即放行（模型对、通道没折扣）', async () => {
  const calls = await assertReleased('qwenwork', 'deepseek-chat', 'qwenwork + deepseek-chat');
  assert.ok(
    calls.some((m) => /立即放行/u.test(m)),
    '要留一条能看出「高峰但放行了」的日志，否则事后无法解释为什么没等',
  );
});

test('高峰 + provider 命中的 qwen / glm / kimi：立即放行（通道有折扣，但模型没有）', async () => {
  for (const model of ['qwen3.8-max-preview', 'glm-4.6', 'kimi-k2-instruct']) {
    await assertReleased('workbuddy', model, `workbuddy + ${model}`);
  }
});

test('高峰 + 两个都不命中：立即放行', async () => {
  await assertReleased('qwenwork', 'qwen3.8-max-preview', 'qwenwork + qwen3.8-max-preview');
});

test('高峰 + provider 缺失：fail-open 放行', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };
  await drain(gate.listener(
    { sessionId: 's-root', model: 'deepseek-chat', signal: new AbortController().signal },
    next,
  ));
  assert.equal(called, 1, '拿不到 provider 时宁可放行，不要把调用扣在高峰里');
  assert.equal(gate.status('s-root').waiting, false);
});

test('高峰 + provider 空串 / 非字符串：fail-open 放行', async () => {
  for (const provider of ['', 42, null, { name: 'workbuddy' }, ['workbuddy']]) {
    await assertReleased(provider, 'deepseek-chat', `provider=${JSON.stringify(provider)}`);
  }
});

test('高峰 + provider 命中但 model 缺失 / 空串 / 非字符串：fail-open 放行', async () => {
  for (const model of [undefined, '', 42, null, { id: 'deepseek-chat' }]) {
    await assertReleased('workbuddy', model, `model=${JSON.stringify(model)}`);
  }
});

test('低谷 + 任意组合：照旧立即放行，判定不介入也不写放行日志', async () => {
  // 低谷本来就全部放行；这里确认双条件判据没有把低谷路径改坏。
  const combos = [
    ['workbuddy', 'deepseek-chat'],
    ['qwenwork', 'deepseek-chat'],
    ['workbuddy', 'qwen3.8-max-preview'],
    ['qwenwork', 'qwen3.8-max-preview'],
    [undefined, undefined],
  ];
  for (const [provider, model] of combos) {
    const { gate, calls } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => OFF_NOW });
    let called = 0;
    const next = () => {
      called += 1;
      return (async function* () { yield { type: 'chunk' }; })();
    };
    await drain(gate.listener(
      { sessionId: 's-root', provider, model, signal: new AbortController().signal },
      next,
    ));
    assert.equal(called, 1, `${provider} + ${model} 在低谷必须透传`);
    assert.equal(gate.status('s-root').waiting, false);
    assert.equal(
      calls.length,
      0,
      '低谷不该出现任何判定日志：那一刻根本不是高峰，路径要一个字节都不变',
    );
  }
});

test('低谷（空窗口表）+ 任意组合：全部透传', async () => {
  for (const [provider, model] of [
    ['workbuddy', 'deepseek-reasoner'],
    ['qwenwork', 'qwen3.8-max-preview'],
    [undefined, undefined],
  ]) {
    const { gate } = makeGate({ peakWindows: [] }, { now: () => PEAK_NOW });
    let called = 0;
    const next = () => {
      called += 1;
      return (async function* () { yield { type: 'chunk' }; })();
    };
    await drain(gate.listener(
      { sessionId: 's-root', provider, model, signal: new AbortController().signal },
      next,
    ));
    assert.equal(called, 1, `${provider} + ${model} 在空窗口表下必须透传`);
  }
});

test('高峰 + dryRun + 双条件成立：只记日志不拦截', async () => {
  const { gate, calls } = makeGate(
    { releaseJitterSeconds: [0, 0], dryRun: true },
    { now: () => PEAK_NOW },
  );
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };
  await drain(gate.listener(
    { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal },
    next,
  ));
  assert.equal(called, 1);
  assert.equal(gate.status('s-root').waiting, false);
  assert.ok(calls.some((m) => /dryRun/u.test(m)), '演练要留一条日志');
});

test('高峰 + dryRun + 任一条件不成立：先按双条件放行，不写演练日志', async () => {
  // 演练日志的意义是「这次本来会被扣住」。不在拦截范围的组合压根不该等，
  // 给它写 dryRun 会让人以为演练模式下它被拦过一次。
  for (const [provider, model] of [
    ['qwenwork', 'deepseek-chat'],
    ['workbuddy', 'qwen3.8-max-preview'],
  ]) {
    const { gate, calls } = makeGate(
      { releaseJitterSeconds: [0, 0], dryRun: true },
      { now: () => PEAK_NOW },
    );
    let called = 0;
    await drain(gate.listener(
      { sessionId: 's-root', provider, model, signal: new AbortController().signal },
      () => {
        called += 1;
        return (async function* () { yield { type: 'chunk' }; })();
      },
    ));
    assert.equal(called, 1);
    assert.equal(calls.some((m) => /dryRun/u.test(m)), false, `${provider} + ${model} 不该写演练日志`);
    assert.ok(calls.some((m) => /立即放行/u.test(m)));
  }
});

test('本会话开关关掉时，双条件命中的调用也不排队', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  gate.setSessionEnabled('s-root', false);
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'pass' }; })();
  };
  const out = await drain(gate.listener(
    { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal },
    next,
  ));
  assert.deepEqual(out, [{ type: 'pass' }]);
  assert.equal(called, 1);
});

test('/peak now 的手动放行与旁路对双条件命中的调用照常生效', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const options = {
    sessionId: 's-root',
    provider: HELD_PROVIDER,
    model: HELD_MODEL,
    signal: new AbortController().signal,
  };
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };

  const pending = drain(gate.listener(options, next));
  await tick();
  assert.equal(called, 0);

  assert.ok(gate.releaseNow('s-root') >= 1);
  assert.deepEqual(await pending, [{ type: 'chunk' }]);
  assert.equal(called, 1);

  // 旁路期内新的调用直接透传（续期行为不变）
  assert.equal(gate.listener(options, () => ({ marker: 'bypass' })).marker, 'bypass');
});

test('status().heldModel / heldProvider 报出正在等的那一对，没人在等时都为 null', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  assert.equal(gate.status('s-root').heldModel, null, '没人等的时候不该编一个模型名');
  assert.equal(gate.status('s-root').heldProvider, null, '没人等的时候不该编一个通道名');

  const controller = new AbortController();
  const pending = drain(gate.listener(
    { sessionId: 's-root', provider: 'workbuddy-global', model: 'deepseek-reasoner', signal: controller.signal },
    () => (async function* () { yield { type: 'chunk' }; })(),
  ));
  await tick();
  assert.equal(gate.status('s-root').heldModel, 'deepseek-reasoner', '要能看出扣住的是哪个模型');
  assert.equal(gate.status('s-root').heldProvider, 'workbuddy-global', '要能看出扣住的是哪个通道');
  assert.equal(gate.status('s-root').waiting, true);

  gate.releaseNow('s-root');
  await pending;
  assert.equal(gate.status('s-root').heldModel, null, '放行后应回到 null');
  assert.equal(gate.status('s-root').heldProvider, null, '放行后应回到 null');
  assert.equal(gate.status('s-root').waiting, false);
});

test('子代理会话继承到「关」时，双条件命中的调用也直接透传', async () => {
  const sessions = new Map([
    ['s-root', { header: { version: 4, id: 's-root' } }],
    ['s-sub', { header: { version: 4, id: 's-sub', origin: 'subagent', delegationDepth: 1, parentSession: 's-root' } }],
  ]);
  const { gate } = makeGate(
    { releaseJitterSeconds: [0, 0] },
    { now: () => PEAK_NOW, getSession: (id) => sessions.get(id) },
  );
  gate.setSessionEnabled('s-root', false);

  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'pass' }; })();
  };
  await drain(gate.listener(
    {
      sessionId: 's-sub',
      provider: HELD_PROVIDER,
      model: HELD_MODEL,
      signal: new AbortController().signal,
    },
    next,
  ));
  assert.equal(called, 1, '继承到「关」的子代理必须立刻调下游');
});

test('后台调用（非 agent-loop）即便双条件命中，也在模型判定之前就被放行', async () => {
  // 两道判据是并列的：既不是对话请求、又命中了双条件，仍然先按「后台调用」放行。
  const { gate } = makeGate(
    { releaseJitterSeconds: [0, 0] },
    { now: () => PEAK_NOW, isAgentLoopRequest: () => false },
  );
  const sentinel = { marker: 'passthrough' };
  assert.equal(
    gate.listener(
      { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal },
      () => sentinel,
    ),
    sentinel,
    '标题生成 / 压缩 / 自动审核用的也可能是 workbuddy + deepseek，仍必须放行',
  );
  assert.equal(gate.status('s-root').waiting, false);
});

test('enabled:false 时双条件判定完全不介入', async () => {
  const { gate } = makeGate({ enabled: false }, { now: () => PEAK_NOW });
  const sentinel = { marker: 'passthrough' };
  assert.equal(
    gate.listener(
      { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal },
      () => sentinel,
    ),
    sentinel,
  );
});

test('不打断在途：判定只在扣住之前发生，已放行的流照常跑完', async () => {
  // 红线之一。放行的那一次调用一旦开始迭代，就不该被任何后续判定影响 ——
  // 这里让第一个调用（qwenwork + deepseek）立刻放行并完整抽干，再让第二个
  // （双条件命中）扣住，断言第一个的 chunk 一个不少。
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const first = await drain(gate.listener(
    {
      sessionId: 's-root',
      provider: 'qwenwork',
      model: 'deepseek-chat',
      signal: new AbortController().signal,
    },
    () => (async function* () { yield { type: 'text', text: 'a' }; yield { type: 'text', text: 'b' }; })(),
  ));
  assert.deepEqual(first, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);

  const controller = new AbortController();
  const second = drain(gate.listener(
    { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: controller.signal },
    () => (async function* () { yield { type: 'text', text: 'c' }; })(),
  ));
  await tick();
  assert.equal(gate.status('s-root').waiting, true, '第二个才该被扣住');
  controller.abort(Object.assign(new Error('stop'), { name: 'AbortError' }));
  await assert.rejects(second);
});
