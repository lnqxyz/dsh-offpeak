// 重启续跑之「在途回合」：上一轮跑到一半被重启打断，重启后补一条续跑提示。
//
// 全部是纯函数级测试 —— 用假的 session / agent 复刻运行时面，
// 不起真 cordis、不碰真会话、不读真日志。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTINUATION_TEXT,
  NUDGE_SOURCE_KIND,
  buildContinuationMessage,
  continueInterruptedTurn,
  describeReason,
  hasPendingNudge,
  inspectTail,
  isInterruptedTurnReason,
  planTurnContinuation,
} from '../lib/resume-turn.js';

const quiet = { logger: { info: () => {}, warn: () => {} } };
const cfg = () => ({});

/** 事件构造器：只带被实现读取的字段。 */
const ev = (type, data = {}, seq = 0) => ({ type, seq, time: 1_700_000_000_000 + seq, data });

/** 造一段以指定 reason 收尾的会话历史。 */
function history(reason, { turn = 1, extra = [] } = {}) {
  const events = [
    ev('turn/start', { turn }, 0),
    ev('step/start', { turn, step: 1 }, 1),
    ev('user/message', { id: 'u1', role: 'user', content: [], source: { kind: 'user' } }, 2),
    ...extra,
    ev('step/end', { turn, step: 1 }, 3),
    ev('turn/end', { turn, reason }, 4),
  ];
  return events;
}

// ---------------------------------------------------------------------------
// 判据：哪些 turn/end 才算「被系统打断」
// ---------------------------------------------------------------------------

test('aborted/disposed 算打断（进程退出打断在途 turn）', () => {
  assert.equal(isInterruptedTurnReason({ kind: 'aborted', reason: { kind: 'disposed' } }), true);
});

test('interrupted 算打断（硬杀后由 closers 合成）', () => {
  assert.equal(isInterruptedTurnReason({ kind: 'interrupted' }), true);
});

test('用户点停止不算：那是他自己不想跑了', () => {
  assert.equal(isInterruptedTurnReason({ kind: 'aborted', reason: { kind: 'user' } }), false);
});

test('父代理取消不算', () => {
  assert.equal(isInterruptedTurnReason({ kind: 'aborted', reason: { kind: 'parent' } }), false);
});

test('正常结束 / 报错 / 被拦 / 超长 / fork 一律不续跑', () => {
  for (const reason of [
    { kind: 'completed' },
    { kind: 'error', error: { code: 'UNKNOWN', message: 'x' } },
    { kind: 'blocked' },
    { kind: 'max-tokens' },
    { kind: 'forked' },
  ]) {
    assert.equal(isInterruptedTurnReason(reason), false, `${reason.kind} 不该续跑`);
  }
});

test('坏形状一律当「不是打断」，绝不抛错', () => {
  for (const bad of [null, undefined, 0, 'aborted', [], {}]) {
    assert.equal(isInterruptedTurnReason(bad), false);
  }
});

// ---------------------------------------------------------------------------
// 尾部判定
// ---------------------------------------------------------------------------

test('取最后一条 turn/end 的 reason', () => {
  const tail = inspectTail(history({ kind: 'aborted', reason: { kind: 'disposed' } }, { turn: 7 }));
  assert.equal(tail.kind, 'idle');
  assert.equal(tail.turn, 7);
  assert.equal(tail.seq, 4);
  assert.equal(tail.reason.kind, 'aborted');
});

test('空历史 / 没有 turn 的历史各自归类', () => {
  assert.equal(inspectTail([]).kind, 'empty');
  assert.equal(inspectTail(undefined).kind, 'empty');
  assert.equal(inspectTail([ev('session/title', {}, 0)]).kind, 'no-turn');
});

test('turn/end 之后还有 turn/start 说明有一轮正在跑，不该插手', () => {
  const events = [...history({ kind: 'aborted', reason: { kind: 'disposed' } }), ev('turn/start', { turn: 2 }, 5)];
  assert.equal(inspectTail(events).kind, 'running');
});

test('turn/end 之后只有非 turn 事件（step/end、job/settled 等）仍算空闲', () => {
  const events = [
    ...history({ kind: 'aborted', reason: { kind: 'disposed' } }),
    ev('job/settled', {}, 5),
    ev('session/end-seed', {}, 6),
  ];
  assert.equal(inspectTail(events).kind, 'idle');
});

// ---------------------------------------------------------------------------
// 幂等：不重复注入
// ---------------------------------------------------------------------------

test('inbox 里已有续跑提示时不再注入', () => {
  const pending = [{ id: 'n1', role: 'user', content: [], source: { kind: NUDGE_SOURCE_KIND } }];
  assert.equal(hasPendingNudge({ nextTurn: pending, nextStep: [] }), true);
  assert.equal(hasPendingNudge({ nextTurn: [], nextStep: pending }), true);
  assert.equal(hasPendingNudge({ nextTurn: [], nextStep: [] }), false);
  assert.equal(hasPendingNudge(undefined), false);
});

