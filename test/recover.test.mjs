// 重启续跑：`agent/created` 上的恢复点。
//
// 这一组测的是「重启后队列里躺着的消息会不会自己动起来」。它是纯函数级的
// 单元测试——用假的 agent 对象复刻 ReactLoopAgent 的那几个运行时字段，
// 不起真 cordis、不碰真会话。
import test from 'node:test';
import assert from 'node:assert/strict';

import { recoverPendingOnResume } from '../lib/index.js';

/** 造一个假 agent，字段形状对齐 `ReactLoopAgent` 的运行时面。 */
function makeAgent({ nextTurn = [], nextStep = [], withWake = true, withFollowup = true } = {}) {
  const log = [];
  const agent = {
    inbox: {
      nextTurn,
      nextStep,
      get hasPending() {
        return nextTurn.length > 0 || nextStep.length > 0;
      },
      remove(id) {
        log.push(`remove:${id}`);
        const turnIndex = nextTurn.findIndex((m) => m.id === id);
        if (turnIndex >= 0) return nextTurn.splice(turnIndex, 1)[0];
        const stepIndex = nextStep.findIndex((m) => m.id === id);
        if (stepIndex >= 0) return nextStep.splice(stepIndex, 1)[0];
        return undefined;
      },
    },
    log,
  };
  if (withWake) {
    agent.wakeDriver = () => log.push('wakeDriver');
  }
  if (withFollowup) {
    // 真 agent 的 `followup()` 会重新入队到 next-turn 末尾（`send(..., "next-turn", true)`），
    // 所以重投一次之后队列长度不变、顺序也不变。假 agent 必须复刻这一点，
    // 否则「顺序不变」这条断言测的就不是实现、而是假对象自己写错了。
    agent.followup = (message) => {
      log.push(`followup:${message.id}`);
      nextTurn.push(message);
    };
  }
  agent.steer = (message) => {
    log.push(`steer:${message.id}`);
    nextStep.push(message);
  };
  return agent;
}

const msg = (id) => ({ id, role: 'user', content: [{ type: 'text', text: id }] });
const cfg = () => ({});
const quiet = { logger: { info: () => {}, warn: () => {} } };

test('resume 且有排队消息时唤醒驱动器，且不动队列顺序', () => {
  const agent = makeAgent({ nextTurn: [msg('a'), msg('b'), msg('c')] });
  const result = recoverPendingOnResume({ agent, source: 'resume' }, cfg, quiet);
  assert.equal(result, 'woken');
  assert.deepEqual(agent.log, ['wakeDriver']);
  assert.deepEqual(agent.inbox.nextTurn.map((m) => m.id), ['a', 'b', 'c'], '顺序必须原样保留');
});

test('startup 不续跑：新建会话的 inbox 本来就是空的', () => {
  const agent = makeAgent({ nextTurn: [msg('a')] });
  assert.equal(recoverPendingOnResume({ agent, source: 'startup' }, cfg, quiet), 'skipped:source');
  assert.deepEqual(agent.log, []);
});

test('没有排队消息时什么都不做', () => {
  const agent = makeAgent();
  assert.equal(recoverPendingOnResume({ agent, source: 'resume' }, cfg, quiet), 'skipped:empty');
  assert.deepEqual(agent.log, []);
});

test('只有 nextStep（待注入）也算有排队', () => {
  const agent = makeAgent({ nextStep: [msg('s')] });
  assert.equal(recoverPendingOnResume({ agent, source: 'resume' }, cfg, quiet), 'woken');
  assert.deepEqual(agent.log, ['wakeDriver']);
});

test('resumePending=false 时完全不碰', () => {
  const agent = makeAgent({ nextTurn: [msg('a')] });
  const result = recoverPendingOnResume({ agent, source: 'resume' }, () => ({ resumePending: false }), quiet);
  assert.equal(result, 'disabled');
  assert.deepEqual(agent.log, []);
});

test('没有 wakeDriver 时重投最后一条，顺序不变', () => {
  const agent = makeAgent({ nextTurn: [msg('a'), msg('b'), msg('c')], withWake: false });
  const result = recoverPendingOnResume({ agent, source: 'resume' }, cfg, quiet);
  assert.equal(result, 'resent:turn');
  assert.deepEqual(agent.log, ['remove:c', 'followup:c']);
  assert.deepEqual(agent.inbox.nextTurn.map((m) => m.id), ['a', 'b', 'c'], '重投后仍应排在末尾');
});

