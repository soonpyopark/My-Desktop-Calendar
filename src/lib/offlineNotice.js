/**
 * Shared offline guidance for features that need the public internet.
 */

export const OFFLINE_NOTICE_TITLE = '인터넷 연결 필요';

export const OFFLINE_NOTICE_BODY =
  '이 기능은 인터넷에 연결되어 있을 때만 사용할 수 있습니다.\n네트워크 연결을 확인한 뒤 다시 시도해 주세요.';

/** @type {null | ((opts: { title?: string, message: string }) => Promise<void>)} */
let noticeHandler = null;

/**
 * Register UI dialog bridge (from AppDialogProvider). Pass null on unmount.
 * @param {null | ((opts: { title?: string, message: string }) => Promise<void>)} handler
 */
export function setOfflineNoticeHandler(handler) {
  noticeHandler = typeof handler === 'function' ? handler : null;
}

/** @returns {boolean} */
export function isAppOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Whether opening this URL needs the public internet (not localhost / private LAN / file).
 * @param {unknown} url
 * @returns {boolean}
 */
export function urlRequiresInternet(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return true;
  }

  if (parsed.protocol === 'file:') return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '0.0.0.0'
  ) {
    return false;
  }

  // IPv4 private / link-local
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 10) return false;
    if (parts[0] === 192 && parts[1] === 168) return false;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    if (parts[0] === 169 && parts[1] === 254) return false;
    if (parts[0] === 127) return false;
  }

  // IPv6 ULA / link-local
  if (host.includes(':')) {
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return false;
  }

  return true;
}

/**
 * Show the shared offline modal. Resolves when the user dismisses it.
 * @param {string} [featureLine] Optional one-line feature context above the body.
 */
export async function showOfflineNotice(featureLine) {
  const message = featureLine
    ? `${featureLine}\n\n${OFFLINE_NOTICE_BODY}`
    : OFFLINE_NOTICE_BODY;

  if (noticeHandler) {
    await noticeHandler({ title: OFFLINE_NOTICE_TITLE, message });
    return;
  }

  // Fallback before the dialog provider mounts (should be rare).
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(`${OFFLINE_NOTICE_TITLE}\n\n${message}`);
  }
}

/**
 * @param {string} [featureLine]
 * @returns {Promise<boolean>} true if online (caller may proceed)
 */
export async function ensureOnlineOrNotify(featureLine) {
  if (!isAppOffline()) return true;
  await showOfflineNotice(featureLine);
  return false;
}
