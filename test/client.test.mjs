// 客户端半插件（lib/client.js）的测试。
//
// 那段代码是给浏览器用的，靠 `window.__ModuleLoader__.load()` 注册，本身不是 ESM 模块，
// 也没有导出。所以这里不装 jsdom，而是做四件事：
//   1. 用一个假的 __ModuleLoader__ 抓住它注册的 spec，证明「文件能被加载」；
//   2. 用假的 require 喂一个**迷你 React 运行时**（只实现 useState / useEffect /
//      createElement，带 hook 状态与依赖比对），真的把组件渲染成一棵元素树，
//      再从树里收可见文字 —— v0.1.18 去掉状态文案后，断言的是「渲染出来到底有
//      哪些字」，只测纯函数测不到这件事；
//   3. 桩掉 fetch 与 setInterval，让首轮状态读取、轮询与「立即运行」点击可控；
//   4. 用一个假 ctx 跑一遍 apply，验证挂载到哪个 slot、传了哪些注入。
import test from 'node:test';
import assert from 'node:assert/strict';

let spec;
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => {
      spec = value;
    },
  },
};

await import('../lib/client.js');

// 非渲染用例只用到 readStatus / apply，喂一个最简 React 即可。
const fakeReact = {
  createElement: (...args) => ({ type: typeof args[0] === 'string' ? args[0] : 'component', args }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
};

const mod = spec.factory((name) => {
  if (name === 'react') return fakeReact;
  throw new Error('unexpected require ' + name);
});

/* ------------------------------------------------------------------ *
 * 迷你 React 运行时 + 渲染辅助
 * ------------------------------------------------------------------ */

const BASE_STATUS = {
  enabled: true,
  sessionEnabled: true,
  inheritedOff: false,
  dryRun: false,
  peak: false,
  waiting: false,
  bypassing: false,
  releaseLabel: null,
};

// 收集元素树里的可见文字，按出现顺序。
function collectTexts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectTexts(child, out);
    return out;
  }
  for (const child of node.children) collectTexts(child, out);
  return out;
}

// 按可见文字找一个 button 元素。
function findButton(node, label) {
  if (node === null || node === undefined || node === false) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return null;
  }
  if (node.type === 'button' && collectTexts(node).join('') === label) return node;
  return findButton(node.children, label);
}

// 每次都重建一份 React 闭包，hook 状态不跨用例泄漏。
function createRuntime() {
  const hooks = [];
  let cursor = 0;
  let dirty = false;
  let props = null;
  let tree = null;
  let Component = null;

  const createElement = (type, elProps, ...children) => ({
    type,
    props: elProps || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  });

  function useState(initial) {
    const i = cursor++;
    if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
    const cell = hooks[i];
    const set = (next) => {
      const value = typeof next === 'function' ? next(cell.value) : next;
      if (Object.is(value, cell.value)) return;
      cell.value = value;
      dirty = true;
    };
    return [cell.value, set];
  }

  function useEffect(fn, deps) {
    const i = cursor++;
    if (!hooks[i]) hooks[i] = { deps: undefined, pending: null };
    const cell = hooks[i];
    const same = Array.isArray(deps) && Array.isArray(cell.deps)
      && deps.length === cell.deps.length
      && deps.every((d, k) => Object.is(d, cell.deps[k]));
    if (same) return;
    cell.deps = Array.isArray(deps) ? deps.slice() : undefined;
    cell.pending = fn;
  }

  function render() {
    cursor = 0;
    dirty = false;
    tree = Component(props);
    for (const cell of hooks) {
      if (cell && cell.pending) {
        const fn = cell.pending;
        cell.pending = null;
        fn();
      }
    }
  }

  const React = { createElement, useState, useEffect };
  const runtimeMod = spec.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require ' + name);
  });
  runtimeMod.apply({
    slots: {
      register: (def, comp) => {
        Component = comp;
        return () => {};
      },
      inject: (name, cb) => {
        cb();
        return () => {};
      },
    },
    effect: (fn) => fn(),
  });

  const flush = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (dirty) render();
    }
  };

  return {
    mount(p) {
      props = p;
      render();
    },
    flush,
    get tree() {
      return tree;
    },
  };
}

