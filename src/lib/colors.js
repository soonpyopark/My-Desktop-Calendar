import {
  CALENDAR_EVENT_BG_OPACITY,
  CALENDAR_EVENT_BG_OPACITY_LIGHT,
  CALENDAR_EVENT_INK_DEPTH_LIGHT,
} from '../../shared/calendarColorPalette.js';

/** Google Calendar 기본 팔레트 */
export const GOOGLE_COLORS = {
  peacock: { base: '#039be5', bg: '#d2e3fc', text: '#174ea6', label: '파랑' },
  blueberry: { base: '#3f51b5', bg: '#d3d9f8', text: '#283593', label: '남색' },
  lavender: { base: '#7986cb', bg: '#e8eaf6', text: '#3949ab', label: '연보라' },
  grape: { base: '#8e24aa', bg: '#f3e5f5', text: '#6a1b9a', label: '자주' },
  flamingo: { base: '#e67c73', bg: '#fce8e6', text: '#c5221f', label: '연분홍' },
  basil: { base: '#0b8043', bg: '#ceead6', text: '#0d652d', label: '진녹색' },
  sage: { base: '#33b679', bg: '#e6f4ea', text: '#137333', label: '녹색' },
  banana: { base: '#f6bf26', bg: '#fef7e0', text: '#b06000', label: '노랑' },
  tangerine: { base: '#f4511e', bg: '#feefe3', text: '#e8710a', label: '주황' },
  tomato: { base: '#d50000', bg: '#fce8e6', text: '#c5221f', label: '빨강' },
  graphite: { base: '#616161', bg: '#f1f3f4', text: '#3c4043', label: '회색' },
};

/** @type {Record<string, { base: string, bg: string, text: string }>} */
const paletteByBase = Object.fromEntries(
  Object.values(GOOGLE_COLORS).map((c) => [c.base.toLowerCase(), c]),
);

function isDarkMode() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

function resolveEventBgOpacity() {
  return isDarkMode() ? CALENDAR_EVENT_BG_OPACITY : CALENDAR_EVENT_BG_OPACITY_LIGHT;
}

/**
 * Darken `hex` toward black by `depth` (1.3 = 130% 진하게 → keep ~77% of original).
 * @param {string} hex
 * @param {number} [depth]
 */
function deepenInk(hex, depth = CALENDAR_EVENT_INK_DEPTH_LIGHT) {
  const safe = Math.max(depth, 1);
  return mixHex(hex, '#000000', 1 / safe);
}

/**
 * @param {string} [hex]
 */
export function getCalendarTheme(hex = '#039be5') {
  const key = hex.toLowerCase();
  const dark = isDarkMode();
  const opacity = resolveEventBgOpacity();

  if (paletteByBase[key]) {
    const preset = paletteByBase[key];
    if (dark) {
      return { ...preset, accent: preset.base };
    }
    return {
      base: preset.base,
      bg: mixHex(hex, '#ffffff', opacity),
      text: deepenInk(preset.text),
      accent: deepenInk(preset.base),
    };
  }

  const text = themeTextForHex(hex);
  return {
    base: hex,
    bg: mixHex(hex, '#ffffff', opacity),
    text: dark ? text : deepenInk(text),
    accent: dark ? hex : deepenInk(hex),
  };
}

/**
 * @param {string} hex
 */
function themeTextForHex(hex) {
  const key = hex.toLowerCase();
  if (key === '#ffffff' || key === '#fff') return '#4a4a4a';
  return hex;
}

/**
 * @param {string} [hex]
 */
export function getEventStyle(hex) {
  const theme = getCalendarTheme(hex);
  const accent = theme.accent ?? theme.base;
  return {
    '--event-bg': theme.bg,
    '--event-text': theme.text,
    '--event-accent': accent,
    backgroundColor: theme.bg,
    color: theme.text,
    borderLeft: `3px solid ${accent}`,
  };
}

/**
 * @param {string} hex
 * @param {string} mix
 * @param {number} weight 0~1 (1 = all hex)
 */
function mixHex(hex, mix, weight) {
  const a = hexToRgb(hex);
  const b = hexToRgb(mix);
  if (!a || !b) return hex;

  const r = Math.round(a.r * weight + b.r * (1 - weight));
  const g = Math.round(a.g * weight + b.g * (1 - weight));
  const bl = Math.round(a.b * weight + b.b * (1 - weight));
  return `#${[r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * @param {string} hex
 */
function hexToRgb(hex) {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) return null;
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

/**
 * @param {number} dayOfWeek 0=Sun
 * @returns {'text-gcal-sunday' | 'text-gcal-saturday' | ''}
 */
export function getWeekdayTextClass(dayOfWeek) {
  if (dayOfWeek === 0) return 'text-gcal-sunday';
  if (dayOfWeek === 6) return 'text-gcal-saturday';
  return '';
}

/**
 * @param {number} dayOfWeek 0=Sun
 * @returns {'sunday' | 'saturday' | ''}
 */
export function getWeekdayCellClass(dayOfWeek) {
  if (dayOfWeek === 0) return 'sunday';
  if (dayOfWeek === 6) return 'saturday';
  return '';
}

/** @deprecated use getWeekdayTextClass or getWeekdayCellClass */
export function getWeekdayClass(dayOfWeek) {
  return getWeekdayTextClass(dayOfWeek);
}
