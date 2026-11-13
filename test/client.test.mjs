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

/* ------------------------------------------------------------------ *
 * 点开关这条主交互（改动前完全没有覆盖：把 postToggle 改坏、
 * 或让「演练中 / 总开关关」时还能点，原有的绿点一个都不会红）
 * ------------------------------------------------------------------ */

test('开关的 aria-checked 跟随 checked：开态 true，关态 false', async () => {
  const cases = [
    ['开', { ...BASE_STATUS }, 'true'],
    ['关', { ...BASE_STATUS, sessionEnabled: false }, 'false'],
    // 总开关关时 checked 也是 false —— 开关得如实说自己现在是关的。
    ['总开关关', { ...BASE_STATUS, enabled: false }, 'false'],
    // 主会话关掉、子代理继承到「关」：同样是 false。
    ['跟随主会话关', { ...BASE_STATUS, inheritedOff: true, sessionEnabled: false }, 'false'],
  ];

  for (const [name, status, expected] of cases) {
    await withHarness({ fetch: respondWith(status) }, async ({ rt }) => {
      const button = findButton(rt.tree, '错峰发送');
      assert.equal(button.props.role, 'switch');
      assert.equal(button.props['aria-checked'], expected, name + '：aria-checked');
    });
  }
});

test('点开关发出 POST /dsh-offpeak/toggle：sessionId 与目标状态都在 query 里', async () => {
  let toggleUrl = null;
  let toggleInit = null;
  const fetchImpl = async (url, init) => {
    if (url.startsWith('/dsh-offpeak/toggle')) {
      toggleUrl = url;
      toggleInit = init;
      // 真宿主会回完整状态；开 → 关。
      return { ok: true, json: async () => ({ ...BASE_STATUS, sessionEnabled: false }) };
    }
    return { ok: true, json: async () => ({ ...BASE_STATUS }) };
  };

  await withHarness({ fetch: fetchImpl }, async ({ rt }) => {
    const button = findButton(rt.tree, '错峰发送');
    assert.equal(button.props['aria-checked'], 'true', '前置：现在是开态');

    button.props.onClick();
    await rt.flush();

    assert.equal(toggleUrl, '/dsh-offpeak/toggle?sessionId=s-1&enabled=0', '开→关应发 enabled=0');
    assert.equal(toggleInit.method, 'POST');
    assert.equal(toggleInit.headers['x-dsh-offpeak'], '1');
    assert.equal(toggleInit.cache, 'no-store');

    const after = findButton(rt.tree, '错峰发送');
    assert.equal(after.props['aria-checked'], 'false', '宿主回了关态，开关要跟着翻过去');
  });
});

test('点开关时 POST 失败：状态回落成原来的开，且不冒出任何提示文字', async () => {
  let toggles = 0;
  const fetchImpl = async (url) => {
    if (url.startsWith('/dsh-offpeak/toggle')) {
      toggles += 1;
      return { ok: false, json: async () => ({}) };
    }
    // 重读也还是开：宿主没接受这次切换。
    return { ok: true, json: async () => ({ ...BASE_STATUS }) };
  };

  await withHarness({ fetch: fetchImpl }, async ({ rt, texts }) => {
    const button = findButton(rt.tree, '错峰发送');
    button.props.onClick();
    await rt.flush();

    assert.equal(toggles, 1, '应真的发了一次切换请求');
    const after = findButton(rt.tree, '错峰发送');
    assert.equal(after.props['aria-checked'], 'true', '失败后必须回落成原来的开态');
    assert.equal(after.props.disabled, false, '失败后不能把开关锁死');
    assert.deepEqual(texts(), ['错峰发送'], '开关失败的提示句只给「立即运行」，这里不许加文案');
  });
});