/**
 * 起一个受控的渲染环境：桩 fetch / setInterval，挂载后把首轮读取跑完。
 * `options.fetch` 收 (url, init) 并返回 fetch 形状的对象；默认回 options.status。
 */
async function withHarness(options, run) {
  const rt = createRuntime();
  const prevFetch = globalThis.fetch;
  const prevSetInterval = globalThis.setInterval;
  const prevClearInterval = globalThis.clearInterval;
  const timers = [];
  const fetchLog = [];

  globalThis.setInterval = (cb) => {
    timers.push(cb);
    return timers.length;
  };
  globalThis.clearInterval = () => {};
  globalThis.fetch = async (url, init) => {
    fetchLog.push({ url, init });
    return options.fetch(url, init);
  };

  try {
    rt.mount(options.props || { sessionId: 's-1' });
    await rt.flush();
    return await run({
      rt,
      timers,
      fetchLog,
      texts: () => collectTexts(rt.tree),
    });
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.setInterval = prevSetInterval;
    globalThis.clearInterval = prevClearInterval;
  }
}

// 固定的状态响应。
const respondWith = (status) => async () => ({ ok: true, json: async () => status });

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

test('注册契约：id 与 inject/apply 形状', () => {
  assert.equal(spec.id, 'dsh-offpeak');
  assert.ok(Array.isArray(mod.inject));
  assert.ok(mod.inject.includes('slots'));
  assert.equal(typeof mod.apply, 'function');
});

test('导出：只保留 readStatus，hintText 随状态文案一起移除', () => {
  assert.equal(typeof mod.readStatus, 'function');
  assert.equal(mod.hintText, undefined, 'hintText 已删除，不应再悬空导出');
  assert.deepEqual(Object.keys(mod).sort(), ['apply', 'inject', 'readStatus']);
});

test('任何状态下只渲染「错峰发送」，没有任何状态解释', async () => {
  const cases = [
    ['低谷', { ...BASE_STATUS }],
    ['高峰', { ...BASE_STATUS, peak: true, releaseLabel: '12:01' }],
    ['已排队', { ...BASE_STATUS, peak: true, waiting: true, releaseLabel: '12:01' }],
    ['本会话关', { ...BASE_STATUS, sessionEnabled: false }],
    ['跟随主会话关', { ...BASE_STATUS, sessionEnabled: false, inheritedOff: true }],
    ['演练中', { ...BASE_STATUS, dryRun: true }],
    ['总开关关', { ...BASE_STATUS, enabled: false }],
  ];

  for (const [name, status] of cases) {
    await withHarness({ fetch: respondWith(status) }, async ({ texts }) => {
      const expected = status.waiting === true
        ? ['错峰发送', '立即运行']
        : ['错峰发送'];
      assert.deepEqual(texts(), expected, name + '：可见文字只应有开关（等待时加按钮）');
    });
  }
});

test('开关按钮：可见文字与 aria-label 仍是「错峰发送」', async () => {
  await withHarness(
    { fetch: respondWith({ ...BASE_STATUS, peak: true, releaseLabel: '12:01' }) },
    async ({ rt, texts }) => {
      assert.deepEqual(texts(), ['错峰发送']);
      const button = findButton(rt.tree, '错峰发送');
      assert.ok(button, '应渲染出角色为 switch 的开关按钮');
      assert.equal(button.props.role, 'switch');
      assert.equal(button.props['aria-label'], '错峰发送');
    },
  );
});

