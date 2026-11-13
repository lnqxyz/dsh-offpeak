import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PEAK_WINDOWS,
  DEFAULT_TIME_ZONE,
  activeWindow,
  candidateWindows,
  isPeak,
  isoWeekday,
  localParts,
  nextPeakAt,
  nextReleaseAt,
  parseClock,
  safeTimeZone,
  zonedInstant,
} from '../lib/peak-window.js';

/** 便捷构造：把「上海墙上时间」写成绝对时刻。 */
function sh(year, month, day, hour, minute = 0) {
  return zonedInstant(year, month, day, hour, minute, 'Asia/Shanghai');
}

const FIXED_JITTER = { jitter: [0, 0] };

// 2026-11-11 是周三。用它当基准日，避免周末干扰。
const WED = { year: 2026, month: 11, day: 11 };

test('parseClock 接受合法时间并拒绝越界', () => {
  assert.equal(parseClock('09:00'), 540);
  assert.equal(parseClock('9:00'), 540);
  assert.equal(parseClock('18:00'), 1080);
  assert.equal(parseClock('09:00:30'), 540.5);
  assert.ok(Number.isNaN(parseClock('24:00')));
  assert.ok(Number.isNaN(parseClock('09:60')));
  assert.ok(Number.isNaN(parseClock('0900')));
  assert.ok(Number.isNaN(parseClock(undefined)));
});

test('localParts 把绝对时刻换算成上海墙上时间', () => {
  const parts = localParts(sh(WED.year, WED.month, WED.day, 9, 0), 'Asia/Shanghai');
  assert.equal(parts.hour, 9);
  assert.equal(parts.minute, 0);
  assert.equal(isoWeekday(parts.weekday), 3); // 周三
});

test('高峰边界左闭右开', () => {
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 8, 59), FIXED_JITTER), false);
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 9, 0), FIXED_JITTER), true);
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 11, 59), FIXED_JITTER), true);
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 12, 0), FIXED_JITTER), false);
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 13, 59), FIXED_JITTER), false);
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 14, 0), FIXED_JITTER), true);
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 17, 59), FIXED_JITTER), true);
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 18, 0), FIXED_JITTER), false);
});

test('周末全天低谷', () => {
  // 2026-11-14 周六、2026-11-15 周日
  assert.equal(isPeak(sh(2026, 11, 14, 10, 0), FIXED_JITTER), false);
  assert.equal(isPeak(sh(2026, 11, 15, 15, 0), FIXED_JITTER), false);
  assert.equal(isPeak(sh(2026, 11, 16, 10, 0), FIXED_JITTER), true); // 周一
});

test('低谷期立即放行，不引入任何延迟', () => {
  const at = sh(WED.year, WED.month, WED.day, 12, 30);
  assert.equal(nextReleaseAt(at, FIXED_JITTER).getTime(), at.getTime());
  const evening = sh(WED.year, WED.month, WED.day, 20, 0);
  assert.equal(nextReleaseAt(evening, FIXED_JITTER).getTime(), evening.getTime());
});

test('上午高峰释放到 12:00，下午高峰释放到 18:00', () => {
  const morning = nextReleaseAt(sh(WED.year, WED.month, WED.day, 9, 30), FIXED_JITTER);
  assert.equal(localParts(morning, 'Asia/Shanghai').hour, 12);
  assert.equal(localParts(morning, 'Asia/Shanghai').minute, 0);

  const afternoon = nextReleaseAt(sh(WED.year, WED.month, WED.day, 15, 0), FIXED_JITTER);
  assert.equal(localParts(afternoon, 'Asia/Shanghai').hour, 18);
  assert.equal(localParts(afternoon, 'Asia/Shanghai').minute, 0);
});

test('抖动落在配置区间内', () => {
  const at = sh(WED.year, WED.month, WED.day, 10, 0);
  const base = sh(WED.year, WED.month, WED.day, 12, 0).getTime();
  for (const value of [0, 0.5, 0.999999]) {
    const released = nextReleaseAt(at, { jitter: [60, 120], random: () => value });
    const delta = (released.getTime() - base) / 1000;
    assert.ok(delta >= 60 && delta <= 120, `delta=${delta} 应在 [60,120]`);
  }
});

test('周五 18:00 之后直到周一 09:00 全是低谷', () => {
  // 2026-11-13 周五
  const fridayEvening = sh(2026, 11, 13, 18, 0);
  assert.equal(isPeak(fridayEvening, FIXED_JITTER), false);
  const saturdayNoon = sh(2026, 11, 14, 12, 0);
  assert.equal(isPeak(saturdayNoon, FIXED_JITTER), false);
  const sundayNight = sh(2026, 11, 15, 23, 59);
  assert.equal(isPeak(sundayNight, FIXED_JITTER), false);
  const mondayMorning = sh(2026, 11, 16, 9, 0);
  assert.equal(isPeak(mondayMorning, FIXED_JITTER), true);
});

