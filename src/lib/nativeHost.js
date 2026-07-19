/**
 * Native WPF host bridge (WebView2). Replaces HTTP /api and WebSocket when available.
 */

const pending = new Map();
let requestSeq = 0;
const eventListeners = new Set();

function isNativeHost() {
  try {
    return Boolean(window.chrome?.webview?.postMessage);
  } catch {
    return false;
  }
}

function ensureListener() {
  if (!isNativeHost() || window.__myCalNativeBridgeBound) return;
  window.__myCalNativeBridgeBound = true;
  window.chrome.webview.addEventListener('message', (event) => {
    let data = event.data;
    // WebView2 may deliver PostWebMessageAsJson as a string in some builds.
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!data || typeof data !== 'object') return;

    if (data.type === 'response' && data.id) {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.result ?? null);
      else entry.reject(new Error(data.error || 'Native bridge error'));
      return;
    }

    for (const listener of eventListeners) {
      try {
        listener(data);
      } catch {
        /* ignore */
      }
    }
  });
}

function getAuthToken() {
  try {
    return (
      localStorage.getItem('my-calendar-auth-token')
      ?? sessionStorage.getItem('my-calendar-auth-token')
      ?? null
    );
  } catch {
    return null;
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 */
export async function nativeRequest(method, path, body) {
  if (!isNativeHost()) {
    throw new Error('Native host unavailable');
  }
  ensureListener();
  const id = `req-${Date.now()}-${++requestSeq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.chrome.webview.postMessage({
      id,
      method,
      path,
      body: body ?? null,
      token: getAuthToken(),
    });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('Native bridge timeout'));
      }
    }, 60000);
  });
}

export function onNativeEvent(listener) {
  ensureListener();
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export { isNativeHost };