test('POST 失败后要回读一次实况：别让开关停在半路（宿主其实已经改了）', async () => {
  // 首轮读到的是「开」；此后实况变成「关」——宿主处理了这次切换、只是响应丢了。
  // 少了那次回读，开关就会停在旧的开态上（这条用例原先构造不出差异，被变异测试抓到）。
  let reads = 0;
  const fetchImpl = async (url) => {
    if (url.startsWith('/dsh-offpeak/toggle')) {
      return { ok: false, json: async () => ({}) };
    }
    reads += 1;
    const state = reads === 1 ? { ...BASE_STATUS } : { ...BASE_STATUS, sessionEnabled: false };
    return { ok: true, json: async () => state };
  };

  await withHarness({ fetch: fetchImpl }, async ({ rt }) => {
    assert.equal(findButton(rt.tree, '错峰发送').props['aria-checked'], 'true', '前置：首轮读到开');
    findButton(rt.tree, '错峰发送').props.onClick();
    await rt.flush();
    assert.equal(reads, 2, '失败后应当再读一次状态');
    assert.equal(
      findButton(rt.tree, '错峰发送').props['aria-checked'],
      'false',
      '响应丢了也要跟实况走，不能停在旧的开态',
    );
  });
});

// P2-1：深色主题下「关」的黑轨道曾只剩一颗悬空白点（描边 1.19:1、禁用态 1.08:1）。
// 修法是在轨道外面补一圈 1px 浅灰（开态不加），禁用态换更亮的一圈补偿 0.45 的压暗。
// 断言钉住「哪几组有外圈」和「外圈的亮度」，免得被无声改回去。
test('深色主题轮廓：关态与禁用态补一圈外描边，开态不加', async () => {
  const INNER = 'inset 0 0 0 1px rgba(120,120,128,0.4)';
  const cases = [
    ['关 / 可点', { ...BASE_STATUS, sessionEnabled: false }, '0 0 0 1px rgba(210,210,218,0.5)'],
    ['关 / 禁用', { ...BASE_STATUS, sessionEnabled: false, inheritedOff: true }, '0 0 0 1px rgba(255,255,255,0.92)'],
    ['开 / 可点', { ...BASE_STATUS }, null],
    ['开 / 禁用', { ...BASE_STATUS, dryRun: true }, '0 0 0 1px rgba(255,255,255,0.92)'],
  ];

  for (const [name, status, halo] of cases) {
    // eslint-disable-next-line no-await-in-loop -- 每格要独立的渲染环境
    await withHarness({ fetch: respondWith(status) }, async ({ rt }) => {
      const shadow = findButton(rt.tree, '错峰发送').children[0].props.style.boxShadow;

      // 内圈那道必须一直在（黑轨道内沿的层次）。
      assert.ok(shadow.includes(INNER), name + '：内圈不能丢');

      if (halo === null) {
        assert.equal(shadow, INNER, name + '：蓝轨道够亮，不该多加光边');
        return;
      }
      assert.equal(shadow, halo + ', ' + INNER, name + '：外圈 + 内圈，外圈不带 inset');
    });
  }
});