test('nextPeakAt 跨周末找到下周一 09:00', () => {
  const fridayNight = sh(2026, 11, 13, 20, 0);
  const next = nextPeakAt(fridayNight, FIXED_JITTER);
  assert.ok(next !== null);
  const parts = localParts(next, 'Asia/Shanghai');
  assert.equal(parts.day, 16);
  assert.equal(parts.hour, 9);
  assert.equal(isoWeekday(parts.weekday), 1);
});

test('nextPeakAt 在工作日低谷找到当天下一个窗口', () => {
  const noon = sh(WED.year, WED.month, WED.day, 12, 30);
  const next = nextPeakAt(noon, FIXED_JITTER);
  assert.ok(next !== null);
  const parts = localParts(next, 'Asia/Shanghai');
  assert.equal(parts.hour, 14);
  assert.equal(parts.day, WED.day);
});

test('activeWindow 返回的区间与窗口定义一致', () => {
  const active = activeWindow(sh(WED.year, WED.month, WED.day, 15, 0), FIXED_JITTER);
  assert.ok(active !== null);
  assert.equal(localParts(active.start, 'Asia/Shanghai').hour, 14);
  assert.equal(localParts(active.end, 'Asia/Shanghai').hour, 18);
});

test('自定义窗口生效，不写死默认值', () => {
  const custom = {
    peakWindows: [{ days: [3], start: '10:00', end: '11:00' }],
    jitter: [0, 0],
  };
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 10, 30), custom), true);
  // 默认窗口在 09:30 是高峰，自定义下不是
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 9, 30), custom), false);
  // 周四不在这条自定义窗口里
  assert.equal(isPeak(sh(2026, 11, 12, 10, 30), custom), false);
});

test('跨午夜窗口（end <= start）延续到次日', () => {
  const night = {
    peakWindows: [{ days: [3], start: '22:00', end: '02:00' }],
    jitter: [0, 0],
  };
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 23, 0), night), true);
  assert.equal(isPeak(sh(2026, 11, 12, 1, 0), night), true);
  assert.equal(isPeak(sh(2026, 11, 12, 2, 0), night), false);
  assert.equal(isPeak(sh(2026, 11, 12, 22, 0), night), false);
});

test('首尾相接的窗口：抖动后仍落高峰就继续往后推，不做白等一轮', () => {
  // 09:00-12:00 与 11:00-14:00 相接。12:00 起点落在第二段里 ——
  // 只取「当前窗口终点 + 抖动」会算成 12:00 放行，而那一刻仍是高峰，
  // 放行后立刻又排一轮，等于白等。
  const chained = {
    peakWindows: [
      { days: [3], start: '09:00', end: '12:00' },
      { days: [3], start: '11:00', end: '14:00' },
    ],
    jitter: [0, 0],
  };
  const release = nextReleaseAt(sh(WED.year, WED.month, WED.day, 12, 30), chained);
  assert.equal(isPeak(release, chained), false, '放行时刻必须真的落在低谷');
  assert.equal(localParts(release, 'Asia/Shanghai').hour, 14);
});

test('抖动后落进下一段高峰也继续推', () => {
  // 12:00 收工 + 600 秒抖动 = 12:10，仍在第二段（11:00-14:00）里。
  const chained = {
    peakWindows: [
      { days: [3], start: '09:00', end: '12:00' },
      { days: [3], start: '11:00', end: '14:00' },
    ],
    jitter: [600, 600],
  };
  const release = nextReleaseAt(sh(WED.year, WED.month, WED.day, 10, 0), chained);
  assert.equal(isPeak(release, chained), false);
  assert.equal(localParts(release, 'Asia/Shanghai').hour, 14);
});

// ---------------------------------------------------------------------------
// 抖动不许提前放行（0.1.20，P0-3）
// ---------------------------------------------------------------------------

test('负抖动被钳到 0：放行时刻不早于高峰终点', () => {
  // 抖动写成可正可负（[-60, 60]）时，负数会把放行时刻拉到高峰还没结束的那一刻：
  // 11:59 发出去，照样按原价付钱。抖动只该往后延，不该提前。
  const at = sh(WED.year, WED.month, WED.day, 10, 0);
  const edge = sh(WED.year, WED.month, WED.day, 12, 0).getTime();
  const cases = [
    { jitter: [-60, 60], random: () => 0, expect: edge, label: '[-60,60] 抽到下限' },
    { jitter: [-60, 60], random: () => 0.5, expect: edge + 30_000, label: '[-60,60] 抽到中点' },
    { jitter: [-60, -30], random: () => 0, expect: edge, label: '整段为负' },
    { jitter: [120, 60], random: () => 0, expect: edge, label: '上下限写反' },
    { jitter: [Number.NaN, 30], random: () => 0, expect: edge, label: '下限不是数字' },
  ];
  for (const item of cases) {
    const released = nextReleaseAt(at, { jitter: item.jitter, random: item.random });
    assert.equal(released.getTime(), item.expect, `${item.label}：放行时刻算错`);
    assert.equal(isPeak(released, FIXED_JITTER), false, `${item.label}：放行时刻仍在高峰内`);
  }
});

