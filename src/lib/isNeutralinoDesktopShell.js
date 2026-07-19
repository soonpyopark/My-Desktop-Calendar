import { isNativeHost } from './nativeHost.js';

/**
 * True when running as the wallpaper DesktopHost surface (dual-HWND).
 * Settings/search open on App after permanent window unlock; auth/export/editors may temp-unlock.
 */
export function isDesktopSurfaceHost() {
  try {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('surface') === 'desktop';
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