test('开关的 disabled：只有 busy、或禁止切换（演练中 / 总开关关 / 跟随主会话关）时为 true', async () => {
  const locked = [
    ['演练中', { ...BASE_STATUS, dryRun: true }],
    ['总开关关', { ...BASE_STATUS, enabled: false }],
    ['跟随主会话关', { ...BASE_STATUS, inheritedOff: true, sessionEnabled: false }],
  ];

  for (const [name, status] of locked) {
    await withHarness({ fetch: respondWith(status) }, async ({ rt }) => {
      const button = findButton(rt.tree, '错峰发送');
      assert.equal(button.props.disabled, true, name + '：不该能点');
      // 点了也不能发请求 —— 兜底看 onClick 自己的守卫。
      const before = rt.tree;
      button.props.onClick();
      await rt.flush();
      assert.equal(findButton(rt.tree, '错峰发送').props['aria-checked'],
        findButton(before, '错峰发送').props['aria-checked'], name + '：被禁时点了也不能变');
    });
  }

  // 正常可点。
  await withHarness({ fetch: respondWith({ ...BASE_STATUS }) }, async ({ rt }) => {
    assert.equal(findButton(rt.tree, '错峰发送').props.disabled, false, '可切换时不能禁');
  });

  // busy：请求在飞时按钮必须 disabled，避免连点发出两次切换。
  const pending = new Promise(() => {});
  const stuck = async (url) => {
    if (url.startsWith('/dsh-offpeak/toggle')) return pending;
    return { ok: true, json: async () => ({ ...BASE_STATUS }) };
  };
  await withHarness({ fetch: stuck }, async ({ rt }) => {
    const button = findButton(rt.tree, '错峰发送');
    assert.equal(button.props.disabled, false, '前置：空闲时可点');
    button.props.onClick();
    await rt.flush();
    const busyNow = findButton(rt.tree, '错峰发送');
    assert.equal(busyNow.props.disabled, true, '请求在飞时应 disabled');
    assert.equal(busyNow.props.style.opacity, 0.45, '禁用态观感沿用整枚 0.45');
  });
});

test('「立即运行」的失败句不会被下一轮成功轮询擦掉，只在再次点击时清', async () => {
  let releaseFails = true;
  let releases = 0;
  const fetchImpl = async (url) => {
    if (url.startsWith('/dsh-offpeak/release')) {
      releases += 1;
      return { ok: !releaseFails, json: async () => ({}) };
    }
    // 状态一直是「排队中」：轮询每轮都成功，正是把提示擦掉的那种场景。
    return { ok: true, json: async () => ({ ...BASE_STATUS, waiting: true }) };
  };

  await withHarness({ fetch: fetchImpl }, async ({ rt, timers, texts }) => {
    const button = findButton(rt.tree, '立即运行');
    button.props.onClick();
    await rt.flush();
    assert.equal(releases, 1);
    assert.ok(texts().includes('没能立即运行：宿主没有响应'), '点完失败要有提示');

    // 关键回归：轮询成功若干轮后，提示仍在（以前这里会 setError(null) 秒清）。
    for (let i = 0; i < 3; i++) {
      timers[0]();
      await rt.flush();
    }
    assert.ok(
      texts().includes('没能立即运行：宿主没有响应'),
      '5 秒轮询不该擦掉失败提示',
    );

    // 再次点击发起新请求时才清；这次成功，提示应当消失（桩仍回报排队中，
    // 所以按钮还在，但错误句必须没有了）。
    releaseFails = false;
    const again = findButton(rt.tree, '立即运行');
    again.props.onClick();
    await rt.flush();
    assert.equal(releases, 2);
    assert.deepEqual(texts(), ['错峰发送', '立即运行'], '再次点击后旧提示清掉，成功则不留任何文字');
  });
});

test('失败句挂在 role="status" 的 live region 上，读屏能播报', async () => {
  const findStatus = (node) => {
    if (node === null || node === undefined || node === false) return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findStatus(child);
        if (found) return found;
      }
      return null;
    }
    if (node.props && node.props.role === 'status') return node;
    return findStatus(node.children);
  };

  const fetchImpl = async (url) => {
    if (url.startsWith('/dsh-offpeak/release')) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ ...BASE_STATUS, waiting: true }) };
  };

  await withHarness({ fetch: fetchImpl }, async ({ rt }) => {
    assert.equal(findStatus(rt.tree), null, '没失败时不该有 live region 占位');
    const button = findButton(rt.tree, '立即运行');
    button.props.onClick();
    await rt.flush();

    const region = findStatus(rt.tree);
    assert.ok(region, '失败提示必须是 role="status"');
    assert.deepEqual(collectTexts(region), ['没能立即运行：宿主没有响应'], '文案不变');
    // 样式不动：还是那句 0.62 透明度的次要文字。
    assert.equal(region.props.style.opacity, 0.62);
  });
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
