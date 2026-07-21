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

const THEME_ANIM_MS = 280;
/** @type {ReturnType<typeof setTimeout> | null} */
let themeAnimTimer = null;

/**
 * @param {HTMLElement} root
 * @param {{ dark: boolean, scheme: ColorScheme, effective: 'light' | 'dark' }} next
 */
function paintColorScheme(root, { dark, scheme, effective }) {
  root.classList.toggle('dark', dark);
  root.dataset.colorScheme = scheme;
  root.style.colorScheme = effective;
  // Do not set solid backgroundColor here — CSS theme variables control the page fill.
  root.style.removeProperty('background-color');
  if (document.body) {
    document.body.style.removeProperty('background-color');
  }
  persistScheme(scheme, effective);

  try {
    window.dispatchEvent(
      new CustomEvent('mycalendar:colorSchemeEffective', {
        detail: { dark, scheme },
      }),
    );
  } catch {
    /* ignore */
  }
}

/**
 * Cross-fade light↔dark instead of an instant hard cut.
 * @param {() => void} apply
 */
function runThemeTransition(apply) {
  if (typeof document === 'undefined') {
    apply();
    return;
  }

  const root = document.documentElement;
  if (typeof document.startViewTransition === 'function') {
    try {
      document.startViewTransition(apply);
      return;
    } catch {
      /* fall through to CSS class animation */
    }
  }

  root.classList.add('theme-animating');
  apply();
  if (themeAnimTimer != null) {
    clearTimeout(themeAnimTimer);
  }
  themeAnimTimer = setTimeout(() => {
    themeAnimTimer = null;
    root.classList.remove('theme-animating');
  }, THEME_ANIM_MS);
}

/**
 * Apply theme class/colors without waiting for React store.
 * @param {unknown} mode
 * @param {{ animate?: boolean }} [options]
 *   animate — cross-fade when the effective light/dark flips (default true).
 *   Boot / first paint should pass false so the shell does not fade in.
 */
export function applyColorScheme(mode, { animate = true } = {}) {
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

  const hadPriorScheme = Boolean(root.dataset.colorScheme);
  const schemeChanged = root.dataset.colorScheme !== normalized
    || root.classList.contains('dark') !== dark;

  const paint = () => paintColorScheme(root, { dark, scheme: normalized, effective });
  // Only animate user-driven flips after an initial scheme is already painted.
  if (animate && hadPriorScheme && schemeChanged) {
    runThemeTransition(paint);
  } else {
    paint();
  }

  detachSystemListener();

  if (normalized !== 'system') return;

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    const nextDark = mq.matches;
    const nextEffective = nextDark ? 'dark' : 'light';
    if (root.classList.contains('dark') === nextDark && root.style.colorScheme === nextEffective) {
      return;
    }
    runThemeTransition(() => {
      paintColorScheme(root, { dark: nextDark, scheme: 'system', effective: nextEffective });
    });
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
  applyColorScheme(mode, { animate: false });
  return mode;
}

/**
 * @param {unknown} viewOptions
 * @returns {ColorScheme}
 */
export function getColorScheme(viewOptions) {
  return normalizeColorScheme(viewOptions?.colorScheme ?? DEFAULT_VIEW_OPTIONS.colorScheme);
}
