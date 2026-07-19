import { useCallback, useEffect, useState } from 'react';
import { APP_NAME, APP_VERSION } from '../../shared/constants.js';
import { cn } from '../lib/cn.js';
import { isNeutralinoDesktopShell } from '../lib/isNeutralinoDesktopShell.js';

const titleBarBtnClass =
  'inline-flex h-full w-11 shrink-0 items-center justify-center text-gcal-muted transition-colors hover:bg-gcal-surface-2 hover:text-gcal-heading disabled:pointer-events-none disabled:opacity-0';

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <rect x="1" y="5.5" width="10" height="1.2" fill="currentColor" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        d="M3.5 3.5h6v6h-6zM2 4.5V2h6.5v2"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path
        d="M2.2 2.2 9.8 9.8M9.8 2.2 2.2 9.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Custom title bar for always-borderless window + desktop modes (same chrome).
 * Control buttons keep their width when embedded (opacity 0) so layout width stays identical.
 */
export default function TitleBar() {
  const inShell = isNeutralinoDesktopShell();
  const [embedded, setEmbedded] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const controlsEnabled = inShell && !embedded;

  useEffect(() => {
    if (!inShell || !window.myCalendar?.getWidgetStatus) {
      setEmbedded(false);
      return undefined;
    }
    const sync = async () => {
      try {
        const status = await window.myCalendar.getWidgetStatus();
        // Disable window controls not just while DesktopHost is the visible surface, but
        // also while a temporary desktop-mode overlay (settings/quick-edit/auth/export) is
        // suspended — that state briefly reports embedded:false (Host is hidden underneath
        // AppWindow) even though desktop mode is still the preferred/active mode. Minimize
        // (no taskbar entry) or Close there would call the native window/minimize|close
        // route directly and hide AppWindow with nothing left visible on the desktop.
        const staysDesktop = Boolean(
          status?.embedded || status?.embedSuspended || status?.resumeDesktopPending,
        );
        setEmbedded(staysDesktop);
      } catch {
        setEmbedded(false);
      }
    };
    void sync();
    const onStatus = () => {
      void sync();
    };
    window.addEventListener('mycalendar:widgetStatusChanged', onStatus);
    const id = window.setInterval(() => {
      void sync();
    }, 1000);
    return () => {
      window.removeEventListener('mycalendar:widgetStatusChanged', onStatus);
      window.clearInterval(id);
    };
  }, [inShell]);

  const refreshMaximized = useCallback(async () => {
    if (!window.myCalendar?.isWindowMaximized) {
      setMaximized(false);
      return;
    }
    try {
      const value = await window.myCalendar.isWindowMaximized();
      setMaximized(Boolean(value));
    } catch {
      setMaximized(false);
    }
  }, []);

  useEffect(() => {
    if (!controlsEnabled) {
      setMaximized(false);
      return undefined;
    }
    void refreshMaximized();
    const onFocus = () => {
      void refreshMaximized();
    };
    window.addEventListener('focus', onFocus);
    const id = window.setInterval(() => {
      void refreshMaximized();
    }, 1500);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(id);
    };
  }, [controlsEnabled, refreshMaximized]);

  const handleDragMouseDown = (event) => {
    if (!inShell || embedded || event.button !== 0) {
      return;
    }
    if (event.target instanceof Element && event.target.closest('[data-titlebar-action]')) {
      return;
    }
    void window.myCalendar?.beginWindowDrag?.(event.screenX, event.screenY);
  };

  const handleDoubleClick = () => {
    if (!controlsEnabled) {
      return;
    }
    void (async () => {
      await window.myCalendar?.toggleWindowMaximize?.();
      await refreshMaximized();
    })();
  };

  return (
    <div
      data-shell-chrome="titlebar"
      className="relative z-20 flex h-9 shrink-0 select-none items-center border-b border-gcal-border bg-[#efefef] text-gcal-heading dark:bg-gcal-page"
      onMouseDown={handleDragMouseDown}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        handleDoubleClick();
      }}
      role="banner"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
        <img
          src="/icons/appIcon.png"
          alt=""
          className="h-4 w-4 shrink-0"
          draggable={false}
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
        <span className="truncate text-[13px] font-medium tracking-tight">
          {APP_NAME}
          <span className="ml-1.5 font-normal text-gcal-muted">v{APP_VERSION}</span>
        </span>
      </div>

      {inShell && (
        <div className="flex h-full w-[8.25rem] shrink-0 items-stretch" data-titlebar-action>
          <button
            type="button"
            className={titleBarBtnClass}
            aria-label="최소화"
            title="최소화"
            disabled={!controlsEnabled}
            tabIndex={controlsEnabled ? 0 : -1}
            onClick={() => void window.myCalendar?.minimizeWindow?.()}
          >
            <MinimizeIcon />
          </button>
          <button
            type="button"
            className={titleBarBtnClass}
            aria-label={maximized ? '이전 크기로' : '최대화'}
            title={maximized ? '이전 크기로' : '최대화'}
            disabled={!controlsEnabled}
            tabIndex={controlsEnabled ? 0 : -1}
            onClick={() => {
              void (async () => {
                await window.myCalendar?.toggleWindowMaximize?.();
                await refreshMaximized();
              })();
            }}
          >
            {maximized ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
          <button
            type="button"
            className={cn(
              titleBarBtnClass,
              controlsEnabled && 'hover:bg-[#e81123] hover:text-white',
            )}
            aria-label="닫기"
            title="닫기"
            disabled={!controlsEnabled}
            tabIndex={controlsEnabled ? 0 : -1}
            onClick={() => void window.myCalendar?.closeWindow?.()}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}
