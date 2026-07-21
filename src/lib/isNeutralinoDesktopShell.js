import { isNativeHost } from './nativeHost.js';

/**
 * True when the calendar is in desktop (locked) mode — always-on-bottom, chrome locked.
 * Backed by widgetStatus.embedded (see desktop-bridge.js).
 * Name kept for call-site compatibility.
 */
export function isDesktopSurfaceHost() {
  try {
    if (typeof window === 'undefined') return false;
    return Boolean(window.__myCalDesktopEmbedded);
  } catch {
    return false;
  }
}

/**
 * True when the calendar UI runs inside a desktop shell
 * (WPF WebView2 native host, or Neutralino iframe).
 */
export function isNeutralinoDesktopShell() {
  try {
    if (typeof window === 'undefined') return false;
    if (isNativeHost()) return true;
    return window.parent !== window;
  } catch {
    return false;
  }
}