test('钳到 0 之后，首尾相接的窗口仍能推到真正的低谷（guard 循环收敛）', () => {
  // 抖动钳到 0 只是保证「不提前」，落点仍可能正好是下一段窗口的开头。
  // guard 循环必须继续往后推，且不能因为终点没变而空转。
  const chained = {
    peakWindows: [
      { days: [3], start: '09:00', end: '12:00' },
      { days: [3], start: '11:00', end: '14:00' },
    ],
    jitter: [-60, 60],
    random: () => 0,
  };
  const released = nextReleaseAt(sh(WED.year, WED.month, WED.day, 10, 0), chained);
  assert.equal(isPeak(released, chained), false, '放行时刻必须真的落在低谷');
  assert.equal(localParts(released, 'Asia/Shanghai').hour, 14);
});

test('全天窗口这种绕成环的配置也不会让 nextReleaseAt 卡住', () => {
  // 每天 24 小时都是高峰时，本来就不存在「低谷」这个落点。这里只要求它
  // 有限步内返回（不能因为 guard 循环空转而挂死），返回值是不是高峰无所谓。
  const allDay = {
    peakWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '00:00' }],
    jitter: [0, 0],
  };
  const start = Date.now();
  const released = nextReleaseAt(sh(WED.year, WED.month, WED.day, 10, 0), allDay);
  assert.ok(released instanceof Date);
  assert.ok(Date.now() - start < 1000, '不能卡住');
});

// ---------------------------------------------------------------------------
// 坏窗口项不许把整机拖垮（0.1.20，P0-1）
// ---------------------------------------------------------------------------

test('窗口数组里的坏项被跳过，不抛 TypeError', () => {
  // `peakWindows: [null]` 之前会在 `window.days` 上抛 TypeError —— 而这条路径在
  // `llm/stream` 的同步链路上，一次配置手滑能让所有模型调用都发不出去。
  const broken = {
    peakWindows: [null, undefined, 42, 'oops', [], { days: [3], start: '09:00', end: '12:00' }],
  };
  assert.doesNotThrow(() => isPeak(sh(WED.year, WED.month, WED.day, 10, 0), broken));
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 10, 0), broken), true, '合法那项仍要生效');
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 13, 0), broken), false);
  assert.doesNotThrow(() => candidateWindows(sh(WED.year, WED.month, WED.day, 10, 0), broken));
});

test('只有坏项时当作没有高峰：立即放行，不抛错', () => {
  const onlyBroken = { peakWindows: [null] };
  const at = sh(WED.year, WED.month, WED.day, 10, 0);
  assert.doesNotThrow(() => nextReleaseAt(at, onlyBroken));
  assert.equal(nextReleaseAt(at, onlyBroken).getTime(), at.getTime(), '没有可用窗口 = 低谷 = 不延迟');
  assert.equal(isPeak(at, onlyBroken), false);
});

test('peakWindows 不是数组时退回内置默认窗口，而不是让 for...of 崩', () => {
  // normalizeConfig 会把它归一成 null，但本模块是公开导出的，可能被别处直接调。
  for (const bad of ['nope', 42, {}]) {
    assert.doesNotThrow(
      () => isPeak(sh(WED.year, WED.month, WED.day, 10, 0), { peakWindows: bad }),
      String(bad),
    );
  }
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 10, 0), { peakWindows: 'nope' }), true);
  assert.equal(isPeak(sh(WED.year, WED.month, WED.day, 10, 0), { peakWindows: {} }), true);
});

test('默认窗口常量没被意外改写', () => {
  assert.equal(DEFAULT_PEAK_WINDOWS.length, 2);
  assert.ok(Object.isFrozen(DEFAULT_PEAK_WINDOWS));
  assert.ok(Object.isFrozen(DEFAULT_PEAK_WINDOWS[0].days));
});

// ---------------------------------------------------------------------------
// 坏配置不炸整机（0.1.11）
// ---------------------------------------------------------------------------

test('safeTimeZone：拼错的时区退回默认，不抛 RangeError', () => {
  // 每个模型调用都会走一次 localParts。时区字符串拼错时 Intl 直接抛
  // RangeError，而监听器外层没有 try/catch —— 一次配置手滑就能让全机停摆。
  for (const bad of ['Asia/Shanghia', 'Asia/Shanghai ', '', '   ', 42, null, undefined, {}]) {
    assert.equal(safeTimeZone(bad), DEFAULT_TIME_ZONE, `${String(bad)} 应退回默认`);
  }
  assert.equal(safeTimeZone('Asia/Shanghai'), 'Asia/Shanghai');
  // Intl 对大小写不敏感，这个不算坏值
  assert.equal(safeTimeZone('asia/shanghai'), 'asia/shanghai');
  assert.equal(safeTimeZone('UTC'), 'UTC');
  // 归一之后调用方不必再自己兜底
  assert.doesNotThrow(() => localParts(new Date(), safeTimeZone('Asia/Shanghia')));
});
