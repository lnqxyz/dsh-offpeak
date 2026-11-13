// 两条 HTTP 路由的单测。
//
// 不起真服务、不绑端口：`createRoutes` 把 handler 单独交出来，这里拿假 req/res
// 直接调。校验逻辑、响应形状、异常兜底因此都在覆盖范围内，而测试本身不需要
// 任何网络权限，也不会因为端口被占而随机失败。
import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_PATH, ROUTE_HEADER, createGate, createRoutes, normalizeConfig } from '../lib/index.js';
import { zonedInstant } from '../lib/peak-window.js';

/** 落在拦截范围内的一对（provider, model）：高峰时会被扣住（0.1.17，用户 2026-11-13 拍板）。 */
const HELD_PROVIDER = 'workbuddy';
const HELD_MODEL = 'deepseek-chat';

function sh(year, month, day, hour, minute = 0) {
  return zonedInstant(year, month, day, hour, minute, 'Asia/Shanghai');
}

/** 2026-11-11 周三 10:00，处在上午高峰内。 */
const PEAK_NOW = sh(2026, 11, 11, 10, 0);

/** 造一个只收内容的假响应。 */
function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      this.headersSent = true;
    },
    setHeader(name, value) {
      this.headers = { ...(this.headers ?? {}), [name]: value };
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      this.writableEnded = true;
    },
  };
}

function makeReq({ url, method = 'GET', headers = {} } = {}) {
  return { url, method, headers };
}

/** 一条默认合法的请求头：带自定义头，Host 是本机。 */
function goodHeaders(extra = {}) {
  return { [ROUTE_HEADER]: '1', host: '127.0.0.1:61591', ...extra };
}

/** 解析响应体；顺手断言它是合法 JSON。 */
function bodyOf(res) {
  return JSON.parse(res.body);
}

function statusUrl(sessionId = 's-root') {
  return `${BASE_PATH}/status?sessionId=${encodeURIComponent(sessionId)}`;
}

function releaseUrl(sessionId = 's-root') {
  return `${BASE_PATH}/release?sessionId=${encodeURIComponent(sessionId)}`;
}

function toggleUrl(sessionId = 's-root', enabled = '0') {
  return `${BASE_PATH}/toggle?sessionId=${encodeURIComponent(sessionId)}&enabled=${enabled}`;
}

/** 让出几个事件循环轮次，等异步生成器真正跑到 await 处。 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 造一个带假时钟的 gate，与 gate.test.mjs 同款。 */
function makeGate(configOverrides = {}, depsOverrides = {}) {
  const config = normalizeConfig(configOverrides);
  const calls = [];
  const gate = createGate(
    () => config,
    {
      getSession: () => ({ header: { version: 4, id: 's-root' } }),
      isAgentLoopRequest: () => true,
      logger: { info: (message) => calls.push(message), warn: (message) => calls.push(message) },
      ...depsOverrides,
    },
  );
  return { gate, config, calls };
}

// ---------------------------------------------------------------------------
// 请求校验
// ---------------------------------------------------------------------------

test('缺 x-dsh-offpeak 头 → 403', () => {
  const { gate } = makeGate({ peakWindows: [] });
  const routes = createRoutes(gate);
  const res = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: { host: '127.0.0.1:61591' } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(bodyOf(res).error, 'forbidden');
});

test('自定义头为空串也算没带 → 403', () => {
  const { gate } = makeGate({ peakWindows: [] });
  const routes = createRoutes(gate);
  const res = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: { [ROUTE_HEADER]: '', host: '127.0.0.1:61591' } }), res);
  assert.equal(res.statusCode, 403);
});

test('非本机 Host → 403', () => {
  const { gate } = makeGate({ peakWindows: [] });
  const routes = createRoutes(gate);
  for (const host of ['evil.example.com', '8.8.8.8:80', '172.32.0.1:8080', '']) {
    const res = makeRes();
    routes.status(makeReq({ url: statusUrl(), headers: goodHeaders({ host }) }), res);
    assert.equal(res.statusCode, 403, `Host=${JSON.stringify(host)} 应被拒`);
  }
});

