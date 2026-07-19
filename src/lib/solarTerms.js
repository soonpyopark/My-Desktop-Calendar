import solarLunar from 'solarlunar';

/**
 * 24절기(節氣) — `solarlunar`가 반환하는 한자 절기명 → 한글 표기.
 * 순서: 소한 대한 입춘 우수 경칩 춘분 청명 곡우 입하 소만 망종 하지
 *       소서 대서 입추 처서 백로 추분 한로 상강 입동 소설 대설 동지
 */
const SOLAR_TERM_KO = {
  小寒: '소한',
  大寒: '대한',
  立春: '입춘',
  雨水: '우수',
  惊蛰: '경칩',
  春分: '춘분',
  清明: '청명',
  谷雨: '곡우',
  立夏: '입하',
  小满: '소만',
  芒种: '망종',
  夏至: '하지',
  小暑: '소서',
  大暑: '대서',
  立秋: '입추',
  处暑: '처서',
  白露: '백로',
  秋分: '추분',
  寒露: '한로',
  霜降: '상강',
  立冬: '입동',
  小雪: '소설',
  大雪: '대설',
  冬至: '동지',
};

/**
 * `solarlunar`가 지원하는 연도 범위(1900~2100) 밖이거나 계산이 실패하면 null.
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @returns {string | null} 해당 날짜가 절기 시작일이면 한글 절기명, 아니면 null.
 */
export function getSolarTermLabel(year, month, day) {
  if (year < 1900 || year > 2100) return null;
  try {
    const info = solarLunar.solar2lunar(year, month, day);
    if (info?.isTerm && info.term) {
      return SOLAR_TERM_KO[info.term] ?? null;
    }
  } catch {
    /* out-of-range / invalid date — no term */
  }
  return null;
}
