/**
 * 峰谷判定 —— 纯函数，无 IO、不依赖 ctx，可直接单测。
 *
 * 规则来源（逐字核对过官方页）：
 *   https://api-docs.deepseek.com/quick_start/pricing
 *   "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
 *    excluding Chinese public holidays. All other hours are off-peak."
 *   → Asia/Shanghai（UTC+8）即 09:00–12:00、14:00–18:00，周一至周五，左闭右开。
 *
 * 节假日：本版不实现（用户 2026-11-11 定：这版先不管），配置项保留但不参与判定。
 */

const DAY_MS = 86_400_000;

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** 默认高峰窗口。ISO 星期：1=周一 … 7=周日。 */
export const DEFAULT_PEAK_WINDOWS = Object.freeze([
  Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), start: '09:00', end: '12:00' }),
  Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), start: '14:00', end: '18:00' }),
]);

export const DEFAULT_JITTER_SECONDS = Object.freeze([60, 120]);

/** 单次 setTimeout 的上限，超时需分片（周末 64 小时远未到，长假才有意义）。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// 本地时间字段
// ---------------------------------------------------------------------------

const formatterCache = new Map();

/**
 * 时区无效时的兜底。
 *
 * `Intl.DateTimeFormat` 对拼错的时区抛 `RangeError`。这个模块被 `llm/stream`
 * 的每个请求调用一次，一旦抛出去就是「所有模型调用全挂」—— 一个配置笔误
 * 不该有这个后果。所以入口统一过一道校验，无效值退回默认时区。
 */
export function safeTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return DEFAULT_TIME_ZONE;
  try {
    formatterFor(timeZone);
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function buildFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** 只在确认时区可用后调用（入口都会先过 `safeTimeZone`）。 */
function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = buildFormatter(timeZone);
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * 把一个绝对时刻换算成指定时区的本地日历字段。
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number, weekday:number}}
 *          `weekday` 是 JS 原生约定，0=周日 … 6=周六。
 */