test('本机地址的各种合法写法都能过 Host 检查', () => {
  const { gate } = makeGate({ peakWindows: [] });
  const routes = createRoutes(gate);
  for (const host of [
    '127.0.0.1:61591',
    '127.1.2.3',
    'localhost:3000',
    '[::1]:8080',
    '10.0.0.5:80',
    '192.168.1.20:8080',
    '172.16.0.1',
    '172.31.255.254',
    '169.254.10.10',
    'my-mac.local:8080',
  ]) {
    const res = makeRes();
    routes.status(makeReq({ url: statusUrl(), headers: goodHeaders({ host }) }), res);
    assert.equal(res.statusCode, 200, `Host=${host} 应被接受`);
  }
});

test('跨源 Origin → 403', () => {
  const { gate } = makeGate({ peakWindows: [] });
  const routes = createRoutes(gate);
  for (const origin of ['http://evil.example.com', 'http://127.0.0.1:9999', 'null', 'not-an-address']) {
    const res = makeRes();
    routes.status(makeReq({ url: statusUrl(), headers: goodHeaders({ origin }) }), res);
    assert.equal(res.statusCode, 403, `Origin=${origin} 应被拒`);
  }
});

test('Origin 与 Host 同源或为空时放行', () => {
  const { gate } = makeGate({ peakWindows: [] });
  const routes = createRoutes(gate);

  // 空 Origin：非浏览器发起的请求，只靠 Host 判断。
  const noOrigin = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders({ origin: '' }) }), noOrigin);
  assert.equal(noOrigin.statusCode, 200);

  // 同源：Origin 的 host 必须与请求 Host 完全一致（含端口）才算同源。
  for (const [origin, host] of [
    ['http://127.0.0.1:61591', '127.0.0.1:61591'],
    ['http://localhost:3000', 'localhost:3000'],
    ['http://[::1]:8080', '[::1]:8080'],
  ]) {
    const res = makeRes();
    routes.status(makeReq({ url: statusUrl(), headers: goodHeaders({ origin, host }) }), res);
    assert.equal(res.statusCode, 200, `Origin=${origin} + Host=${host} 应被接受`);
  }
});

test('缺 sessionId → 400（三条路由都是）', () => {
  const { gate } = makeGate({ peakWindows: [] });
  const routes = createRoutes(gate);

  for (const url of [`${BASE_PATH}/status`, `${BASE_PATH}/status?sessionId=`, `${BASE_PATH}/status?sessionId=%20`]) {
    const res = makeRes();
    routes.status(makeReq({ url, headers: goodHeaders() }), res);
    assert.equal(res.statusCode, 400, `${url} 应 400`);
    assert.equal(bodyOf(res).error, 'sessionId');
  }

  const res = makeRes();
  routes.release(makeReq({ url: `${BASE_PATH}/release`, method: 'POST', headers: goodHeaders() }), res);
  assert.equal(res.statusCode, 400);

  const toggleRes = makeRes();
  routes.toggle(makeReq({ url: `${BASE_PATH}/toggle`, method: 'POST', headers: goodHeaders() }), toggleRes);
  assert.equal(toggleRes.statusCode, 400);
  assert.equal(bodyOf(toggleRes).error, 'sessionId');
});

test('方法不对 → 405', () => {
  const { gate } = makeGate({ peakWindows: [] });
  const routes = createRoutes(gate);

  const statusRes = makeRes();
  routes.status(makeReq({ url: statusUrl(), method: 'POST', headers: goodHeaders() }), statusRes);
  assert.equal(statusRes.statusCode, 405);

  const releaseRes = makeRes();
  routes.release(makeReq({ url: releaseUrl(), method: 'GET', headers: goodHeaders() }), releaseRes);
  assert.equal(releaseRes.statusCode, 405);

  const toggleRes = makeRes();
  routes.toggle(makeReq({ url: toggleUrl(), method: 'GET', headers: goodHeaders() }), toggleRes);
  assert.equal(toggleRes.statusCode, 405);
});

