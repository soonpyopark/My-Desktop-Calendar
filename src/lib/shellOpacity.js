import { DEFAULT_SETTINGS } from '../../shared/constants.js';

/** @param {unknown} value */
export function normalizeShellOpacity(value) {
  const raw = Number(value);
  const clamped = Number.isFinite(raw)
    ? Math.min(1, Math.max(0.05, raw))
    : DEFAULT_SETTINGS.widget.opacity;
  return Math.round(clamped * 20) / 20;
}

/**
 * Opacity is applied by the native shell (host HWND LWA_ALPHA when &lt; 100%).
 * CSS fills stay solid so the calendar stays readable.
 * @param {unknown} opacity
 */
export function applyShellOpacity(opacity) {
  if (typeof document === 'undefined') return;
  const alpha = normalizeShellOpacity(opacity);
  const root = document.documentElement;
  root.style.setProperty('--shell-opacity', String(alpha));
  // Clear any previous CSS rgba overrides from older builds.
  root.style.removeProperty('--gcal-page');
  root.style.removeProperty('--gcal-page-alt');
  root.style.removeProperty('--gcal-surface');
  root.style.removeProperty('--gcal-surface-2');
  root.style.removeProperty('--gcal-in-month-bg');
  root.style.removeProperty('--gcal-week-chrome-bg');
  root.style.removeProperty('--gcal-other-month-bg');
}
