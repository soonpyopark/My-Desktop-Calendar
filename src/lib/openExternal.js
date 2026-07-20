import { isAppOffline, showOfflineNotice, urlRequiresInternet } from './offlineNotice.js';
import { isNativeHost, nativeRequest } from './nativeHost.js';

/**
 * Open an http(s) URL in the appropriate browser for this runtime.
 *
 * - Desktop WebView2: ask the native host to ShellExecute on this PC.
 * - Regular browser (incl. LAN clients of start_server): window.open in *this* browser.
 *   Never POST /api/app/open-external from a browser — that would open the link on the
 *   server host instead of the client.
 * - Public internet URLs are blocked with a shared offline modal when `navigator.onLine` is false.
 *   localhost / private LAN URLs still open offline.
 *
 * Never navigate the current calendar tab (`location.assign`) — a failed popup must stay
 * on the calendar. Also never pre-open `about:blank` with `noopener` (browsers return
 * null for the handle, leaving a stuck blank tab plus a second real tab).
 */
export async function openExternalUrl(url) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) {
    return;
  }

  // Offline check is synchronous; only await the dialog when we already know we're offline
  // so a successful open still runs under the click's user gesture (no popup blocker).
  if (urlRequiresInternet(target) && isAppOffline()) {
    await showOfflineNotice('외부 링크를 열려면 인터넷 연결이 필요합니다.');
    return;
  }

  if (isNativeHost()) {
    try {
      await nativeRequest('POST', '/api/app/open-external', { url: target });
      return;
    } catch {
      /* fall through */
    }

    if (window.myCalendar?.openExternal) {
      try {
        await window.myCalendar.openExternal(target);
        return;
      } catch {
        /* fall through */
      }
    }
  }

  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'mycalendar:open-external', url: target }, '*');
      return;
    }
  } catch {
    /* fall through */
  }

  window.open(target, '_blank', 'noopener,noreferrer');
}