test('toggle 的 enabled 缺失或含糊 → 400', () => {
  const { gate } = makeGate({ peakWindows: [] });
  const routes = createRoutes(gate);
  for (const url of [
    `${BASE_PATH}/toggle?sessionId=s-root`,
    `${BASE_PATH}/toggle?sessionId=s-root&enabled=`,
    `${BASE_PATH}/toggle?sessionId=s-root&enabled=maybe`,
  ]) {
    const res = makeRes();
    routes.toggle(makeReq({ url, method: 'POST', headers: goodHeaders() }), res);
    assert.equal(res.statusCode, 400, `${url} 应 400`);
    assert.equal(bodyOf(res).error, 'enabled');
  }
});

test('toggle 缺自定义头 / 跨源 → 403', () => {
  const { gate } = makeGate({ peakWindows: [] });
  const routes = createRoutes(gate);

  const noHeader = makeRes();
  routes.toggle(makeReq({ url: toggleUrl(), method: 'POST', headers: { host: '127.0.0.1:61591' } }), noHeader);
  assert.equal(noHeader.statusCode, 403);

  const crossOrigin = makeRes();
  routes.toggle(
    makeReq({ url: toggleUrl(), method: 'POST', headers: goodHeaders({ origin: 'http://evil.example.com' }) }),
    crossOrigin,
  );
  assert.equal(crossOrigin.statusCode, 403);
});

test('三条路由的响应都带 JSON content-type 与 no-store', () => {
  const { gate } = makeGate({ peakWindows: [] });
  const routes = createRoutes(gate);

  const statusRes = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), statusRes);
  assert.equal(statusRes.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(statusRes.headers['cache-control'], 'no-store');

  const releaseRes = makeRes();
  routes.release(makeReq({ url: releaseUrl(), method: 'POST', headers: goodHeaders() }), releaseRes);
  assert.equal(releaseRes.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(releaseRes.headers['cache-control'], 'no-store');

  const toggleRes = makeRes();
  routes.toggle(makeReq({ url: toggleUrl(), method: 'POST', headers: goodHeaders() }), toggleRes);
  assert.equal(toggleRes.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(toggleRes.headers['cache-control'], 'no-store');
});

// ---------------------------------------------------------------------------
// 状态形状
// ---------------------------------------------------------------------------

test('低谷时 status 返回 peak:false、waiting:false、releaseAt:null', () => {
  // 空窗口表 = 永远低谷，与测试跑在几点无关。
  const { gate } = makeGate({ peakWindows: [] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  const res = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), res);

  assert.equal(res.statusCode, 200);
  const body = bodyOf(res);
  assert.equal(body.peak, false);
  assert.equal(body.waiting, false);
  assert.equal(body.releaseAt, null);
  assert.equal(body.releaseLabel, null);
  assert.equal(body.enabled, true);
  assert.equal(body.dryRun, false);
});

test('高峰时 status 返回 peak:true，releaseAt 是未来时刻', () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  const res = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), res);

  const body = bodyOf(res);
  assert.equal(body.peak, true);
  assert.equal(body.waiting, false, '没人等的时候不该报 waiting');
  assert.equal(typeof body.releaseAt, 'number');
  assert.ok(body.releaseAt > PEAK_NOW.getTime(), 'releaseAt 必须是将来的时刻');
  // 上午高峰 10:00 → 12:00 放行
  assert.equal(body.releaseAt, sh(2026, 11, 11, 12, 0).getTime());
  assert.equal(body.releaseLabel, '12:00');
});

test('status 里的 now 是宿主当前时刻，不是会话里的', () => {
  const { gate } = makeGate({ peakWindows: [] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  const res = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), res);
  assert.equal(bodyOf(res).now, PEAK_NOW.getTime());
});

test('dryRun 时 status 如实报告 dryRun:true', () => {
  const { gate } = makeGate({ dryRun: true }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  const res = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), res);
  assert.equal(bodyOf(res).dryRun, true);
});

test('enabled:false 时 status 报告 enabled:false', () => {
  const { gate } = makeGate({ enabled: false }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  const res = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), res);
  assert.equal(bodyOf(res).enabled, false);
});

