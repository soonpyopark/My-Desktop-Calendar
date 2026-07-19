import { LunarData, toLunar, toSolar } from 'kor-lunar';

/**
 * @param {string} dateKey YYYY-MM-DD
 */
function parseDateKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * @param {Date} date
 */
function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {boolean} isLeapMonth
 * @returns {string | null} YYYY-MM-DD
 */
export function lunarToSolarDateKey(year, month, day, isLeapMonth = false) {
  try {
    const leap = Boolean(isLeapMonth) && LunarData.getLeapMonth(year) === month;
    const maxDay = leap
      ? LunarData.getLeapMonthDays(year)
      : LunarData.getMonthDays(year, month);
    if (!maxDay || maxDay < 1) return null;
    const clampedDay = Math.min(Math.max(1, day), maxDay);
    if (!LunarData.isValidDate(year, month, clampedDay, leap)) return null;
    const solar = toSolar(year, month, clampedDay, leap);
    if (!solar?.year || !solar?.month || !solar?.day) return null;
    return toDateKey(new Date(solar.year, solar.month - 1, solar.day));
  } catch {
    return null;
  }
}

/**
 * @param {string} dateKey YYYY-MM-DD
 */
export function solarDateKeyToLunar(dateKey) {
  const date = parseDateKey(dateKey);
  const lunar = toLunar(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return {
    year: lunar.year,
    month: lunar.month,
    day: lunar.day,
    isLeapMonth: Boolean(lunar.isLeapMonth),
  };
}

/**
 * @param {string} dateKey
 */
function lunarYearOfDateKey(dateKey) {
  const date = parseDateKey(dateKey);
  return toLunar(date.getFullYear(), date.getMonth() + 1, date.getDate()).year;
}

/**
 * @param {{ year: number, month: number, day: number, isLeapMonth: boolean }} lunarStart
 * @param {string} seriesStart
 * @param {string} hardLimit
 * @param {(candidate: string) => boolean} pushIfAllowed return false to stop
 */
export function collectLunarYearlyStarts(lunarStart, seriesStart, hardLimit, pushIfAllowed) {
  const lastYear = lunarYearOfDateKey(hardLimit) + 1;
  for (let year = lunarStart.year; year <= lastYear; year += 1) {
    const candidate = lunarToSolarDateKey(
      year,
      lunarStart.month,
      lunarStart.day,
      lunarStart.isLeapMonth,
    );
    if (!candidate) continue;
    if (candidate < seriesStart) continue;
    if (candidate > hardLimit) break;
    if (!pushIfAllowed(candidate)) break;
  }
}

/**
 * @param {{ year: number, month: number, day: number, isLeapMonth: boolean }} lunarStart
 * @param {string} seriesStart
 * @param {string} hardLimit
 * @param {(candidate: string) => boolean} pushIfAllowed return false to stop
 */
export function collectLunarMonthlyStarts(lunarStart, seriesStart, hardLimit, pushIfAllowed) {
  const total = LunarData.getTotalMonths(
    lunarStart.year,
    lunarStart.month,
    Boolean(lunarStart.isLeapMonth),
  );
  const maxSteps = 2400;

  for (let step = 0; step < maxSteps; step += 1) {
    const info = LunarData.fromTotalMonths(total + step);
    if (!info?.year || !info?.month) break;
    const candidate = lunarToSolarDateKey(
      info.year,
      info.month,
      lunarStart.day,
      Boolean(info.isLeapMonth),
    );
    if (!candidate) continue;
    if (candidate < seriesStart) continue;
    if (candidate > hardLimit) break;
    if (!pushIfAllowed(candidate)) break;
  }
}
