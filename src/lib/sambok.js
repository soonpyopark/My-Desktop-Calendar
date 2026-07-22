import solarLunar from 'solarlunar';

/**
 * 삼복(三伏): 하지 뒤 세 번째·네 번째 경일(庚日)이 초복·중복,
 * 입추 당일 포함 첫 경일이 말복.
 * `solarlunar` 연도 범위(1900~2100) 밖이면 빈 맵.
 */

/** @type {Map<number, Map<string, string>>} year → "M-D" → label */
const yearCache = new Map();

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 */
function dateKey(month, day) {
  return `${month}-${day}`;
}

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @param {number} delta
 * @returns {[number, number, number]}
 */
function addDays(year, month, day, delta) {
  const dt = new Date(year, month - 1, day + delta);
  return [dt.getFullYear(), dt.getMonth() + 1, dt.getDate()];
}

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 */
function isGengDay(year, month, day) {
  try {
    const info = solarLunar.solar2lunar(year, month, day);
    return Boolean(info?.gzDay && String(info.gzDay).startsWith('庚'));
  } catch {
    return false;
  }
}

/**
 * @param {number} year
 * @returns {Map<string, string>}
 */
function buildYearSambok(year) {
  /** @type {Map<string, string>} */
  const map = new Map();
  if (year < 1900 || year > 2100) return map;

  try {
    // solarlunar getTerm(y, n): n=12 하지(6월), n=15 입추(8월) — day-of-month.
    const xiaZhiDay = solarLunar.getTerm(year, 12);
    const liQiuDay = solarLunar.getTerm(year, 15);
    if (!xiaZhiDay || !liQiuDay) return map;

    /** @type {[number, number, number][]} */
    const gengAfterXiaZhi = [];
    for (let i = 1; i <= 80 && gengAfterXiaZhi.length < 4; i += 1) {
      const [y, m, d] = addDays(year, 6, xiaZhiDay, i);
      if (y !== year) continue;
      if (isGengDay(y, m, d)) gengAfterXiaZhi.push([y, m, d]);
    }

    const cho = gengAfterXiaZhi[2];
    const jung = gengAfterXiaZhi[3];
    if (cho) map.set(dateKey(cho[1], cho[2]), '초복');
    if (jung) map.set(dateKey(jung[1], jung[2]), '중복');

    for (let i = 0; i <= 40; i += 1) {
      const [y, m, d] = addDays(year, 8, liQiuDay, i);
      if (y !== year) break;
      if (isGengDay(y, m, d)) {
        map.set(dateKey(m, d), '말복');
        break;
      }
    }
  } catch {
    /* out-of-range / invalid */
  }

  return map;
}

/**
 * @param {number} year
 * @returns {Map<string, string>}
 */
function getYearMap(year) {
  let cached = yearCache.get(year);
  if (!cached) {
    cached = buildYearSambok(year);
    yearCache.set(year, cached);
    // Soft cap — keep recent years only.
    if (yearCache.size > 40) {
      const oldest = yearCache.keys().next().value;
      if (oldest != null) yearCache.delete(oldest);
    }
  }
  return cached;
}

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @returns {string | null} 초복 | 중복 | 말복
 */
export function getSambokLabel(year, month, day) {
  if (year < 1900 || year > 2100) return null;
  return getYearMap(year).get(dateKey(month, day)) ?? null;
}