// 0.1.19 的观感重做：照 iOS UISwitch 的 51×31 / 27 圆点来做，开蓝关黑。
// 这些是「看起来对不对」的硬指标，靠截图只能看一次；写成断言才能防回退。
test('iOS 风格开关：51×31 胶囊、开蓝关黑、27px 白圆点带 0.2s 过渡', async () => {
  const cases = [
    ['开', { ...BASE_STATUS }, '#007AFF', '22px'],
    ['关', { ...BASE_STATUS, sessionEnabled: false }, '#000000', '2px'],
  ];

  for (const [name, status, fill, knobLeft] of cases) {
    await withHarness({ fetch: respondWith(status) }, async ({ rt }) => {
      const button = findButton(rt.tree, '错峰发送');
      const track = button.children[0];
      const knob = track.children[0];

      assert.equal(track.props['aria-hidden'], 'true');
      assert.equal(track.props.style.width, '51px', name + '：轨道宽 51');
      assert.equal(track.props.style.height, '31px', name + '：轨道高 31');
      assert.equal(track.props.style.borderRadius, '999px', name + '：完全胶囊');
      assert.equal(track.props.style.background, fill, name + '：轨道填充色');
      assert.match(
        track.props.style.boxShadow,
        /inset 0 0 0 1px rgba\(120,120,128,0\.4\)/,
        name + '：1px separator 灰描边（深色主题下黑轨道的轮廓）',
      );
      assert.match(track.props.style.transition, /0\.2s ease/, name + '：轨道颜色过渡');

      assert.equal(knob.props.style.width, '27px', name + '：圆点宽 27');
      assert.equal(knob.props.style.height, '27px', name + '：圆点高 27');
      assert.equal(knob.props.style.borderRadius, '50%', name + '：圆点正圆');
      assert.equal(knob.props.style.background, '#ffffff', name + '：圆点白色');
      assert.equal(knob.props.style.left, knobLeft, name + '：圆点位置');
      assert.match(knob.props.style.boxShadow, /rgba\(0,0,0,0\.25\)/, name + '：圆点阴影');
      assert.match(knob.props.style.boxShadow, /rgba\(0,0,0,0\.12\)/, name + '：圆点第二道阴影');
      assert.match(knob.props.style.transition, /0\.2s ease/, name + '：圆点位移过渡');
    });
  }
});

test('禁用态（跟随主会话关）：按钮整体 opacity 0.45，黑轨道保留描边不消失', async () => {
  await withHarness(
    { fetch: respondWith({ ...BASE_STATUS, sessionEnabled: false, inheritedOff: true }) },
    async ({ rt }) => {
      const button = findButton(rt.tree, '错峰发送');
      assert.equal(button.props.disabled, true);
      assert.equal(button.props['aria-checked'], 'false');
      assert.equal(button.props.style.opacity, 0.45, '禁用态整枚按钮 0.45');
      const track = button.children[0];
      assert.equal(track.props.style.background, '#000000', '禁用时轨道仍是黑色');
      assert.match(track.props.style.boxShadow, /rgba\(120,120,128,0\.4\)/, '描边不能随禁用一起消失');
    },
  );
});

test('「立即运行」只在 waiting === true、会话开且未旁路时出现', async () => {
  const cases = [
    ['排队中', { ...BASE_STATUS, waiting: true }, true],
    ['没在等', { ...BASE_STATUS, waiting: false }, false],
    ['旁路中', { ...BASE_STATUS, waiting: true, bypassing: true }, false],
    ['本会话关', { ...BASE_STATUS, waiting: true, sessionEnabled: false }, false],
    ['跟随主会话关', { ...BASE_STATUS, waiting: true, sessionEnabled: false, inheritedOff: true }, false],
    ['总开关关', { ...BASE_STATUS, waiting: true, enabled: false }, false],
  ];

  for (const [name, status, expected] of cases) {
    await withHarness({ fetch: respondWith(status) }, async ({ texts }) => {
      assert.equal(texts().includes('立即运行'), expected, name);
    });
  }
});

test('点「立即运行」失败时渲染「没能立即运行：宿主没有响应」', async () => {
  let releaseCalls = 0;
  const fetchImpl = async (url) => {
    if (url.startsWith('/dsh-offpeak/release')) {
      releaseCalls += 1;
      return { ok: false, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ ...BASE_STATUS, waiting: true }) };
  };

  await withHarness({ fetch: fetchImpl }, async ({ rt, texts }) => {
    assert.deepEqual(texts(), ['错峰发送', '立即运行']);
    const button = findButton(rt.tree, '立即运行');
    assert.ok(button, '排队时应渲染「立即运行」');
    button.props.onClick();
    await rt.flush();

    assert.equal(releaseCalls, 1);
    assert.deepEqual(
      texts(),
      ['错峰发送', '没能立即运行：宿主没有响应', '立即运行'],
      '失败反馈是按钮唯一的结果，必须留下',
    );
  });
});

