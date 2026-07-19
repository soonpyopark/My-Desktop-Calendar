import { COLOR_SCHEME_OPTIONS, DEFAULT_VIEW_OPTIONS } from '../../shared/constants.js';

/** @typedef {'light' | 'dark' | 'system'} ColorScheme */

export const COLOR_SCHEME_STORAGE_KEY = 'mycalendar.colorScheme';
export const COLOR_SCHEME_EFFECTIVE_KEY = 'mycalendar.colorSchemeEffective';

/** @type {MediaQueryList | null} */
let systemMediaQuery = null;

/** @type {(() => void) | null} */
let systemMediaHandler = null;

/**
 * @param {unknown} value
 * @returns {ColorScheme}
 */
export function normalizeColorScheme(value) {
  return COLOR_SCHEME_OPTIONS.includes(value) ? value : DEFAULT_VIEW_OPTIONS.colorScheme;
}

/**
 * @returns {ColorScheme | null}
 */
export function readStoredColorScheme() {
  try {
    const raw = localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    if (raw && COLOR_SCHEME_OPTIONS.includes(raw)) {
      return /** @type {ColorScheme} */ (raw);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @returns {'light' | 'dark' | null}
 */
export function readStoredEffectiveColorScheme() {
  try {
    const raw = localStorage.getItem(COLOR_SCHEME_EFFECTIVE_KEY);
    if (raw === 'dark' || raw === 'light') {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param {unknown} mode
 * @returns {'light' | 'dark'}
 */
export function resolveEffectiveColorScheme(mode) {
  const normalized = normalizeColorScheme(mode);
  if (normalized === 'dark') return 'dark';
  if (normalized === 'light') return 'light';
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function persistScheme(normalized, effective) {
  try {
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, normalized);
    localStorage.setItem(COLOR_SCHEME_EFFECTIVE_KEY, effective);
  } catch {
    /* ignore */
  }
}

function detachSystemListener() {
  if (systemMediaQuery && systemMediaHandler) {
    systemMediaQuery.removeEventListener('change', systemMediaHandler);
  }
  systemMediaQuery = null;
  systemMediaHandler = null;
}

/**
 * Apply theme class/colors without waiting for React store.
 * @param {unknown} mode
 */
export function applyColorScheme(mode) {
  if (typeof document === 'undefined') return;

  const normalized = normalizeColorScheme(mode);
  const effective = resolveEffectiveColorScheme(normalized);
  const root = document.documentElement;
  const dark = effective === 'dark';

  // Already applied — skip class/style churn that flashes the whole UI (e.g. opening Settings).
  if (
    root.dataset.colorScheme === normalized
    && root.classList.contains('dark') === dark
    && root.style.colorScheme === effective
  ) {
    if (normalized === 'system' && !systemMediaQuery) {
      /* fall through to (re)attach system listener below */
    } else {
      return;
    }
  }

  root.classList.toggle('dark', dark);
  root.dataset.colorScheme = normalized;
  root.style.colorScheme = effective;
  // Do not set solid backgroundColor here — CSS theme variables control the page fill.
  root.style.removeProperty('background-color');
  if (document.body) {
    document.body.style.removeProperty('background-color');
  }
  persistScheme(normalized, effective);

  try {
    window.dispatchEvent(
      new CustomEvent('mycalendar:colorSchemeEffective', {
        detail: { dark, scheme: normalized },
      }),
    );
  } catch {
    /* ignore */
  }

  detachSystemListener();

  if (normalized !== 'system') return;

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    const nextDark = mq.matches;
    root.classList.toggle('dark', nextDark);
    root.style.colorScheme = nextDark ? 'dark' : 'light';
    root.style.removeProperty('background-color');
    if (document.body) {
      document.body.style.removeProperty('background-color');
    }
    persistScheme('system', nextDark ? 'dark' : 'light');
    try {
      window.dispatchEvent(
        new CustomEvent('mycalendar:colorSchemeEffective', {
          detail: { dark: nextDark, scheme: 'system' },
        }),
      );
    } catch {
      /* ignore */
    }
  };
  mq.addEventListener('change', handler);
  systemMediaQuery = mq;
  systemMediaHandler = handler;
}

/**
 * Boot theme before React mounts (localStorage → system).
 * @returns {ColorScheme}
 */
export function bootstrapColorScheme() {
  const stored = readStoredColorScheme();
  const mode = stored ?? DEFAULT_VIEW_OPTIONS.colorScheme;
  applyColorScheme(mode);
  return mode;
}

/**
 * @param {unknown} viewOptions
 * @returns {ColorScheme}
 */
export function getColorScheme(viewOptions) {
  return normalizeColorScheme(viewOptions?.colorScheme ?? DEFAULT_VIEW_OPTIONS.colorScheme);
}