test('没有 inbox 时安静跳过（不在公开类型面上，版本一变就可能没有）', () => {
  assert.equal(recoverPendingOnResume({ agent: {}, source: 'resume' }, cfg, quiet), 'skipped:no-inbox');
  assert.equal(recoverPendingOnResume({ agent: null, source: 'resume' }, cfg, quiet), 'skipped:no-agent');
  assert.equal(recoverPendingOnResume(undefined, cfg, quiet), 'skipped:source');
});

test('inbox 取值抛错时当没有 inbox，不外泄', () => {
  const agent = {
    get inbox() {
      throw new Error('boom');
    },
  };
  assert.equal(recoverPendingOnResume({ agent, source: 'resume' }, cfg, quiet), 'skipped:no-inbox');
});

test('内部抛错一律吞掉：监听器抛错会连带让会话打不开', () => {
  const agent = makeAgent({ nextTurn: [msg('a')], withWake: false });
  agent.inbox.remove = () => {
    throw new Error('mutate exploded');
  };
  const warnings = [];
  const result = recoverPendingOnResume(
    { agent, source: 'resume' },
    cfg,
    { logger: { info: () => {}, warn: (m) => warnings.push(m) } },
  );
  assert.equal(result, 'error');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /mutate exploded/u);
});

test('配置读取本身抛错也不外泄', () => {
  const agent = makeAgent({ nextTurn: [msg('a')] });
  const result = recoverPendingOnResume({ agent, source: 'resume' }, () => {
    throw new Error('config exploded');
  }, quiet);
  assert.equal(result, 'error');
});

test('既没有 wakeDriver 也没有 followup 时不做半套操作', () => {
  const agent = makeAgent({ nextTurn: [msg('a')], withWake: false, withFollowup: false });
  assert.equal(recoverPendingOnResume({ agent, source: 'resume' }, cfg, quiet), 'skipped:no-transport');
  assert.deepEqual(agent.log, [], '不能先删再放弃，那会凭空丢消息');
});

// ---------------------------------------------------------------------------
// 委派会话跳过（第⑦项）
// ---------------------------------------------------------------------------

/** 判定函数与 lib/index.js 里的 `isDelegatedSession` 同义：只认 header 上的三种标记。 */
const delegatedChecker = (session) => {
  const header = session?.header ?? {};
  return header.origin === 'subagent'
    || (typeof header.parentSession === 'string' && header.parentSession !== '')
    || (typeof header.delegationDepth === 'number' && header.delegationDepth >= 1);
};

test('委派会话不替它续跑：主会话那条路会带起它，这里再动就是重复驱动', () => {
  const agent = makeAgent({ nextTurn: [msg('a')] });
  agent.session = { header: { origin: 'subagent', delegationDepth: 1, parentSession: 's-root' } };
  let calls = 0;
  const result = recoverPendingOnResume(
    { agent, source: 'resume' },
    cfg,
    { logger: { info: () => {}, warn: () => {} }, isDelegatedSession: delegatedChecker },
  );
  calls += agent.log.length;
  assert.equal(result, 'skipped:delegated');
  assert.equal(calls, 0, '不能叫醒也不能重投');
  assert.deepEqual(agent.inbox.nextTurn.map((m) => m.id), ['a'], '队列必须原样留着');
});

test('agent.session 读不到时退回按 id 查会话，仍能认出委派', () => {
  const agent = makeAgent({ nextTurn: [msg('a')] });
  const result = recoverPendingOnResume(
    { agent, source: 'resume' },
    cfg,
    {
      logger: { info: () => {}, warn: () => {} },
      isDelegatedSession: delegatedChecker,
      getSession: () => ({ header: { origin: 'subagent', delegationDepth: 1, parentSession: 's-root' } }),
    },
  );
  assert.equal(result, 'skipped:delegated');
  assert.deepEqual(agent.log, []);
});