export function localParts(instant, timeZone = DEFAULT_TIME_ZONE) {
  const parts = formatterFor(safeTimeZone(timeZone)).formatToParts(instant);
  const pick = (type) => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? 0 : Number(found.value);
  };
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  // 部分 ICU 版本在 hour12:false 下把午夜给成 24，归一到 0。
  const hour = pick('hour') % 24;
  return {
    year,
    month,
    day,
    hour,
    minute: pick('minute'),
    second: pick('second'),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** JS 星期（0=周日）转 ISO 星期（1=周一 … 7=周日）。 */
export function isoWeekday(weekday) {
  return weekday === 0 ? 7 : weekday;
}

/**
 * 把「某时区的墙上时间」换算成绝对时刻。
 * 用偏移校正迭代：对 DST 时区也能收敛（中国无夏令时，通常一轮就够）。
 */
export function zonedInstant(year, month, day, hour, minute, timeZone = DEFAULT_TIME_ZONE) {
  const want = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = want;
  for (let round = 0; round < 4; round += 1) {
    const parts = localParts(new Date(guess), timeZone);
    const got = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
    const delta = want - got;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

/** 在本地日历上加减天数（不经过时区，纯日历算术）。 */
function shiftLocalDate(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

// ---------------------------------------------------------------------------
// 窗口展开
// ---------------------------------------------------------------------------

/** "09:00" / "9:00" / "09:00:30" → 自本地午夜起的分钟数（含小数）。非法返回 NaN。 */
export function parseClock(text) {
  if (typeof text !== 'string') return Number.NaN;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (match === null) return Number.NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) return Number.NaN;
  return hour * 60 + minute + second / 60;
}

/**
 * 把某一天开始的窗口展开成绝对区间 `[start, end)`。
 * `end <= start` 视为跨午夜（延续到次日）。
 */
function windowBounds(dayParts, window, timeZone) {
  const startMinutes = parseClock(window.start);
  const endMinutes = parseClock(window.end);
  if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return null;

  const start = zonedInstant(
    dayParts.year,
    dayParts.month,
    dayParts.day,
    Math.floor(startMinutes / 60),
    Math.floor(startMinutes % 60),
    timeZone,
  );

  const crossesMidnight = endMinutes <= startMinutes;
  const endDay = crossesMidnight ? shiftLocalDate(dayParts, 1) : dayParts;
  const end = zonedInstant(
    endDay.year,
    endDay.month,
    endDay.day,
    Math.floor(endMinutes / 60),
    Math.floor(endMinutes % 60),
    timeZone,
  );

  return { start, end };
}

function resolveOptions(options) {
  const windows = options?.peakWindows;
  return {
    timeZone: options?.timeZone ?? DEFAULT_TIME_ZONE,
    // 只有真正的数组才算「配置了窗口」：`null` / 缺省 → 内置默认；`[]` → 没有高峰。
    // 别的类型（字符串、数字）在 `normalizeConfig` 里已经回落成 null，这里再挡一次，
    // 免得绕过归一化的调用方让 `for...of` 抛 TypeError（0.1.20，P0-1 同源）。
    peakWindows: Array.isArray(windows) ? windows : DEFAULT_PEAK_WINDOWS,
  };
}

/**
 * 列出 `instant` 前后 `days` 天内所有高峰窗口的绝对区间。
 * 覆盖前一日是为了接住跨午夜窗口延续过来的部分。
 */
export function candidateWindows(instant, options, days = 1) {
  const { timeZone, peakWindows } = resolveOptions(options);
  const today = localParts(instant, timeZone);
  const out = [];
  for (let offset = -1; offset <= days; offset += 1) {
    const dayParts = shiftLocalDate(today, offset);
    const isoDay = isoWeekday(dayParts.weekday);
    for (const window of peakWindows) {
      /**
       * 坏项防御（0.1.20，P0-1）。
       *
       * `normalizeConfig` 归一化时已经逐项过滤过一遍，但这个模块是公开导出的，
       * 也可能被别处直接调用（历史版本、手搓脚本、配置绕过了归一化）。只要有一项
       * 是 `null` / 数字 / 字符串，下一行的 `window.days` 就会抛 TypeError —— 而
       * 那是在 `llm/stream` 的同步链路上，一次配置手滑能让**所有**模型调用发不出去，
       * 连不在拦截范围的模型、连半夜的低谷一起陪葬。所以这里再挡一次，只跳过、
       * 不抛错：宁可少拦一段窗口，也不能让整机停摆。
       */
      if (window === null || typeof window !== 'object') continue;
      if (!Array.isArray(window.days) || !window.days.includes(isoDay)) continue;
      const bounds = windowBounds(dayParts, window, timeZone);
      if (bounds === null) continue;
      out.push({ ...bounds, window, dayParts });
    }
  }
  out.sort((left, right) => left.start.getTime() - right.start.getTime());
  return out;
}

// ---------------------------------------------------------------------------
// 对外判定
// ---------------------------------------------------------------------------

/** 返回 `instant` 所在的高峰窗口，不在高峰返回 `null`。 */
export function activeWindow(instant, options) {
  const at = instant.getTime();
  for (const candidate of candidateWindows(instant, options)) {
    if (at >= candidate.start.getTime() && at < candidate.end.getTime()) return candidate;
  }
  return null;
}

/** 当前是否高峰。 */
export function isPeak(instant, options) {
  return activeWindow(instant, options) !== null;
}

/**
 * 本次调用什么时候可以真正发出。
 * 在低谷 → 原样返回 `instant`（立即放行）；在高峰 → 当前这段高峰的终点 + 随机抖动。
 *
 * **抖动之后又落进下一段高峰时继续往后推**：窗口可以是首尾相接的（配置成
 * 09:00-12:00 与 11:00-14:00，或跨午夜窗口接上次日早高峰）。过去只取「当前
 * 窗口终点 + 抖动」，12:30 提交会算成 13:00 放行、而那一刻仍在高峰里——
 * 放行那一刻立刻又排一轮，等于白等。
 */
export function nextReleaseAt(instant, options) {
  const jitter = options?.jitter ?? DEFAULT_JITTER_SECONDS;
  const random = options?.random ?? Math.random;
  const active = activeWindow(instant, options);
  if (active === null) return new Date(instant.getTime());

  /**
   * 抖动只许**往后**延，不许提前（0.1.20，P0-3）。
   *
   * 抖动存在的意义是「错峰」：整点一起涌出去对谁都难受。写成可正可负的区间
   * （`[-60, 60]`）时，负数会把放行时刻拉到高峰**还没结束**的那一刻 ——
   * 用户以为排到了低谷，实际 11:59 就发出去了，照样按原价付钱。
   *
   * 所以先把下限钳到 0，再判区间是否可用：
   * - 下限为负 → 当 0（配上限大于 0 时变成 `[0, high]`）；
   * - 上限不大于下限，或任一值不是数字 → 抖动作废、按 0 处理（不加延迟，
   *   也绝不提前）。抖动是锦上添花，不该让一次配置手滑把价格优惠整没了。
   */
  const rawLow = Number(jitter[0]);
  const rawHigh = Number(jitter[1]);
  const low = Number.isFinite(rawLow) ? Math.max(0, rawLow) : 0;
  const high = Number.isFinite(rawHigh) ? rawHigh : low;
  const usable = high >= low;
  const baseSeconds = usable ? low : 0;
  const span = usable && high > low ? high - low : 0;
  const extraSeconds = span > 0 ? baseSeconds + random() * span : baseSeconds;
  const extraMs = Math.round(extraSeconds * 1000);

  let candidate = new Date(active.end.getTime() + extraMs);
  // 上限 8 段：正常配置一两段就出结果，坏配置（首尾相接绕成环）也不该卡住。
  // 抖动钳到 0 之后，每轮仍可能因为「窗口终点紧接下一段开头」而落回高峰里，
  // 这个循环依旧要能收敛：每推一次终点严格前进，最多推 8 段。
  for (let guard = 0; guard < 8; guard += 1) {
    const next = activeWindow(candidate, options);
    if (next === null) break;
    const advanced = new Date(next.end.getTime() + extraMs);
    // 毫无进展（终点没往前走）就停：否则候选值不动的循环只会白转 8 次。
    if (advanced.getTime() <= candidate.getTime()) break;
    candidate = advanced;
  }
  return candidate;
}

/** 下一个高峰的开始时刻；未来若干天内没有高峰则返回 `null`。 */
export function nextPeakAt(instant, options) {
  const at = instant.getTime();
  for (const candidate of candidateWindows(instant, options, 8)) {
    if (candidate.start.getTime() > at) return candidate.start;
  }
  return null;
}