test('点「立即运行」成功时不渲染错误句', async () => {
  let released = false;
  const fetchImpl = async (url) => {
    if (url.startsWith('/dsh-offpeak/release')) {
      released = true;
      return { ok: true, json: async () => ({ ok: true, woken: 1 }) };
    }
    // 放行之后宿主报告没人在等。
    return { ok: true, json: async () => ({ ...BASE_STATUS, waiting: released ? false : true }) };
  };

  await withHarness({ fetch: fetchImpl }, async ({ rt, texts }) => {
    const button = findButton(rt.tree, '立即运行');
    button.props.onClick();
    await rt.flush();

    assert.equal(released, true);
    assert.deepEqual(texts(), ['错峰发送'], '成功后不应有任何错误或状态文字');
  });
});

test('轮询连续失败时保留上一次状态，不追加任何提示文字', async () => {
  let reads = 0;
  const fetchImpl = async () => {
    reads += 1;
    if (reads === 1) {
      return { ok: true, json: async () => ({ ...BASE_STATUS, peak: true, releaseLabel: '12:01' }) };
    }
    return { ok: false, json: async () => ({}) };
  };

  await withHarness({ fetch: fetchImpl }, async ({ rt, timers, texts }) => {
    assert.deepEqual(texts(), ['错峰发送']);
    assert.equal(timers.length, 1, '应只注册一个轮询');

    for (let i = 0; i < 3; i++) {
      timers[0]();
      await rt.flush();
    }

    assert.equal(reads, 4);
    assert.deepEqual(texts(), ['错峰发送'], '读取失败不该再补「状态读取失败」之类的话');
  });
});

test('readStatus：2xx 返回对象，非 2xx / 抛错 / 非对象一律 null', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      return { ok: true, json: async () => ({ enabled: true, waiting: true }) };
    };
    assert.deepEqual(await mod.readStatus('s-1'), { enabled: true, waiting: true });
    assert.equal(seen.length, 1);
    // 契约：带 x-dsh-offpeak 头、sessionId 编码进 query、不走缓存。
    assert.equal(seen[0].url, '/dsh-offpeak/status?sessionId=s-1');
    assert.equal(seen[0].init.headers['x-dsh-offpeak'], '1');
    assert.equal(seen[0].init.cache, 'no-store');

    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    assert.equal(await mod.readStatus('s-1'), null);

    globalThis.fetch = async () => ({ ok: true, json: async () => [1, 2] });
    assert.equal(await mod.readStatus('s-1'), null);

    globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
    assert.equal(await mod.readStatus('s-1'), null);

    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal(await mod.readStatus('s-1'), null);

    assert.equal(await mod.readStatus(), null, 'sessionId 缺失时也不能抛');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('apply：挂到 conversation.composer.dock / dsh-offpeak-notice / order 12', () => {
  let registered = null;
  let injectedName = null;
  const ctx = {
    slots: {
      register: (def, comp) => {
        registered = { def, comp };
        return () => {};
      },
      inject: (name, cb) => {
        injectedName = name;
        cb();
        return () => {};
      },
    },
    effect: (fn) => {
      fn();
    },
  };

  mod.apply(ctx);

  assert.ok(registered, 'apply 应当登记组件');
  assert.equal(injectedName, 'conversation.composer.dock');
  assert.equal(registered.def.name, 'conversation.composer.dock');
  assert.equal(registered.def.id, 'dsh-offpeak-notice');
  assert.equal(registered.def.order, 12);
  assert.equal(typeof registered.def.inject, 'function');
  assert.deepEqual(registered.def.inject('s-42'), { sessionId: 's-42' });
  assert.equal(typeof registered.def.inject(), 'object');
  assert.equal(typeof registered.comp, 'function');
});

test('apply：ctx.effect 被拒时退回直接登记，不丢开关', () => {
  let registered = null;
  const ctx = {
    slots: {
      register: (def, comp) => {
        registered = { def, comp };
        return () => {};
      },
      inject: (name, cb) => {
        cb();
        return () => {};
      },
    },
    effect: () => {
      throw new Error('denied by guard');
    },
  };

  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    assert.doesNotThrow(() => mod.apply(ctx));
  } finally {
    console.error = realError;
  }

  assert.ok(registered, 'effect 失败也必须已经登记');
  assert.equal(registered.def.id, 'dsh-offpeak-notice');
  assert.equal(logged.length, 1);
});