test('不同会话的状态互不串台', () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);

  // 先让 s-a 进入等待
  const pending = drain(gate.listener(
    { sessionId: 's-a', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal },
    () => (async function* () { yield { type: 'chunk' }; })(),
  ));
  return tick().then(() => {
    const resA = makeRes();
    routes.status(makeReq({ url: statusUrl('s-a'), headers: goodHeaders() }), resA);
    assert.equal(bodyOf(resA).waiting, true);

    const resB = makeRes();
    routes.status(makeReq({ url: statusUrl('s-b'), headers: goodHeaders() }), resB);
    assert.equal(bodyOf(resB).waiting, false, 's-b 不该被 s-a 的等待带成 waiting');

    gate.releaseNow('s-a');
    return pending;
  });
});

// ---------------------------------------------------------------------------
// 会话级开关（0.1.8）
// ---------------------------------------------------------------------------

test('status 里 sessionEnabled 默认 true', () => {
  const { gate } = makeGate({ peakWindows: [] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  const res = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), res);
  assert.equal(bodyOf(res).sessionEnabled, true);
});

test('toggle 关掉本会话后 status 报 sessionEnabled:false，别的会话仍是 true', () => {
  const { gate } = makeGate({ peakWindows: [] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);

  const res = makeRes();
  routes.toggle(makeReq({ url: toggleUrl('s-root', '0'), method: 'POST', headers: goodHeaders() }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(bodyOf(res).ok, true);
  assert.equal(bodyOf(res).sessionEnabled, false);

  const root = makeRes();
  routes.status(makeReq({ url: statusUrl('s-root'), headers: goodHeaders() }), root);
  assert.equal(bodyOf(root).sessionEnabled, false);

  const other = makeRes();
  routes.status(makeReq({ url: statusUrl('s-other'), headers: goodHeaders() }), other);
  assert.equal(bodyOf(other).sessionEnabled, true, '开关必须按会话隔离');

  // 再打开
  const back = makeRes();
  routes.toggle(makeReq({ url: toggleUrl('s-root', '1'), method: 'POST', headers: goodHeaders() }), back);
  assert.equal(back.statusCode, 200);
  assert.equal(bodyOf(back).sessionEnabled, true);
});

test('toggle 主会话后，子代理的 status 继承「关」并标记 inheritedOff', () => {
  const sessions = new Map([
    ['s-root', { header: { version: 4, id: 's-root' } }],
    ['s-sub', { header: { version: 4, id: 's-sub', origin: 'subagent', parentSession: 's-root' } }],
  ]);
  const { gate } = makeGate(
    { peakWindows: [] },
    { now: () => PEAK_NOW, getSession: (id) => sessions.get(id) },
  );
  const routes = createRoutes(gate);

  const res = makeRes();
  routes.toggle(makeReq({ url: toggleUrl('s-root', '0'), method: 'POST', headers: goodHeaders() }), res);
  assert.equal(res.statusCode, 200);

  const sub = makeRes();
  routes.status(makeReq({ url: statusUrl('s-sub'), headers: goodHeaders() }), sub);
  assert.equal(bodyOf(sub).sessionEnabled, false, '子代理应继承主会话的「关」');
  assert.equal(bodyOf(sub).inheritedOff, true, '界面据此把子代理的开关置灰');

  const rootOn = makeRes();
  routes.toggle(makeReq({ url: toggleUrl('s-root', '1'), method: 'POST', headers: goodHeaders() }), rootOn);
  const subBack = makeRes();
  routes.status(makeReq({ url: statusUrl('s-sub'), headers: goodHeaders() }), subBack);
  assert.equal(bodyOf(subBack).sessionEnabled, true);
  assert.equal(bodyOf(subBack).inheritedOff, false);
});

test('开关关掉时本会话的调用直接透传，不再排队', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  gate.setSessionEnabled('s-root', false);

  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'pass' }; })();
  };
  const out = await drain(
    gate.listener({ sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal }, next),
  );
  assert.deepEqual(out, [{ type: 'pass' }]);
  assert.equal(called, 1, '关掉的会话必须立刻调下游');
});