test('拿不到会话对象时按「不是委派」处理，宁可多跑一次也不漏', () => {
  const agent = makeAgent({ nextTurn: [msg('a')] });
  const result = recoverPendingOnResume(
    { agent, source: 'resume' },
    cfg,
    { logger: { info: () => {}, warn: () => {} }, isDelegatedSession: delegatedChecker },
  );
  assert.equal(result, 'woken', '缺 session 时不能把恢复流程卡死');
  assert.deepEqual(agent.log, ['wakeDriver']);
});

test('主会话自己（非委派）照常续跑', () => {
  const agent = makeAgent({ nextTurn: [msg('a')] });
  agent.session = { header: { version: 4, id: 's-root' } };
  const result = recoverPendingOnResume(
    { agent, source: 'resume' },
    cfg,
    { logger: { info: () => {}, warn: () => {} }, isDelegatedSession: delegatedChecker },
  );
  assert.equal(result, 'woken');
  assert.deepEqual(agent.log, ['wakeDriver']);
});

// ---------------------------------------------------------------------------
// 判据不能只认 hasPending（P1-3）
//
// `agent.inbox` 不在 `Agent` 的公开类型面上，`hasPending` 同样不在。宿主换个
// 实现、这个 getter 改名或直接消失，判据就恒为 undefined —— 旧代码在这里静默
// 返回 `skipped:empty`，用户看到的是重启前排好的消息原地不动，也没有任何一条
// 日志说得出原因。所以两路并认：`hasPending === true`，或者数组里确实有内容。
// ---------------------------------------------------------------------------

/** 造一个 inbox 形状可控的假 agent（只保留恢复流程会碰的那几个字段）。 */
function makeSparseAgent(inboxFields, { withWake = true } = {}) {
  const log = [];
  const agent = { inbox: inboxFields, log };
  if (withWake) agent.wakeDriver = () => log.push('wakeDriver');
  return agent;
}

test('hasPending 缺失但 nextTurn 里有消息：仍要恢复，不能静默当队列是空的', () => {
  // 宿主换实现后最危险的形态：字段没了，消息还在。
  const pending = [msg('a'), msg('b')];
  const agent = makeSparseAgent({
    nextTurn: pending,
    nextStep: [],
    remove: (id) => {
      const index = pending.findIndex((m) => m.id === id);
      return index >= 0 ? pending.splice(index, 1)[0] : undefined;
    },
  });
  const result = recoverPendingOnResume({ agent, source: 'resume' }, cfg, quiet);
  assert.equal(result, 'woken');
  assert.deepEqual(agent.log, ['wakeDriver']);
});

test('hasPending 变成 undefined 但 nextStep 里有消息：同样要恢复', () => {
  const agent = makeSparseAgent({
    nextTurn: [],
    nextStep: [msg('s')],
    hasPending: undefined,
    remove: () => undefined,
  });
  const result = recoverPendingOnResume({ agent, source: 'resume' }, cfg, quiet);
  assert.equal(result, 'woken', 'nextStep 有内容时不能因为 hasPending 没了就放弃');
  assert.deepEqual(agent.log, ['wakeDriver']);
});

test('hasPending 是一个恒返回 undefined 的 getter 时也不挡恢复', () => {
  const agent = makeSparseAgent({
    nextTurn: [msg('a')],
    nextStep: [],
    get hasPending() {
      return undefined;
    },
    remove: () => undefined,
  });
  assert.equal(recoverPendingOnResume({ agent, source: 'resume' }, cfg, quiet), 'woken');
});

test('hasPending 说 true 但数组读不出来：仍按有排队处理（宁可多叫醒一次）', () => {
  const agent = makeSparseAgent({
    get nextTurn() {
      throw new Error('nextTurn 读不出来');
    },
    get nextStep() {
      throw new Error('nextStep 读不出来');
    },
    hasPending: true,
  });
  assert.equal(recoverPendingOnResume({ agent, source: 'resume' }, cfg, quiet), 'woken');
  assert.deepEqual(agent.log, ['wakeDriver']);
});

test('两路都为空时仍然认定队列是空的（放宽判据不等于总是恢复）', () => {
  const agent = makeSparseAgent({ nextTurn: [], nextStep: [], hasPending: undefined });
  assert.equal(recoverPendingOnResume({ agent, source: 'resume' }, cfg, quiet), 'skipped:empty');
  assert.deepEqual(agent.log, [], '没排队就不能去叫醒驱动器');
});