test('判定：已注入过 → skipped:already', () => {
  const inbox = { nextTurn: [{ id: 'n1', source: { kind: NUDGE_SOURCE_KIND } }], nextStep: [] };
  const verdict = planTurnContinuation({
    events: history({ kind: 'aborted', reason: { kind: 'disposed' } }),
    inbox,
    config: {},
  });
  assert.equal(verdict, 'skipped:already');
});

// ---------------------------------------------------------------------------
// 判定表
// ---------------------------------------------------------------------------

test('判定表：各分支取值', () => {
  const interrupted = history({ kind: 'aborted', reason: { kind: 'disposed' } });
  const cases = [
    [{ events: interrupted, config: { resumeInterruptedTurn: false } }, 'disabled'],
    [{ events: interrupted, config: {}, delegated: true }, 'skipped:delegated'],
    [{ events: [], config: {} }, 'skipped:empty'],
    [{ events: [ev('session/title', {}, 0)], config: {} }, 'skipped:no-turn'],
    [{ events: [...interrupted, ev('turn/start', { turn: 2 }, 5)], config: {} }, 'skipped:running'],
    [{ events: history({ kind: 'completed' }), config: {} }, 'skipped:clean'],
    [{ events: history({ kind: 'aborted', reason: { kind: 'user' } }), config: {} }, 'skipped:clean'],
    [{ events: interrupted, config: {} }, 'continue'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(planTurnContinuation(input), expected);
  }
});

// ---------------------------------------------------------------------------
// 消息形状：必须能通过 assertMessageEventShape
// ---------------------------------------------------------------------------

test('续跑消息形状合法：id 非空、role=user、source.kind 非空、content 是数组', () => {
  const message = buildContinuationMessage();
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 0);
  assert.equal(message.role, 'user');
  assert.equal(typeof message.source.kind, 'string');
  assert.ok(message.source.kind.length > 0);
  assert.ok(Array.isArray(message.content));
  assert.equal(message.content[0].type, 'text');
  assert.equal(message.content[0].text, CONTINUATION_TEXT);
});

test('两条消息的 id 必须不同（同 id 会被 inbox 判为重复待处理）', () => {
  assert.notEqual(buildContinuationMessage().id, buildContinuationMessage().id);
});

test('可以换文案，但空串回落默认', () => {
  assert.equal(buildContinuationMessage({ text: '接着做' }).content[0].text, '接着做');
  assert.equal(buildContinuationMessage({ text: '' }).content[0].text, CONTINUATION_TEXT);
});

// ---------------------------------------------------------------------------
// 端到端：假 agent
// ---------------------------------------------------------------------------

/** 假 agent，字段形状对齐 ReactLoopAgent 的运行时面。 */
function makeAgent({ events = [], nextTurn = [], withFollowup = true, withPrepend = false, withWake = false } = {}) {
  const log = [];
  const agent = {
    session: { id: 's1', header: {}, snapshotEvents: () => events },
    inbox: { nextTurn, nextStep: [] },
  };
  if (withPrepend) {
    agent.inbox.prepend = (target, message) => {
      log.push(`prepend:${target}:${message.source.kind}`);
      nextTurn.unshift(message);
    };
  }
  if (withWake) {
    agent.wakeDriver = () => log.push('wakeDriver');
  }
  if (withFollowup) {
    agent.followup = (message) => {
      log.push(`followup:${message.source.kind}`);
      nextTurn.push(message);
    };
  }
  return { agent, log };
}

test('resume + 打断态 → 注入一条续跑提示', () => {
  const { agent, log } = makeAgent({ events: history({ kind: 'aborted', reason: { kind: 'disposed' } }) });
  const result = continueInterruptedTurn({ agent, source: 'resume' }, cfg, quiet);
  assert.equal(result, 'continued');
  assert.deepEqual(log, [`followup:${NUDGE_SOURCE_KIND}`]);
  assert.equal(agent.inbox.nextTurn.length, 1);
});

test('有 prepend + wakeDriver 时插队首并叫醒（否则会先跑后来提交的消息）', () => {
  const { agent, log } = makeAgent({
    events: history({ kind: 'aborted', reason: { kind: 'disposed' } }),
    nextTurn: [{ id: 'later-1', source: { kind: 'user' } }, { id: 'later-2', source: { kind: 'user' } }],
    withPrepend: true,
    withWake: true,
  });
  assert.equal(continueInterruptedTurn({ agent, source: 'resume' }, cfg, quiet), 'continued');
  assert.deepEqual(log, [`prepend:next-turn:${NUDGE_SOURCE_KIND}`, 'wakeDriver']);
  const ids = agent.inbox.nextTurn.map((m) => m.id);
  assert.equal(ids.length, 3);
  assert.equal(agent.inbox.nextTurn[0].source.kind, NUDGE_SOURCE_KIND, '续跑提示必须排在队首');
  assert.deepEqual(ids.slice(1), ['later-1', 'later-2'], '后来提交的消息顺序不变');
});

