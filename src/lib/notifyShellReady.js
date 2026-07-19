/** Notify shell (WPF WebView2 / Neutralino iframe) that calendar UI is ready. */
export function notifyShellReady() {
  try {
    window.chrome?.webview?.postMessage?.({ type: 'content-ready' });
  } catch {
    /* ignore */
  }
  if (window.self === window.top) {
    return;
  }
  try {
    window.parent.postMessage({ type: 'mycalendar:content-ready' }, '*');
  } catch {
    /* ignore cross-origin edge cases */
  }
}
