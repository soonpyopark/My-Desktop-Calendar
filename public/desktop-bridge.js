(() => {
  const nativePending = new Map();
  let nativeSeq = 0;

  function isNativeHost() {
    try {
      return Boolean(window.chrome?.webview?.postMessage);
    } catch {
      return false;
    }
  }

  /** Single-HWND shell — always the app surface. */
  function currentSurface() {
    return 'app';
  }

  function ensureNativeListener() {
    if (!isNativeHost() || window.__myCalDesktopBridgeNative) return;
    window.__myCalDesktopBridgeNative = true;
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
        const entry = nativePending.get(data.id);
        if (!entry) return;
        nativePending.delete(data.id);
        if (data.ok) entry.resolve(data.result ?? null);
        else entry.reject(new Error(data.error || 'Native bridge error'));
        return;
      }
      if (data.type === 'widget-status' && data.status) {
        dispatchWidgetStatus(data.status);
      }
      if (data.type === 'foreground-session-ended') {
        window.dispatchEvent(new CustomEvent('mycalendar:foregroundSessionEnded'));
      }
      if (data.type === 'server-mode-changed') {
        window.dispatchEvent(new CustomEvent('mycalendar:serverModeChanged', { detail: data }));
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

  async function api(method, path, body) {
    if (isNativeHost()) {
      ensureNativeListener();
      const id = `bridge-${Date.now()}-${++nativeSeq}`;
      return new Promise((resolve, reject) => {
        nativePending.set(id, { resolve, reject });
        window.chrome.webview.postMessage({
          id,
          method,
          path,
          body: body ?? null,
          token: getAuthToken(),
        });
        setTimeout(() => {
          if (nativePending.has(id)) {
            nativePending.delete(id);
            reject(new Error('Native bridge timeout'));
          }
        }, 60000);
      });
    }

    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error ?? `HTTP ${res.status}`);
    }
    if (res.status === 204) return null;
    const contentType = res.headers.get('Content-Type') ?? '';
    if (!contentType.includes('application/json')) return null;
    return res.json();
  }

  function dispatchWidgetStatus(detail) {
    try {
      // Sync desktop-mode UX flag for isDesktopSurfaceHost() (wallpaper embed).
      window.__myCalDesktopEmbedded = Boolean(detail?.embedded);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent('mycalendar:widgetStatusChanged', { detail }));
    if (detail && typeof detail === 'object') {
      maybeDispatchPendingCreate(detail);
      maybeDispatchPendingEdit(detail);
      maybeDispatchPendingUiAction(detail);
    }
  }

  async function getSyncInfo() {
    const data = await api('GET', '/api/sync-info').catch(() => ({}));
    const running = Boolean(data.running);
    return {
      port: data.port,
      addresses: data.addresses ?? [],
      appUrl: window.location.origin,
      isDev: false,
      running,
      serverRunning: running,
      lanMode: data.lanMode ?? false,
      platform: data.platform ?? null,
    };
  }

  async function getWidgetStatus() {
    // WPF native host OR Neutralino iframe shell both count as desktop shell.
    const inDesktopShell = isNativeHost() || (() => {
      try {
        return window.parent !== window;
      } catch {
        return false;
      }
    })();
    let data;
    try {
      data = await api('GET', '/api/desktop/widget/status');
    } catch {
      // Do not report available:false — that hid window/desktop/web chrome after a transient error.
      data = { available: inDesktopShell };
    }
    const readiness = data?.readiness && typeof data.readiness === 'object' ? data.readiness : null;
    const ready = typeof data?.ready === 'boolean'
      ? data.ready
      : (typeof readiness?.ready === 'boolean' ? readiness.ready : true);
    const checks = Array.isArray(data?.checks)
      ? data.checks
      : (Array.isArray(readiness?.checks) ? readiness.checks : []);
    const status = {
      ...data,
      available: Boolean(data.available) && inDesktopShell,
      ready,
      checks,
    };
    maybeDispatchPendingCreate(status);
    maybeDispatchPendingEdit(status);
    maybeDispatchPendingUiAction(status);
    return status;
  }

  async function getDesktopReadiness() {
    if (!requireNativeHost()) {
      return {
        ready: false,
        checks: [{
          id: 'host',
          ok: false,
          label: '네이티브 셸',
          detail: '바탕화면 모드는 Windows 앱에서만 사용할 수 있습니다',
        }],
      };
    }
    try {
      return await api('GET', '/api/desktop/widget/readiness');
    } catch {
      return { ready: false, checks: [] };
    }
  }

  let lastPendingCreateToken = 0;
  let lastPendingEditToken = 0;
  let lastPendingUiToken = 0;

  function maybeDispatchPendingCreate(status) {
    const dateKey = status?.pendingCreateDate;
    const token = Number(status?.suspendToken) || 0;
    if (!dateKey || !token || token === lastPendingCreateToken) {
      return;
    }
    lastPendingCreateToken = token;
    window.dispatchEvent(
      new CustomEvent('mycalendar:pendingCreate', {
        detail: { dateKey, suspendToken: token },
      }),
    );
  }

  function maybeDispatchPendingEdit(status) {
    const pending = status?.pendingEditEvent;
    const token = Number(status?.suspendToken) || 0;
    if (!pending?.eventId || !pending?.dayKey || !token || token === lastPendingEditToken) {
      return;
    }
    lastPendingEditToken = token;
    window.dispatchEvent(
      new CustomEvent('mycalendar:pendingEdit', {
        detail: { pendingEditEvent: pending, suspendToken: token },
      }),
    );
  }

  function maybeDispatchPendingUiAction(status) {
    const action = status?.pendingUiAction;
    const token = Number(status?.suspendToken) || 0;
    if (!action || !token || token === lastPendingUiToken) {
      return;
    }
    lastPendingUiToken = token;
    window.dispatchEvent(
      new CustomEvent('mycalendar:pendingUiAction', {
        detail: { action, suspendToken: token },
      }),
    );
  }

  /**
   * Chrome/browser web UI shares the CalendarWebServer with the WPF shell.
   * Shell surface / DWM / zone APIs must only run inside WebView2 — browser POSTs
   * used to flash the wallpaper when opening Settings (frame-theme / suspend-ui).
   */
  function requireNativeHost() {
    return isNativeHost();
  }

  async function enterWidgetEditMode() {
    if (!requireNativeHost()) return { available: false };
    const result = await api('POST', '/api/desktop/widget/edit');
    dispatchWidgetStatus(result);
    return result;
  }

  async function showWindow() {
    if (!requireNativeHost()) return { available: false };
    const result = await api('POST', '/api/desktop/window/show');
    dispatchWidgetStatus(result);
    return result;
  }

  async function applyWidgetToDesktop() {
    if (!requireNativeHost()) return { available: false };
    const result = await api('POST', '/api/desktop/widget/apply');
    dispatchWidgetStatus(result);
    return result;
  }

  async function resumeDesktopEmbed() {
    if (!requireNativeHost()) return { available: false };
    // Re-enter wallpaper embed (SetParent SysListView32) after window-mode UI.
    const result = await api('POST', '/api/desktop/widget/resume');
    dispatchWidgetStatus(result);
    return result;
  }

  async function ackPendingCreate() {
    if (!requireNativeHost()) return { ok: true };
    return api('POST', '/api/desktop/widget/ack-create');
  }

  async function ackPendingUiAction() {
    if (!requireNativeHost()) return { ok: true };
    return api('POST', '/api/desktop/widget/ack-ui');
  }

  async function suspendDesktopEmbedForUi(action) {
    if (!requireNativeHost()) return { available: false };
    // Tell native which surface's onClick this came from — under native click
    // passthrough (SysListView32) that surface already ran its own handler locally,
    // so native must not echo the same nav action back to it (double-fire).
    const result = await api('POST', '/api/desktop/widget/suspend-ui', { action, surface: currentSurface() });
    dispatchWidgetStatus(result);
    return result;
  }

  /**
   * Claims the desktop-embed suspend flag before the native shell's deferred first
   * embed (~400ms after load) — used by the login wall so a dialog opened at boot
   * isn't replaced by wallpaper embed. No-ops once shell-parenting has started.
   */
  async function claimBootSuspendForAuth() {
    if (!requireNativeHost()) return { claimed: false };
    try {
      return await api('POST', '/api/desktop/widget/claim-boot-suspend');
    } catch {
      return { claimed: false };
    }
  }

  async function setUiActionZones(payload) {
    if (!requireNativeHost()) return null;
    try {
      return await api('POST', '/api/desktop/widget/ui-zones', payload ?? null);
    } catch {
      return null;
    }
  }

  async function clearUiActionZones() {
    return setUiActionZones(null);
  }

  async function setCreateEventZones(payload) {
    if (!requireNativeHost()) return null;
    try {
      return await api('POST', '/api/desktop/widget/create-zones', payload ?? null);
    } catch {
      return null;
    }
  }

  async function clearCreateEventZones() {
    return setCreateEventZones(null);
  }

  async function setEditEventZones(payload) {
    if (!requireNativeHost()) return null;
    try {
      return await api('POST', '/api/desktop/widget/edit-zones', payload ?? null);
    } catch {
      return null;
    }
  }

  async function clearEditEventZones() {
    return setEditEventZones(null);
  }

  async function setUndockZone(zone) {
    if (!requireNativeHost()) return null;
    try {
      return await api('POST', '/api/desktop/widget/undock-zone', zone ?? {});
    } catch {
      return null;
    }
  }

  async function clearUndockZone() {
    return setUndockZone(null);
  }

  async function requestAppShutdown() {
    try {
      await api('POST', '/api/app/shutdown');
    } catch {
      /* ignore */
    }
    if (window.Neutralino?.app?.exit) {
      await Neutralino.app.exit();
    }
  }

  function postToShell(type, payload = {}) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type, ...payload }, '*');
      }
    } catch {
      /* ignore */
    }
  }

  function beginWindowDrag(screenX, screenY) {
    if (isNativeHost()) {
      void api('POST', '/api/window/drag');
      return;
    }
    postToShell('mycalendar:window-begin-drag', {
      screenX: Number(screenX) || 0,
      screenY: Number(screenY) || 0,
    });
  }

  function minimizeWindow() {
    if (isNativeHost()) {
      void api('POST', '/api/window/minimize');
      return;
    }
    postToShell('mycalendar:window-minimize');
  }

  function toggleWindowMaximize() {
    if (isNativeHost()) {
      void api('POST', '/api/window/maximize');
      return;
    }
    postToShell('mycalendar:window-toggle-maximize');
  }

  function closeWindow() {
    if (isNativeHost()) {
      void api('POST', '/api/window/close');
      return;
    }
    postToShell('mycalendar:window-close');
  }

  /** Desktop mode: raise above other windows (activity session / overlays / tray). */
  function bringWindowToFront() {
    if (isNativeHost()) {
      return api('POST', '/api/window/bring-to-front');
    }
    return Promise.resolve({ ok: true });
  }

  /** Desktop mode: return to always-on-bottom immediately (idle session calls this). */
  function releaseWindowForeground() {
    if (isNativeHost()) {
      return api('POST', '/api/window/release-foreground');
    }
    return Promise.resolve({ ok: true });
  }

  function isWindowMaximized() {
    if (isNativeHost()) {
      return api('GET', '/api/window/is-maximized').then((data) => Boolean(data?.maximized));
    }
    return new Promise((resolve) => {
      const requestId = `max-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const onMessage = (event) => {
        if (event.data?.type !== 'mycalendar:window-is-maximized-result') {
          return;
        }
        if (event.data?.requestId !== requestId) {
          return;
        }
        window.removeEventListener('message', onMessage);
        resolve(Boolean(event.data?.maximized));
      };
      window.addEventListener('message', onMessage);
      postToShell('mycalendar:window-is-maximized', { requestId });
      window.setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve(false);
      }, 800);
    });
  }

  async function setWindowFrameTheme(dark) {
    // Browser must not theme the WPF / DesktopHost stack (wallpaper flash).
    if (!requireNativeHost()) return false;
    try {
      await api('POST', '/api/desktop/window/frame-theme', { dark: Boolean(dark) });
      return true;
    } catch {
      return false;
    }
  }

  async function ensureWindowResizable() {
    if (!requireNativeHost()) return false;
    try {
      const data = await api('POST', '/api/desktop/window/ensure-resizable');
      return Boolean(data?.ok);
    } catch {
      return false;
    }
  }

  /** Push calendar month/week position to the other WebView surface (App ↔ DesktopHost). */
  function publishViewNav({ viewMode, viewDate, selectedDate } = {}) {
    if (!isNativeHost()) return false;
    if (!viewDate || !selectedDate) return false;
    try {
      window.chrome.webview.postMessage({
        type: 'view-nav',
        viewMode: viewMode || 'month',
        viewDate: String(viewDate),
        selectedDate: String(selectedDate),
      });
      return true;
    } catch {
      return false;
    }
  }

  window.myCalendar = {
    __source: 'desktop',
    getSyncInfo,
    getWidgetStatus,
    getDesktopReadiness,
    enterWidgetEditMode,
    showWindow,
    applyWidgetToDesktop,
    resumeDesktopEmbed,
    ackPendingCreate,
    ackPendingUiAction,
    suspendDesktopEmbedForUi,
    claimBootSuspendForAuth,
    setUiActionZones,
    clearUiActionZones,
    setCreateEventZones,
    clearCreateEventZones,
    setEditEventZones,
    clearEditEventZones,
    setUndockZone,
    clearUndockZone,
    requestAppShutdown,
    beginWindowDrag,
    minimizeWindow,
    toggleWindowMaximize,
    closeWindow,
    bringWindowToFront,
    releaseWindowForeground,
    isWindowMaximized,
    setWindowFrameTheme,
    ensureWindowResizable,
    publishViewNav,
    openExternal: async (url) => {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return;

      // Only the desktop WebView may ask the host to ShellExecute. Browser / LAN
      // clients must open links locally — posting /api/app/open-external would
      // launch the URL on the server PC instead of the client's browser.
      if (isNativeHost()) {
        try {
          await api('POST', '/api/app/open-external', { url });
          return;
        } catch {
          /* fall through */
        }
      }

      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'mycalendar:open-external', url }, '*');
          return;
        }
      } catch {
        /* ignore */
      }

      if (window.Neutralino?.os?.open) {
        await Neutralino.os.open(url);
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    showAbout: async () => {
      let appTitle = 'My Desktop Calendar v1.1.9';
      try {
        const data = await api('GET', '/api/health');
        if (data?.name && data?.version) {
          appTitle = `${data.name} v${data.version}`;
        } else if (data?.app && data?.version) {
          appTitle = `${data.app} v${data.version}`;
        }
      } catch {
        /* use default */
      }

      const appName = appTitle.replace(/\s+v[\d.]+$/, '') || 'My Desktop Calendar';
      const content = `${appTitle}\nhttps://note4all.tistory.com`;

      if (Neutralino?.os?.showMessageBox) {
        await Neutralino.os.showMessageBox(appName, content, 'OK', 'INFO');
        return;
      }

      window.alert(content);
    },
  };

  function initNeutralinoDesktop() {
    if (window.self !== window.top) {
      return;
    }
    if (!window.Neutralino?.init || window.__MYCALENDAR_NEU_INIT__) {
      return;
    }
    window.__MYCALENDAR_NEU_INIT__ = true;

    try {
      if (window.NL_TOKEN) {
        sessionStorage.setItem('NL_TOKEN', window.NL_TOKEN);
      } else {
        sessionStorage.removeItem('NL_TOKEN');
      }
    } catch {
      /* ignore */
    }

    Neutralino.events.on('windowClose', () => {
      void (async () => {
        try {
          const status = await getWidgetStatus().catch(() => null);
          if (status?.embedded) {
            return;
          }
        } catch {
          /* fall through to hide */
        }
        if (window.myCalendarTray?.hideAppWindowToTray) {
          await window.myCalendarTray.hideAppWindowToTray();
        }
      })();
    });

    Neutralino.events.on('ready', async () => {
      window.__MYCALENDAR_NEU_READY__ = true;
      window.dispatchEvent(new CustomEvent('mycalendar:nativeReady'));
      await window.myCalendarTray?.setupTray?.();
      if (Neutralino.window?.setTitle) {
        await Neutralino.window.setTitle('My Desktop Calendar v1.1.9');
      }
      if (Neutralino.app?.exitProcessOnClose !== undefined) {
        Neutralino.app.exitProcessOnClose = false;
      }

      if (window.__MYCALENDAR_WINDOW_FOCUSED__) {
        return;
      }

      try {
        const status = await getWidgetStatus().catch(() => null);
        if (status?.embedded) {
          return;
        }
        window.__MYCALENDAR_WINDOW_FOCUSED__ = true;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (Neutralino.window?.focus) {
          await Neutralino.window.focus();
        }
      } catch {
        /* ignore window focus errors */
      }
    });

    Neutralino.init();
  }

  if (window.Neutralino) {
    initNeutralinoDesktop();
  }
})();
