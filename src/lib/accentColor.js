import { DEFAULT_VIEW_OPTIONS } from '../../shared/constants.js';

/** @typedef {string} AccentColor Hex color, e.g. from CALENDAR_COLOR_PALETTE. */

export const ACCENT_COLOR_STORAGE_KEY = 'mycalendar.accentColor';

const ACCENT_STYLE_ELEMENT_ID = 'mycalendar-accent-color-style';
const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * @param {unknown} value
 * @returns {AccentColor}
 */
export function normalizeAccentColor(value) {
  return typeof value === 'string' && HEX_PATTERN.test(value)
    ? value.toLowerCase()
    : DEFAULT_VIEW_OPTIONS.accentColor;
}

/**
 * @returns {AccentColor | null}
 */
export function readStoredAccentColor() {
  try {
    const raw = localStorage.getItem(ACCENT_COLOR_STORAGE_KEY);
    if (raw && HEX_PATTERN.test(raw)) {
      return raw.toLowerCase();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function hexToRgb(hex) {
  const n = hex.replace('#', '');
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16),
  };
}

function toHexByte(value) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

/** Mix `hex` toward `mixColor`; `weight` is the portion of `hex` kept (1 = all hex, 0 = all mixColor). */
function mix(hex, mixColor, weight) {
  const a = hexToRgb(hex);
  const b = hexToRgb(mixColor);
  return `#${[
    toHexByte(a.r * weight + b.r * (1 - weight)),
    toHexByte(a.g * weight + b.g * (1 - weight)),
    toHexByte(a.b * weight + b.b * (1 - weight)),
  ].join('')}`;
}

/**
 * Derive the light/dark-mode --gcal-blue/-soft/-dark trio from a single accent hex — mirrors the
 * base/soft/readable-text relationship the built-in blue theme already uses, generalized so any
 * palette color (including very light/dark ones) still yields a usable soft background and a
 * readable "text on soft" shade in both color schemes.
 * @param {string} hex
 */
function deriveAccentVars(hex) {
  return {
    light: {
      base: hex,
      soft: mix(hex, '#ffffff', 0.12),
      dark: mix(hex, '#000000', 0.72),
    },
    dark: {
      base: mix(hex, '#ffffff', 0.65),
      soft: mix(hex, '#202124', 0.3),
      dark: mix(hex, '#ffffff', 0.55),
    },
  };
}

function ensureStyleElement() {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(ACCENT_STYLE_ELEMENT_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = ACCENT_STYLE_ELEMENT_ID;
    document.head.appendChild(el);
  }
  return el;
}

/**
 * Apply accent color without waiting for React store. Injects a small stylesheet (rather than
 * inline vars) so the existing `.dark` selector keeps driving which variant is active — no need
 * to re-run this when light/dark mode toggles.
 * @param {unknown} value
 */
export function applyAccentColor(value) {
  if (typeof document === 'undefined') return;

  const normalized = normalizeAccentColor(value);
  const root = document.documentElement;

  if (root.dataset.accentColor === normalized) return;

  const { light, dark } = deriveAccentVars(normalized);
  const style = ensureStyleElement();
  if (style) {
    style.textContent =
      `:root{--gcal-blue:${light.base};--gcal-blue-soft:${light.soft};--gcal-blue-dark:${light.dark};}`
      + `.dark{--gcal-blue:${dark.base};--gcal-blue-soft:${dark.soft};--gcal-blue-dark:${dark.dark};}`;
  }

  root.dataset.accentColor = normalized;
  try {
    localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, normalized);
  } catch {
    /* ignore */
  }
}

/**
 * Boot accent color before React mounts (localStorage → default).
 * @returns {AccentColor}
 */
export function bootstrapAccentColor() {
  const stored = readStoredAccentColor();
  const mode = stored ?? DEFAULT_VIEW_OPTIONS.accentColor;
  applyAccentColor(mode);
  return mode;
}

/**
 * @param {unknown} viewOptions
 * @returns {AccentColor}
 */
export function getAccentColor(viewOptions) {
  return normalizeAccentColor(viewOptions?.accentColor ?? DEFAULT_VIEW_OPTIONS.accentColor);
}
