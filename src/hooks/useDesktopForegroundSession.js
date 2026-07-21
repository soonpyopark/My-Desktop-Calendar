import { useEffect, useRef } from 'react';
import { isNativeHost } from '../lib/nativeHost.js';
import { isDesktopSurfaceHost } from '../lib/isNeutralinoDesktopShell.js';

/** Idle with no in-app activity before returning under other apps. */
const FOREGROUND_IDLE_MS = 10_000;

/**
 * Desktop (locked) mode raise session:
 * - Any double-click in the app → bring above other windows
 * - While pointer is down (click/drag) or overlays are open → stay raised
 * - After {@link FOREGROUND_IDLE_MS} with no activity → always-on-bottom
 * - Mouse down / focus outside the app HWND → always-on-bottom (native)
 *
 * @param {{ keepRaised?: boolean }} options
 *   keepRaised — overlays pause idle timeout (outside click still sinks natively)
 */
export function useDesktopForegroundSession({ keepRaised = false } = {}) {
  const keepRaisedRef = useRef(keepRaised);
  keepRaisedRef.current = keepRaised;

  const raisedRef = useRef(false);
  const pointersDownRef = useRef(0);
  const idleTimerRef = useRef(null);
  const scheduleIdleRef = useRef(() => {});
  const raiseRef = useRef(() => {});

  useEffect(() => {
    if (!isNativeHost() || !window.myCalendar) {
      return undefined;
    }

    const clearIdle = () => {
      if (idleTimerRef.current != null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };

    const markLowered = () => {
      raisedRef.current = false;
      pointersDownRef.current = 0;
      clearIdle();
    };

    const scheduleIdle = () => {
      clearIdle();
      if (!raisedRef.current) return;
      if (pointersDownRef.current > 0) return;
      if (keepRaisedRef.current) return;
      if (!isDesktopSurfaceHost()) return;

      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        if (keepRaisedRef.current || pointersDownRef.current > 0) return;
        raisedRef.current = false;
        void window.myCalendar.releaseWindowForeground?.();
      }, FOREGROUND_IDLE_MS);
    };
    scheduleIdleRef.current = scheduleIdle;

    const raise = () => {
      if (!isDesktopSurfaceHost()) return;
      raisedRef.current = true;
      void window.myCalendar.bringWindowToFront?.();
      scheduleIdle();
    };
    raiseRef.current = raise;

    const noteActivity = () => {
      if (!raisedRef.current || !isDesktopSurfaceHost()) return;
      scheduleIdle();
    };

    const onDblClick = () => {
      if (!isDesktopSurfaceHost()) return;
      raise();
    };

    const onPointerDown = () => {
      if (!isDesktopSurfaceHost()) return;
      pointersDownRef.current += 1;
      clearIdle();
      noteActivity();
    };

    const onPointerUpOrCancel = () => {
      pointersDownRef.current = Math.max(0, pointersDownRef.current - 1);
      if (raisedRef.current) {
        scheduleIdle();
      }
    };

    const onKeyOrWheel = () => {
      noteActivity();
    };

    const onWidgetStatus = (event) => {
      const embedded = event?.detail?.embedded;
      if (embedded === false) {
        markLowered();
      }
    };

    const onForegroundSessionEnded = () => {
      markLowered();
    };

    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUpOrCancel, true);
    document.addEventListener('pointercancel', onPointerUpOrCancel, true);
    document.addEventListener('keydown', onKeyOrWheel, true);
    document.addEventListener('wheel', onKeyOrWheel, { capture: true, passive: true });
    window.addEventListener('mycalendar:widgetStatusChanged', onWidgetStatus);
    window.addEventListener('mycalendar:foregroundSessionEnded', onForegroundSessionEnded);

    return () => {
      clearIdle();
      document.removeEventListener('dblclick', onDblClick, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUpOrCancel, true);
      document.removeEventListener('pointercancel', onPointerUpOrCancel, true);
      document.removeEventListener('keydown', onKeyOrWheel, true);
      document.removeEventListener('wheel', onKeyOrWheel, true);
      window.removeEventListener('mycalendar:widgetStatusChanged', onWidgetStatus);
      window.removeEventListener('mycalendar:foregroundSessionEnded', onForegroundSessionEnded);
    };
  }, []);

  // Overlays: force raise and hold idle; when they close, start the idle countdown.
  useEffect(() => {
    if (!isNativeHost() || !window.myCalendar) {
      return undefined;
    }
    if (!isDesktopSurfaceHost()) {
      return undefined;
    }

    if (keepRaised) {
      raiseRef.current();
      if (idleTimerRef.current != null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      return undefined;
    }

    scheduleIdleRef.current();
    return undefined;
  }, [keepRaised]);
}