test('startup 不动手：新建会话没有「被打断的上一轮」', () => {
  const { agent, log } = makeAgent({ events: history({ kind: 'aborted', reason: { kind: 'disposed' } }) });
  assert.equal(continueInterruptedTurn({ agent, source: 'startup' }, cfg, quiet), 'skipped:source');
  assert.deepEqual(log, []);
});

test('正常结束的会话不动手', () => {
  const { agent, log } = makeAgent({ events: history({ kind: 'completed' }) });
  assert.equal(continueInterruptedTurn({ agent, source: 'resume' }, cfg, quiet), 'skipped:clean');
  assert.deepEqual(log, []);
});

test('resumeInterruptedTurn=false 时完全不碰', () => {
  const { agent, log } = makeAgent({ events: history({ kind: 'aborted', reason: { kind: 'disposed' } }) });
  const result = continueInterruptedTurn({ agent, source: 'resume' }, () => ({ resumeInterruptedTurn: false }), quiet);
  assert.equal(result, 'disabled');
  assert.deepEqual(log, []);
});

test('委派会话不续跑：替子代理烧额度没有意义', () => {
  const { agent, log } = makeAgent({ events: history({ kind: 'aborted', reason: { kind: 'disposed' } }) });
  const deps = { ...quiet, isDelegatedSession: () => true };
  assert.equal(continueInterruptedTurn({ agent, source: 'resume' }, cfg, deps), 'skipped:delegated');
  assert.deepEqual(log, []);
});

test('读不到 session 时安静跳过（不在公开类型面上）', () => {
  // 注意判定顺序：先查投递通道再查历史 —— 送不出去就不必去读日志。
  const canDeliver = { followup: () => {} };
  assert.equal(continueInterruptedTurn({ agent: canDeliver, source: 'resume' }, cfg, quiet), 'skipped:no-session');
  assert.equal(continueInterruptedTurn({ agent: {}, source: 'resume' }, cfg, quiet), 'skipped:no-transport');
  assert.equal(continueInterruptedTurn({ agent: null, source: 'resume' }, cfg, quiet), 'skipped:no-agent');
  assert.equal(continueInterruptedTurn(undefined, cfg, quiet), 'skipped:source');
});

test('session 取值抛错不外泄', () => {
  const agent = {
    get session() {
      throw new Error('boom');
    },
    followup: () => {},
  };
  assert.equal(continueInterruptedTurn({ agent, source: 'resume' }, cfg, quiet), 'skipped:no-session');
});

test('snapshotEvents 抛错时记一条 warn 并跳过', () => {
  const warnings = [];
  const agent = {
    session: {
      snapshotEvents: () => {
        throw new Error('log gone');
      },
    },
    followup: () => {},
  };
  const deps = { logger: { info: () => {}, warn: (m) => warnings.push(m) } };
  assert.equal(continueInterruptedTurn({ agent, source: 'resume' }, cfg, deps), 'skipped:no-session');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /log gone/u);
});

test('没有 followup 时不动手（不能先判后弃）', () => {
  const { agent, log } = makeAgent({
    events: history({ kind: 'aborted', reason: { kind: 'disposed' } }),
    withFollowup: false,
  });
  assert.equal(continueInterruptedTurn({ agent, source: 'resume' }, cfg, quiet), 'skipped:no-transport');
  assert.deepEqual(log, []);
});

test('followup 自己抛错时吞掉：监听器抛错会让整次 resume 失败', () => {
  const warnings = [];
  const { agent } = makeAgent({ events: history({ kind: 'aborted', reason: { kind: 'disposed' } }) });
  agent.followup = () => {
    throw new Error('transport exploded');
  };
  const deps = { logger: { info: () => {}, warn: (m) => warnings.push(m) } };
  assert.equal(continueInterruptedTurn({ agent, source: 'resume' }, cfg, deps), 'error');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /transport exploded/u);
});

test('配置读取本身抛错也不外泄', () => {
  const { agent } = makeAgent({ events: history({ kind: 'aborted', reason: { kind: 'disposed' } }) });
  assert.equal(continueInterruptedTurn({ agent, source: 'resume' }, () => {
    throw new Error('config exploded');
  }, quiet), 'error');
});

// ---------------------------------------------------------------------------
// 日志文案
// ---------------------------------------------------------------------------

test('reason 转成一句话', () => {
  assert.equal(describeReason({ kind: 'aborted', reason: { kind: 'disposed' } }), 'aborted/disposed');
  assert.equal(describeReason({ kind: 'interrupted' }), 'interrupted');
  assert.equal(describeReason({ kind: 'error', error: { code: 'TOOL_ACTIVATION' } }), 'error/TOOL_ACTIVATION');
  assert.equal(describeReason({ kind: 'completed' }), 'completed');
  assert.equal(describeReason(null), 'unknown');
});