test('重新打开后本会话恢复在高峰排队', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);

  const off = makeRes();
  routes.toggle(makeReq({ url: toggleUrl('s-root', '0'), method: 'POST', headers: goodHeaders() }), off);
  const on = makeRes();
  routes.toggle(makeReq({ url: toggleUrl('s-root', '1'), method: 'POST', headers: goodHeaders() }), on);

  const controller = new AbortController();
  let called = 0;
  const pending = drain(gate.listener(
    { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: controller.signal },
    () => {
      called += 1;
      return (async function* () { yield { type: 'chunk' }; })();
    },
  ));
  await tick();
  assert.equal(called, 0, '重新打开后应重新排队');
  controller.abort(Object.assign(new Error('stop'), { name: 'AbortError' }));
  await assert.rejects(pending);
});

test('关掉开关会立刻放行本会话正在排队的调用', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);

  let called = 0;
  const pending = drain(gate.listener(
    { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal },
    () => {
      called += 1;
      return (async function* () { yield { type: 'chunk' }; })();
    },
  ));
  await tick();
  assert.equal(called, 0);

  const res = makeRes();
  routes.toggle(makeReq({ url: toggleUrl('s-root', '0'), method: 'POST', headers: goodHeaders() }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(bodyOf(res).woken, 1);

  assert.deepEqual(await pending, [{ type: 'chunk' }]);
  assert.equal(called, 1);

  const after = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), after);
  assert.equal(bodyOf(after).waiting, false);
});

// ---------------------------------------------------------------------------
// 等待中
// ---------------------------------------------------------------------------

/** 把异步可迭代对象抽干，用来把等待推进到真正开始。 */
async function drain(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

test('有调用在等时 status 返回 waiting:true 与真实 releaseAt', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  const controller = new AbortController();
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };

  const pending = drain(gate.listener({ sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: controller.signal }, next));
  await tick();

  const res = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), res);
  const body = bodyOf(res);
  assert.equal(body.waiting, true);
  assert.equal(body.releaseAt, sh(2026, 11, 11, 12, 0).getTime(), 'releaseAt 应是这个调用实际排到的时刻');
  assert.equal(body.releaseLabel, '12:00');
  assert.equal(body.heldModel, HELD_MODEL, '0.1.17 起要能看出扣住的是哪个模型');
  assert.equal(body.heldProvider, HELD_PROVIDER, '0.1.17 起要能看出扣住的是哪个通道');
  assert.equal(called, 0, '等待中不得调用下游');

  controller.abort(Object.assign(new Error('stop'), { name: 'AbortError' }));
  await assert.rejects(pending);
});

test('通道不对的 deepseek 模型在高峰不被扣住：status 里既没有 waiting 也没有 heldModel', async () => {
  // 双条件（用户 2026-11-13 拍板）：模型是 deepseek，但 provider=qwenwork 没折扣，
  // 高峰必须立即放行。界面读的是同一个 status，所以这里要确认它不会误报「已排队」。
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };

  await drain(gate.listener(
    { sessionId: 's-root', provider: 'qwenwork', model: 'deepseek-chat', signal: new AbortController().signal },
    next,
  ));
  assert.equal(called, 1, '通道没折扣的 deepseek 模型必须立刻调下游');

  const res = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), res);
  const body = bodyOf(res);
  assert.equal(body.waiting, false);
  assert.equal(body.heldModel, null);
  assert.equal(body.heldProvider, null);
  assert.equal(body.peak, true, '此刻确实是高峰，放行是因为 provider 不在范围内');
});

test('status 响应形状不因收窄拦截范围而丢字段', async () => {
  // 客户端半插件按字段名读，少一个就会退化。这里把既有字段全列出来对一遍。
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  const res = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), res);
  const body = bodyOf(res);
  for (const field of [
    'enabled', 'dryRun', 'sessionEnabled', 'inheritedOff', 'peak',
    'waiting', 'bypassing', 'releaseAt', 'releaseLabel', 'judge', 'version',
    'heldModel', 'heldProvider', 'now',
  ]) {
    assert.ok(Object.hasOwn(body, field), `status 缺字段 ${field}`);
  }
});

