import { toLunar } from 'kor-lunar';
import { getSolarTermLabel } from './solarTerms.js';

/** Soft cap so long sessions cannot grow these maps without bound. */
const DAY_CACHE_MAX = 400;

/** @type {Map<string, ReturnType<typeof computeLunarInfo>>} */
const lunarInfoCache = new Map();
/** @type {Map<string, ReturnType<typeof computeDayParts>>} */
const dayPartsCache = new Map();

/**
 * @param {Map<string, unknown>} cache
 * @param {string} key
 * @param {unknown} value
 */
function setCapped(cache, key, value) {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  if (cache.size > DAY_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest != null) cache.delete(oldest);
  }
}

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 */
function computeLunarInfo(year, month, day) {
  try {
    const lunar = toLunar(year, month, day);
    return {
      day: lunar.day,
      month: lunar.month,
      year: lunar.year,
      isLeapMonth: Boolean(lunar.isLeapMonth),
      secha: lunar.secha ?? '',
      wolgeon: lunar.wolgeon ?? '',
    };
  } catch {
    return { day: 0, month: 0, year: 0, isLeapMonth: false, secha: '', wolgeon: '' };
  }
}

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 */
export function getLunarInfo(year, month, day) {
  const key = `${year}-${month}-${day}`;
  let cached = lunarInfoCache.get(key);
  if (!cached) {
    cached = computeLunarInfo(year, month, day);
    setCapped(lunarInfoCache, key, cached);
  }
  return cached;
}

/**
 * @param {{ day: number, month: number, isLeapMonth?: boolean }} lunar
 * @returns {string | null}
 */
export function formatLunarDayLabel(lunar) {
  if (!lunar?.day) return null;
  const month = lunar.isLeapMonth ? `윤${lunar.month}` : `${lunar.month}`;
  return `${month}. ${lunar.day}.`;
}

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 */
function computeDayParts(year, month, day) {
  const lunar = getLunarInfo(year, month, day);
  return {
    solar: day,
    lunar: formatLunarDayLabel(lunar),
    lunarDay: lunar.day || null,
    solarTerm: getSolarTermLabel(year, month, day),
  };
}

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 */
export function getDayParts(year, month, day) {
  const key = `${year}-${month}-${day}`;
  let cached = dayPartsCache.get(key);
  if (!cached) {
    cached = computeDayParts(year, month, day);
    setCapped(dayPartsCache, key, cached);
  }
  return cached;
}

/**
 * @param {number} year
 * @param {number} month 1-12
 */
export function getLunarMonthLabel(year, month) {
  const start = getLunarInfo(year, month, 1);
  const lastDay = new Date(year, month, 0).getDate();
  const end = getLunarInfo(year, month, lastDay);

  const startMonth = start.isLeapMonth ? `윤${start.month}` : `${start.month}`;
  const endMonth = end.isLeapMonth ? `윤${end.month}` : `${end.month}`;
  const yearLabel = start.secha ? `${start.secha}년` : '';

  if (startMonth === endMonth) {
    return `${yearLabel} ${startMonth}월`.trim();
  }
  return `${yearLabel} ${startMonth}월 ~ ${endMonth}월`.trim();
}

/** @deprecated use getDayParts */
export function formatSolarLunarDate(year, month, day) {
  const { solar, lunar } = getDayParts(year, month, day);
  if (!lunar) return String(solar);
  return `${solar} (${lunar})`;
}