test('等待被 abort 后 waiting 立刻回到 false', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  const controller = new AbortController();

  const pending = drain(gate.listener(
    { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: controller.signal },
    () => (async function* () { yield { type: 'chunk' }; })(),
  ));
  await tick();

  const during = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), during);
  assert.equal(bodyOf(during).waiting, true);

  controller.abort(Object.assign(new Error('stop'), { name: 'AbortError' }));
  await assert.rejects(pending);

  const after = makeRes();
  routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), after);
  const body = bodyOf(after);
  assert.equal(body.waiting, false, 'abort 之后等待表必须被清掉');
  assert.equal(gate.waiting.size, 0, '等待表不该留下空 Set');
});

test('release 能唤醒等待中的调用并返回 woken', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  let called = 0;
  const next = () => {
    called += 1;
    return (async function* () { yield { type: 'chunk' }; })();
  };

  const pending = drain(gate.listener(
    { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal },
    next,
  ));
  await tick();
  assert.equal(called, 0);

  const res = makeRes();
  routes.release(makeReq({ url: releaseUrl(), method: 'POST', headers: goodHeaders() }), res);
  assert.equal(res.statusCode, 200);
  const body = bodyOf(res);
  assert.equal(body.ok, true);
  assert.ok(body.woken >= 1, `应至少唤醒 1 个调用，实际 ${body.woken}`);

  assert.deepEqual(await pending, [{ type: 'chunk' }]);
  assert.equal(called, 1);
});

test('没有调用在等时 release 也返回 ok，woken 为 0', () => {
  const { gate } = makeGate({ peakWindows: [] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  const res = makeRes();
  routes.release(makeReq({ url: releaseUrl(), method: 'POST', headers: goodHeaders() }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(bodyOf(res), { ok: true, woken: 0 });
});

test('release 之后等待表同样被清空', async () => {
  const { gate } = makeGate({ releaseJitterSeconds: [0, 0] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);

  const pending = drain(gate.listener(
    { sessionId: 's-root', provider: HELD_PROVIDER, model: HELD_MODEL, signal: new AbortController().signal },
    () => (async function* () { yield { type: 'chunk' }; })(),
  ));
  await tick();

  routes.release(makeReq({ url: releaseUrl(), method: 'POST', headers: goodHeaders() }), makeRes());
  await pending;
  assert.equal(gate.waiting.size, 0);
});

// ---------------------------------------------------------------------------
// 异常兜底
// ---------------------------------------------------------------------------

test('handler 内部抛异常 → 500 JSON，而不是抛给宿主', () => {
  const exploding = {
    status() {
      throw new Error('boom');
    },
    releaseNow() {
      throw new Error('boom');
    },
    now: () => Date.now(),
  };
  const routes = createRoutes(exploding);

  const statusRes = makeRes();
  assert.doesNotThrow(() => {
    routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), statusRes);
  });
  assert.equal(statusRes.statusCode, 500);
  assert.equal(bodyOf(statusRes).error, 'internal');
  assert.match(bodyOf(statusRes).detail, /boom/);

  const releaseRes = makeRes();
  assert.doesNotThrow(() => {
    routes.release(makeReq({ url: releaseUrl(), method: 'POST', headers: goodHeaders() }), releaseRes);
  });
  assert.equal(releaseRes.statusCode, 500);
  assert.equal(bodyOf(releaseRes).error, 'internal');
});

test('响应已结束时再写不抛异常', () => {
  const { gate } = makeGate({ peakWindows: [] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  const res = makeRes();
  res.writableEnded = true;
  assert.doesNotThrow(() => {
    routes.status(makeReq({ url: statusUrl(), headers: goodHeaders() }), res);
  });
  assert.equal(res.statusCode, null, '已结束的响应不该再写头');
});

test('req 形状残缺也不抛异常（缺失 headers / url）', () => {
  const { gate } = makeGate({ peakWindows: [] }, { now: () => PEAK_NOW });
  const routes = createRoutes(gate);
  for (const req of [{}, { headers: {} }, { url: statusUrl() }]) {
    const res = makeRes();
    assert.doesNotThrow(() => routes.status(req, res));
    assert.equal(res.statusCode, 403, '没有可验证的请求头一律拒绝');
  }
});
