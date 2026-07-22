import { useCallback, useEffect, useRef, useState } from 'react';
import Header from './components/Header.jsx';
import TitleBar from './components/TitleBar.jsx';
import MonthView from './components/MonthView.jsx';
import YearView from './components/YearView.jsx';
import EventPopover from './components/EventPopover.jsx';
import EventEditor from './components/EventEditor.jsx';
import DayQuickEditPopover from './components/DayQuickEditPopover.jsx';
import RecurrenceScopeDialog from './components/RecurrenceScopeDialog.jsx';
import LoginDialog from './components/LoginDialog.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import SearchPanel from './components/SearchPanel.jsx';
import SiteLink from './components/SiteLink.jsx';
import AppIcon from './components/AppIcon.jsx';
import { useAppDialog } from './components/AppDialogProvider.jsx';
import { useAuth } from './hooks/useAuth.js';
import { useCalendarData } from './hooks/useCalendarData.js';
import { useUndoRedoShortcuts } from './hooks/useUndoRedoShortcuts.js';
import { useDesktopForegroundSession } from './hooks/useDesktopForegroundSession.js';
import { downloadExportResponse } from './lib/downloadExport.js';
import { addEventAttachments, fetchExport } from './lib/api.js';
import { openExternalUrl } from './lib/openExternal.js';
import { getExportFileBaseName } from './lib/exportEvents.js';
import { eventToMutationPayload } from './lib/eventHistory.js';
import {
  getPrimaryEventLinkUrl,
  normalizeEventLinksArray,
} from '../shared/eventLinks.js';
import { filterCalendarsForViewer, filterEventsForViewer, isEventVisibleToViewer } from './lib/calendarVisibility.js';
import {
  addExdate,
  buildFollowingSeriesEvent,
  buildSingleExceptionEvent,
  getOccurrenceDate,
  getSeriesId,
  isRecurringEvent,
  truncateSeriesBefore,
} from '../shared/eventOccurrences.js';
import {
  getEventSortOrderForDay,
  mergeSortOrderByDay,
} from '../shared/eventBarFormat.js';
import { addDays, toDateKey } from './lib/calendarUtils.js';
import { getWeekStartsOn } from './lib/viewOptions.js';
import {
  applyColorScheme,
  getColorScheme,
  readStoredColorScheme,
  readStoredEffectiveColorScheme,
  resolveEffectiveColorScheme,
} from './lib/colorScheme.js';
import { applyAccentColor, getAccentColor, readStoredAccentColor } from './lib/accentColor.js';
import { notifyShellReady } from './lib/notifyShellReady.js';
import { isNativeHost } from './lib/nativeHost.js';
import { isDesktopSurfaceHost, isNeutralinoDesktopShell } from './lib/isNeutralinoDesktopShell.js';
import { DEFAULT_SETTINGS, DEFAULT_VIEW_OPTIONS, HOLIDAYS_KR_CALENDAR_ID } from '../shared/constants.js';

function parseLocalDateKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const date = new Date(`${key}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export default function App() {
  const [viewDate, setViewDate] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [activeEvent, setActiveEvent] = useState(null);
  const [activeEventDay, setActiveEventDay] = useState(null);
  const [popoverAnchor, setPopoverAnchor] = useState(null);
  /** Search-opened detail may stay up even while grid hide toggles are on. */
  const detailFromSearchRef = useRef(false);

  const clearEventDetail = useCallback(() => {
    detailFromSearchRef.current = false;
    setActiveEvent(null);
    setActiveEventDay(null);
    setPopoverAnchor(null);
  }, []);

  const openEventDetail = useCallback((event, dayKey, anchorRect = null, { fromSearch = false } = {}) => {
    detailFromSearchRef.current = Boolean(fromSearch);
    setActiveEvent(event);
    setActiveEventDay(dayKey);
    setPopoverAnchor(anchorRect);
  }, []);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorEvent, setEditorEvent] = useState(null);
  const [quickEdit, setQuickEdit] = useState(null);
  const [pendingEdit, setPendingEdit] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingComplete, setPendingComplete] = useState(null);
  const [scopeDialog, setScopeDialog] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewMode, setViewMode] = useState('month');
  const [loginOpen, setLoginOpen] = useState(false);
  const loginOpenRef = useRef(false);
  loginOpenRef.current = loginOpen;
  const [loginError, setLoginError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [monthAlign, setMonthAlign] = useState({ token: 0, target: 'month' });
  // Always-fresh viewMode for scroll-settle callbacks below — reportVisibleMonth can fire
  // from a late/trailing native scroll event on the *previous* mode's scroll container
  // right as the user switches view modes. Reading a useCallback closure's captured
  // `viewMode` there can still see the pre-switch mode for one event (the memoized
  // callback identity update lags one tick behind the state), which let a stray
  // handleVisibleWeekChange overwrite the just-set month/year viewDate with a scroll
  // position from the old week view (e.g. 월→주→월 or a straddling week's 월 click
  // silently jumping to the wrong month). Assigning this every render (not in an effect)
  // keeps it correct even for callbacks invoked mid-render-cycle.
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  const { user, isLoggedIn, isSuperAdmin, loggingIn, login, logout } = useAuth();

  const requestMonthAlign = useCallback((target = 'month') => {
    setMonthAlign((prev) => ({ token: prev.token + 1, target }));
  }, []);

  const resumeDesktopEmbedIfNeeded = useCallback(async () => {
    if (!isNeutralinoDesktopShell() || !window.myCalendar?.resumeDesktopEmbed) {
      return;
    }
    try {
      const status = await window.myCalendar.getWidgetStatus?.();
      // Resume only after a temporary overlay — never force desktop from intentional window mode.
      if (!status?.resumeDesktopPending && !status?.embedSuspended) {
        return;
      }
      await window.myCalendar.resumeDesktopEmbed();
    } catch {
      /* ignore */
    }
  }, []);

  /** Re-embed after overlay close (legacy name kept for call sites). */
  const resumeDesktopEmbedUnderCover = useCallback(async () => {
    if (!isNeutralinoDesktopShell() || !window.myCalendar?.getWidgetStatus) {
      return false;
    }
    try {
      const status = await window.myCalendar.getWidgetStatus();
      if (!status?.resumeDesktopPending && !status?.embedSuspended) {
        return false;
      }
    } catch {
      return false;
    }
    await resumeDesktopEmbedIfNeeded();
    return true;
  }, [resumeDesktopEmbedIfNeeded]);

  /** Unmount overlays first, then re-enter wallpaper embed if pending. */
  const resumeDesktopEmbedAfterPaint = useCallback(async () => {
    if (!isNeutralinoDesktopShell() || !window.myCalendar?.getWidgetStatus) {
      return;
    }
    try {
      const status = await window.myCalendar.getWidgetStatus();
      if (!status?.resumeDesktopPending && !status?.embedSuspended) {
        return;
      }
    } catch {
      return;
    }
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    await resumeDesktopEmbedIfNeeded();
    window.dispatchEvent(new CustomEvent('mycalendar:widgetStatusChanged'));
  }, [resumeDesktopEmbedIfNeeded]);

  /** Late-bound handler for embedded header button clicks (native pendingUiAction). */
  const runUiActionRef = useRef((_action) => {});
  /** Full EventEditor opened via day quick-edit "더보기". */
  const editorOpenedFromQuickEditRef = useRef(false);
  /** Snapshot of the quick-edit session to restore after the full editor closes. */
  const quickEditReturnRef = useRef(null);
  const quickEditRef = useRef(null);
  const quickEditClosingRef = useRef(false);
  quickEditRef.current = quickEdit;

  const {
    store,
    loading,
    online,
    syncInfo,
    addEvent,
    editEvent,
    removeEvent,
    toggleCalendar,
    addCalendar,
    editCalendar,
    removeCalendar,
    clearCalendarEvents,
    addTag,
    editTag,
    removeTag,
    replaceStore,
    importEventsIntoCalendar,
    updateSettings,
    syncHolidays,
    refresh,
    undo,
    redo,
    canUndo,
    canRedo,
    clearHistory,
  } = useCalendarData();
  const { alert, confirm } = useAppDialog();

  const storeThemeRef = useRef(store);
  storeThemeRef.current = store;
  /** Local UI override so the eye/checkbox flip on the first click (store PATCH can lag). */
  const eventsHiddenOverrideRef = useRef(null);
  const completedHiddenOverrideRef = useRef(null);
  const [eventsHiddenOverride, setEventsHiddenOverride] = useState(null);
  const [completedHiddenOverride, setCompletedHiddenOverride] = useState(null);
  const eventsHideToggleLockRef = useRef(0);
  const completedHideToggleLockRef = useRef(0);

  const applyEventsHidden = useCallback((hidden) => {
    if (!isLoggedIn) return;
    const next = Boolean(hidden);
    const shown = eventsHiddenOverrideRef.current
      ?? Boolean(storeThemeRef.current?.settings?.viewOptions?.eventsHidden);
    if (shown === next) {
      return;
    }
    eventsHiddenOverrideRef.current = next;
    setEventsHiddenOverride(next);
    const current = storeThemeRef.current;
    if (current?.settings) {
      storeThemeRef.current = {
        ...current,
        settings: {
          ...current.settings,
          viewOptions: {
            ...current.settings.viewOptions,
            eventsHidden: next,
          },
        },
      };
    }
    void updateSettings({ viewOptions: { eventsHidden: next } });
  }, [isLoggedIn, updateSettings]);

  const handleToggleEventsHidden = useCallback(() => {
    if (!isLoggedIn) return;
    // Duplicate pointer/click (or zone+DOM) within one gesture must not invert twice.
    const now = Date.now();
    if (now - eventsHideToggleLockRef.current < 350) return;
    eventsHideToggleLockRef.current = now;
    const current = eventsHiddenOverrideRef.current
      ?? Boolean(storeThemeRef.current?.settings?.viewOptions?.eventsHidden);
    applyEventsHidden(!current);
  }, [applyEventsHidden, isLoggedIn]);

  const applyCompletedHidden = useCallback((hidden) => {
    if (!isLoggedIn) return;
    const next = Boolean(hidden);
    const shown = completedHiddenOverrideRef.current
      ?? Boolean(storeThemeRef.current?.settings?.viewOptions?.completedHidden);
    if (shown === next) {
      return;
    }
    completedHiddenOverrideRef.current = next;
    setCompletedHiddenOverride(next);
    const current = storeThemeRef.current;
    if (current?.settings) {
      storeThemeRef.current = {
        ...current,
        settings: {
          ...current.settings,
          viewOptions: {
            ...current.settings.viewOptions,
            completedHidden: next,
          },
        },
      };
    }
    void updateSettings({ viewOptions: { completedHidden: next } });
  }, [isLoggedIn, updateSettings]);

  const handleToggleCompletedHidden = useCallback(() => {
    if (!isLoggedIn) return;
    const now = Date.now();
    if (now - completedHideToggleLockRef.current < 350) return;
    completedHideToggleLockRef.current = now;
    const current = completedHiddenOverrideRef.current
      ?? Boolean(storeThemeRef.current?.settings?.viewOptions?.completedHidden);
    applyCompletedHidden(!current);
  }, [applyCompletedHidden, isLoggedIn]);

  const assertCurrentColorScheme = useCallback(() => {
    const viewOptions = storeThemeRef.current?.settings?.viewOptions;
    const scheme = viewOptions
      ? getColorScheme(viewOptions)
      : (readStoredColorScheme() ?? 'system');
    const effective = resolveEffectiveColorScheme(scheme);
    const prevEffective = readStoredEffectiveColorScheme();
    applyColorScheme(scheme);
    // Only nudge native frame when the effective theme actually changed.
    // Re-applying the same frame on every Settings open flashed window mode.
    if (prevEffective !== effective) {
      void window.myCalendar?.setWindowFrameTheme?.(effective === 'dark');
    }
    return scheme;
  }, []);

  const openSearch = useCallback(() => {
    if (settingsOpen) {
      return;
    }
    // Opens in place on the single surface (desktop embed or window mode).
    assertCurrentColorScheme();
    setSearchOpen(true);
  }, [assertCurrentColorScheme, settingsOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    void (async () => {
      try {
        await window.myCalendar?.ackPendingUiAction?.();
      } catch {
        /* ignore */
      }
      // Same as closeSettings — a no-op unless a legacy/boot-flow path (not this
      // surface's own in-place open) actually suspended for it.
      void resumeDesktopEmbedAfterPaint();
    })();
  }, [resumeDesktopEmbedAfterPaint]);

  const openSettings = useCallback(() => {
    if (!isLoggedIn || searchOpen) {
      return;
    }
    // Reachable on the DesktopHost surface too — Header's own onClick calls this
    // directly (no native unlock) under SysListView32/WS_POPUP embed, opening the
    // panel in place exactly like the quick-edit popover. The old permanent
    // isDesktopSurfaceHost() guard here only made sense back when Settings always
    // had to unlock/undock to the App window first.
    assertCurrentColorScheme();
    setSettingsOpen(true);
  }, [assertCurrentColorScheme, isLoggedIn, searchOpen]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    void (async () => {
      try {
        await window.myCalendar?.ackPendingUiAction?.();
      } catch {
        /* ignore */
      }
      // Settings uses a temporary unlock (like quick-edit/export) — resume desktop
      // embed automatically once the panel has unmounted.
      void resumeDesktopEmbedAfterPaint();
    })();
  }, [resumeDesktopEmbedAfterPaint]);

  const handleUndo = useCallback(async () => {
    if (!isLoggedIn || !canUndo) return;
    try {
      await undo();
      setActiveEvent(null);
      setActiveEventDay(null);
      setPopoverAnchor(null);
    } catch (err) {
      await alert(err instanceof Error ? err.message : '실행 취소에 실패했습니다.');
    }
  }, [alert, canUndo, isLoggedIn, undo]);

  const handleRedo = useCallback(async () => {
    if (!isLoggedIn || !canRedo) return;
    try {
      await redo();
      setActiveEvent(null);
      setActiveEventDay(null);
      setPopoverAnchor(null);
    } catch (err) {
      await alert(err instanceof Error ? err.message : '다시 실행에 실패했습니다.');
    }
  }, [alert, canRedo, isLoggedIn, redo]);

  useUndoRedoShortcuts({
    canUndo: isLoggedIn && canUndo,
    canRedo: isLoggedIn && canRedo,
    onUndo: handleUndo,
    onRedo: handleRedo,
    enabled: isLoggedIn,
  });

  const goToday = useCallback(() => {
    const now = new Date();
    setSelectedDate(now);
    if (viewMode === 'week') {
      setViewDate(now);
      requestMonthAlign('today');
      return;
    }
    setViewDate(new Date(now.getFullYear(), now.getMonth(), 1));
    requestMonthAlign('today');
  }, [requestMonthAlign, viewMode]);

  const shiftMonth = useCallback((delta) => {
    setViewDate((prev) => {
      const next = new Date(prev.getFullYear(), prev.getMonth() + delta, 1);
      // Keep selection in the navigated month so scroll-align / reportVisibleMonth
      // cannot yank the header back to a stale selectedDate in another period.
      setSelectedDate((sel) => {
        const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        const day = Math.min(sel.getDate(), lastDay);
        return new Date(next.getFullYear(), next.getMonth(), day);
      });
      return next;
    });
    requestMonthAlign('month');
  }, [requestMonthAlign]);

  const shiftWeek = useCallback((delta) => {
    setSelectedDate((prev) => {
      const next = addDays(prev, delta * 7);
      setViewDate(next);
      return next;
    });
    requestMonthAlign('month');
  }, [requestMonthAlign]);

  const shiftYear = useCallback((delta) => {
    setViewDate((prev) => {
      const next = new Date(prev.getFullYear() + delta, prev.getMonth(), 1);
      setSelectedDate((sel) => {
        const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        const day = Math.min(sel.getDate(), lastDay);
        return new Date(next.getFullYear(), next.getMonth(), day);
      });
      return next;
    });
    requestMonthAlign('month');
  }, [requestMonthAlign]);

  const handleViewModeChange = useCallback((mode) => {
    setViewMode(mode);
    if (mode === 'year' || mode === 'month') {
      setViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth(), 1));
      requestMonthAlign('month');
      return;
    }
    if (mode === 'week') {
      // Month → week: open today's week. Align target must be 'today' — 'month'
      // scrolls to day-1 of displayMonth and overrides the today anchor.
      const today = new Date();
      const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      setViewDate(anchor);
      setSelectedDate(anchor);
      requestMonthAlign('today');
    }
  }, [requestMonthAlign]);

  const openMonthView = useCallback((date) => {
    setViewDate(new Date(date.getFullYear(), date.getMonth(), 1));
    setSelectedDate(date);
    setViewMode('month');
    requestMonthAlign('month');
  }, [requestMonthAlign]);

  const handleVisibleMonthChange = useCallback((year, month) => {
    // Read the ref, not the closed-over `viewMode` — see viewModeRef comment above.
    if (viewModeRef.current === 'week') return;
    setViewDate((prev) => {
      if (prev.getFullYear() === year && prev.getMonth() === month - 1) return prev;
      return new Date(year, month - 1, 1);
    });
  }, []);

  const handleVisibleWeekChange = useCallback((weekStart) => {
    // Read the ref, not the closed-over `viewMode` — see viewModeRef comment above.
    if (viewModeRef.current !== 'week') return;
    setSelectedDate((prev) => (
      prev && prev.getFullYear() === weekStart.getFullYear()
        && prev.getMonth() === weekStart.getMonth()
        && prev.getDate() === weekStart.getDate()
        ? prev
        : weekStart
    ));
    setViewDate((prev) => (
      prev.getFullYear() === weekStart.getFullYear()
        && prev.getMonth() === weekStart.getMonth()
        && prev.getDate() === weekStart.getDate()
        ? prev
        : weekStart
    ));
  }, []);

  const snapshotAnchorRect = useCallback((rect) => {
    if (!rect) return null;
    const width = Number(rect.width) || 0;
    const height = Number(rect.height) || 0;
    if (!(width > 0 && height > 0)) return null;
    return {
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width,
      height,
      x: rect.x ?? rect.left,
      y: rect.y ?? rect.top,
    };
  }, []);

  const resolveDayQuickEditRect = useCallback((date) => {
    const dayKey = toDateKey(date);
    const el = document.querySelector(`.day-cell[data-date-key="${dayKey}"]`);
    if (el) {
      const rect = snapshotAnchorRect(el.getBoundingClientRect());
      if (rect) return rect;
    }
    const width = 300;
    const height = viewMode === 'month' ? 388 : 292;
    const left = Math.max(8, (window.innerWidth - width) / 2);
    const top = Math.max(8, (window.innerHeight - height) / 2);
    return {
      x: left,
      y: top,
      top,
      left,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }, [snapshotAnchorRect, viewMode]);

  /** Day-cell / 더보기 → quick-edit (bar double-click uses openEditEvent instead). */
  const openDayQuickEdit = useCallback((date, anchorRect, { focusEvent = null } = {}) => {
    if (!isLoggedIn) return;
    // Desktop locked sits under other apps — raise while the overlay is open.
    if (isNativeHost()) {
      void window.myCalendar?.bringWindowToFront?.();
    }
    setSelectedDate(date);
    clearEventDetail();
    setEditorOpen(false);
    setEditorEvent(null);
    setQuickEdit({
      date,
      dayKey: toDateKey(date),
      // Snapshot — live DOMRect can go stale before the popover measures layout.
      anchorRect: snapshotAnchorRect(anchorRect) ?? resolveDayQuickEditRect(date),
      focusEvent,
    });
  }, [clearEventDetail, isLoggedIn, resolveDayQuickEditRect, snapshotAnchorRect]);

  const stashQuickEditReturn = useCallback((fallbackDate, focusEvent = null) => {
    const current = quickEditRef.current;
    if (current) {
      quickEditReturnRef.current = {
        date: current.date,
        dayKey: current.dayKey,
        anchorRect: current.anchorRect,
        focusEvent: focusEvent ?? current.focusEvent ?? null,
      };
      return;
    }
    const date = fallbackDate || new Date();
    quickEditReturnRef.current = {
      date,
      dayKey: toDateKey(date),
      anchorRect: resolveDayQuickEditRect(date),
      focusEvent: focusEvent || null,
    };
  }, [resolveDayQuickEditRect]);

  const restoreQuickEditFromReturn = useCallback(() => {
    const restore = quickEditReturnRef.current;
    quickEditReturnRef.current = null;
    if (!restore) {
      void resumeDesktopEmbedIfNeeded();
      return;
    }
    // Stay temporarily unlocked — reopen the small editor without re-embedding.
    queueMicrotask(() => {
      openDayQuickEdit(restore.date, restore.anchorRect, { focusEvent: restore.focusEvent });
    });
  }, [openDayQuickEdit, resumeDesktopEmbedIfNeeded]);

  const openCreateEvent = useCallback((date, { fromQuickEdit = false } = {}) => {
    setSelectedDate(date);
    if (fromQuickEdit) {
      stashQuickEditReturn(date, null);
    }
    setQuickEdit(null);
    editorOpenedFromQuickEditRef.current = Boolean(fromQuickEdit);
    if (!isLoggedIn) {
      editorOpenedFromQuickEditRef.current = false;
      if (fromQuickEdit) {
        restoreQuickEditFromReturn();
      } else {
        void resumeDesktopEmbedIfNeeded();
      }
      return;
    }
    setEditorEvent(null);
    setPendingEdit(null);
    setEditorOpen(true);
    setActiveEvent(null);
  }, [isLoggedIn, restoreQuickEditFromReturn, resumeDesktopEmbedIfNeeded, stashQuickEditReturn]);

  /** Open quick edit for any date (month cell if visible, otherwise centered fallback). */
  const openDayQuickEditForDate = useCallback((date, { alignMonth = false } = {}) => {
    if (!isLoggedIn) return;
    // Week view must stay on week — never hop to month when opening the small editor.
    if (viewMode === 'week') {
      setSelectedDate(date);
      setViewDate(date);
    } else if (alignMonth || viewMode === 'year') {
      openMonthView(date);
    } else {
      setSelectedDate(date);
    }

    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        openDayQuickEdit(date, resolveDayQuickEditRect(date));
      }, (alignMonth || viewMode === 'year') && viewMode !== 'week' ? 80 : 0);
    });
  }, [isLoggedIn, openDayQuickEdit, openMonthView, resolveDayQuickEditRect, viewMode]);

  const closeDayQuickEdit = useCallback(() => {
    if (quickEditClosingRef.current) return;
    quickEditReturnRef.current = null;
    quickEditClosingRef.current = true;
    // 1) Remove the small editor (calendar stays visible; no opaque JS veil).
    // 2) Let that paint land, then resume — native freezes the current screen
    //    pixels as a TOPMOST cover while SetParent runs underneath.
    setQuickEdit(null);
    void (async () => {
      try {
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        await resumeDesktopEmbedUnderCover();
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      } finally {
        quickEditClosingRef.current = false;
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('mycalendar:widgetStatusChanged'));
        }, 100);
      }
    })();
  }, [resumeDesktopEmbedUnderCover]);

  const handleSearchSelect = useCallback(({ event, date, dayKey }) => {
    setSearchOpen(false);
    void resumeDesktopEmbedIfNeeded();
    openMonthView(date);
    // Keep detail even when "숨기기" toggles would otherwise dismiss it.
    openEventDetail(event, dayKey, null, { fromSearch: true });
  }, [openEventDetail, openMonthView, resumeDesktopEmbedIfNeeded]);

  const closeEditor = useCallback(() => {
    const fromQuickEdit = editorOpenedFromQuickEditRef.current;
    editorOpenedFromQuickEditRef.current = false;
    setEditorOpen(false);
    setEditorEvent(null);
    setPendingEdit(null);
    setScopeDialog((prev) => (prev?.mode === 'edit' ? null : prev));

    // Quick-edit → 더보기 → X/취소: restore the small editor (stay unlocked).
    if (fromQuickEdit) {
      restoreQuickEditFromReturn();
      return;
    }

    void resumeDesktopEmbedAfterPaint();
  }, [restoreQuickEditFromReturn, resumeDesktopEmbedAfterPaint]);

  /** Save finished the edit flow — close detail editor and do not reopen quick-edit. */
  const dismissEditorAfterSave = useCallback(() => {
    editorOpenedFromQuickEditRef.current = false;
    quickEditReturnRef.current = null;
    setEditorOpen(false);
    setEditorEvent(null);
    setPendingEdit(null);
    setScopeDialog((prev) => (prev?.mode === 'edit' ? null : prev));
    void resumeDesktopEmbedAfterPaint();
  }, [resumeDesktopEmbedAfterPaint]);

  const findMasterEvent = useCallback((eventOrId) => {
    const seriesId = typeof eventOrId === 'string' ? eventOrId : getSeriesId(eventOrId);
    return (store?.events ?? []).find((item) => item.id === seriesId) ?? null;
  }, [store?.events]);

  const handleReorderEvents = useCallback(async (ordered, dayKey) => {
    if (!isLoggedIn) {
      await alert('관리자 로그인 후 일정 순서를 변경할 수 있습니다.');
      return;
    }
    if (!dayKey) {
      await alert('일정 순서를 저장하지 못했습니다.');
      return;
    }
    try {
      for (const { event, sortOrder } of ordered ?? []) {
        const master = findMasterEvent(event);
        if (!master || master.calendarId === HOLIDAYS_KR_CALENDAR_ID) continue;
        if (getEventSortOrderForDay(master, dayKey) === sortOrder) continue;
        await editEvent(master.id, {
          sortOrderByDay: mergeSortOrderByDay(master, dayKey, sortOrder),
        });
      }
    } catch (err) {
      await alert(err instanceof Error ? err.message : '일정 순서를 저장하지 못했습니다.');
    }
  }, [alert, editEvent, findMasterEvent, isLoggedIn]);

  const openEditEvent = useCallback((event, dayKey, { fromQuickEdit = false } = {}) => {
    const abortToDesktopOrQuickEdit = () => {
      if (fromQuickEdit) {
        restoreQuickEditFromReturn();
      } else {
        void resumeDesktopEmbedIfNeeded();
      }
    };

    if (fromQuickEdit) {
      stashQuickEditReturn(
        dayKey ? new Date(`${dayKey}T00:00:00`) : null,
        event,
      );
    }

    if (!isLoggedIn) {
      abortToDesktopOrQuickEdit();
      return;
    }
    if (event?.calendarId === HOLIDAYS_KR_CALENDAR_ID) {
      abortToDesktopOrQuickEdit();
      return;
    }
    const allCalendars = store?.calendars ?? [];
    if (!isEventVisibleToViewer(event, allCalendars, isLoggedIn)) {
      abortToDesktopOrQuickEdit();
      return;
    }
    const master = findMasterEvent(event);
    if (!master) {
      abortToDesktopOrQuickEdit();
      return;
    }
    const occurrenceDate = getOccurrenceDate(event, dayKey);
    setSelectedDate(new Date(`${occurrenceDate}T00:00:00`));
    setPendingEdit({
      master,
      occurrenceDate,
      needsScope: isRecurringEvent(master),
      payload: null,
    });
    setEditorEvent({
      ...master,
      startDate: event.startDate ?? master.startDate,
      endDate: event.endDate ?? master.endDate,
      startTime: event.startTime ?? master.startTime,
      endTime: event.endTime ?? master.endTime,
      allDay: event.allDay ?? master.allDay,
    });
    editorOpenedFromQuickEditRef.current = Boolean(fromQuickEdit);
    setQuickEdit(null);
    setEditorOpen(true);
    clearEventDetail();
  }, [
    clearEventDetail,
    findMasterEvent,
    isLoggedIn,
    restoreQuickEditFromReturn,
    resumeDesktopEmbedIfNeeded,
    stashQuickEditReturn,
    store?.calendars,
  ]);

  const openDayQuickEditForEvent = useCallback((event, dayKey) => {
    if (!isLoggedIn) return;
    if (!isEventVisibleToViewer(event, store?.calendars ?? [], isLoggedIn)) return;
    const key = dayKey || event?.startDate || toDateKey(new Date());
    const date = new Date(`${key}T00:00:00`);
    openDayQuickEdit(date, resolveDayQuickEditRect(date), { focusEvent: event });
  }, [isLoggedIn, openDayQuickEdit, resolveDayQuickEditRect, store?.calendars]);

  // Desktop overlays: settings/search/auth/export may arrive as pendingUiAction from native.
  // Create/edit pending is resume-reopen only — day/bar clicks open QE/editor directly in React.
  useEffect(() => {
    if (!isNeutralinoDesktopShell()) {
      return undefined;
    }

    let cancelled = false;
    let lastCreateToken = 0;
    let lastEditToken = 0;
    let lastUiToken = 0;

    const openFromPendingCreate = async (dateKey, token) => {
      if (!isLoggedIn) {
        void resumeDesktopEmbedIfNeeded();
        return;
      }
      if (!dateKey || !token || token === lastCreateToken) {
        return;
      }
      lastCreateToken = token;
      try {
        await window.myCalendar?.ackPendingCreate?.();
      } catch {
        /* ignore */
      }
      const parts = String(dateKey).split('-').map(Number);
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
        void resumeDesktopEmbedIfNeeded();
        return;
      }
      const [year, month, day] = parts;
      openDayQuickEditForDate(new Date(year, month - 1, day), { alignMonth: true });
    };

    const openFromPendingEdit = async (pending, token) => {
      if (!isLoggedIn) {
        void resumeDesktopEmbedIfNeeded();
        return;
      }
      const eventId = pending?.eventId;
      const dayKey = pending?.dayKey;
      if (!eventId || !dayKey || !token || token === lastEditToken) {
        return;
      }
      lastEditToken = token;
      try {
        await window.myCalendar?.ackPendingCreate?.();
      } catch {
        /* ignore */
      }
      const events = store?.events ?? [];
      const event =
        events.find((item) => item.id === eventId)
        ?? events.find((item) => getSeriesId(item) === eventId)
        ?? null;
      if (!event) {
        void resumeDesktopEmbedIfNeeded();
        return;
      }
      // Resume-reopen after overlay: bar edit → full EventEditor.
      openEditEvent(event, dayKey, { fromQuickEdit: false });
    };

    const openFromPendingUi = async (action, token) => {
      if (!action || !token || token === lastUiToken) {
        return;
      }
      lastUiToken = token;
      // Open overlay first so it paints under the native transition cover.
      // Ack after — awaiting native first delayed Settings past the cover drop.
      runUiActionRef.current?.(action);
      try {
        await window.myCalendar?.ackPendingUiAction?.();
      } catch {
        /* ignore */
      }
    };

    const onPendingCreate = (event) => {
      const dateKey = event?.detail?.dateKey;
      const token = Number(event?.detail?.suspendToken) || 0;
      void openFromPendingCreate(dateKey, token);
    };

    const onPendingEdit = (event) => {
      const token = Number(event?.detail?.suspendToken) || 0;
      void openFromPendingEdit(event?.detail?.pendingEditEvent, token);
    };

    const onPendingUiAction = (event) => {
      const action = event?.detail?.action;
      const token = Number(event?.detail?.suspendToken) || 0;
      void openFromPendingUi(action, token);
    };

    window.addEventListener('mycalendar:pendingCreate', onPendingCreate);
    window.addEventListener('mycalendar:pendingEdit', onPendingEdit);
    window.addEventListener('mycalendar:pendingUiAction', onPendingUiAction);

    const pollId = window.setInterval(() => {
      if (cancelled) {
        return;
      }
      void (async () => {
        try {
          const status = await window.myCalendar?.getWidgetStatus?.();
          if (cancelled) return;
          if (status?.pendingUiAction) {
            await openFromPendingUi(status.pendingUiAction, Number(status.suspendToken) || 0);
            return;
          }
          if (editorOpen || quickEdit) {
            return;
          }
          if (status?.pendingEditEvent) {
            await openFromPendingEdit(status.pendingEditEvent, Number(status.suspendToken) || 0);
            return;
          }
          if (status?.pendingCreateDate) {
            await openFromPendingCreate(status.pendingCreateDate, Number(status.suspendToken) || 0);
          }
        } catch {
          /* ignore */
        }
      })();
    }, 300);

    return () => {
      cancelled = true;
      window.removeEventListener('mycalendar:pendingCreate', onPendingCreate);
      window.removeEventListener('mycalendar:pendingEdit', onPendingEdit);
      window.removeEventListener('mycalendar:pendingUiAction', onPendingUiAction);
      window.clearInterval(pollId);
    };
  }, [
    editorOpen,
    isLoggedIn,
    openDayQuickEditForDate,
    openEditEvent,
    quickEdit,
    resumeDesktopEmbedIfNeeded,
    store?.events,
  ]);

  const applyRecurringEdit = useCallback(async (master, payload, occurrenceDate, scope) => {
    if (scope === 'all') {
      const durationDays = Math.max(
        1,
        Math.round(
          (new Date(`${payload.endDate}T00:00:00`).getTime()
            - new Date(`${payload.startDate}T00:00:00`).getTime())
            / 86400000,
        ) + 1,
      );
      const keepSeriesStart = occurrenceDate !== master.startDate;
      const nextStart = keepSeriesStart ? master.startDate : payload.startDate;
      const seriesEnd = new Date(`${nextStart}T00:00:00`);
      seriesEnd.setDate(seriesEnd.getDate() + durationDays - 1);
      const seriesEndDate = [
        seriesEnd.getFullYear(),
        String(seriesEnd.getMonth() + 1).padStart(2, '0'),
        String(seriesEnd.getDate()).padStart(2, '0'),
      ].join('-');

      await editEvent(master.id, {
        ...payload,
        id: master.id,
        startDate: nextStart,
        endDate: seriesEndDate,
        exdates: Array.isArray(master.exdates) ? master.exdates : [],
      });
      return;
    }

    if (scope === 'single') {
      const exception = buildSingleExceptionEvent(master, payload, occurrenceDate);
      const withExdate = addExdate(master, occurrenceDate);
      await editEvent(master.id, {
        exdates: withExdate.exdates,
      });
      await addEvent(exception);
      return;
    }

    // following
    const truncated = truncateSeriesBefore(master, occurrenceDate);
    if ((truncated.repeat ?? 'none') === 'none') {
      await removeEvent(master.id);
    } else {
      await editEvent(master.id, {
        repeatUntil: truncated.repeatUntil,
        repeatCount: null,
        repeat: truncated.repeat,
      });
    }
    await addEvent(buildFollowingSeriesEvent(master, payload, occurrenceDate));
  }, [addEvent, editEvent, removeEvent]);

  const handleSave = useCallback(
    async (payload) => {
      if (!isLoggedIn) {
        await alert('관리자 로그인 후 일정을 수정할 수 있습니다.');
        return;
      }
      try {
        if (!payload.id) {
          // Close on save click — don't wait for the network round-trip, and don't
          // restore the quick-edit underneath (X/cancel still uses closeEditor).
          dismissEditorAfterSave();
          await addEvent(payload);
          return;
        }

        if (pendingEdit?.needsScope) {
          setPendingEdit((prev) => ({ ...prev, payload }));
          setScopeDialog({ mode: 'edit' });
          return;
        }

        dismissEditorAfterSave();
        await editEvent(payload.id, payload);
      } catch (err) {
        await alert(err instanceof Error ? err.message : '일정을 저장하지 못했습니다.');
      }
    },
    [addEvent, alert, dismissEditorAfterSave, editEvent, isLoggedIn, pendingEdit],
  );

  const handleDeleteRequest = useCallback(async (event, options = {}) => {
    if (!isLoggedIn) {
      await alert('관리자 로그인 후 일정을 삭제할 수 있습니다.');
      return;
    }
    if (event?.calendarId === HOLIDAYS_KR_CALENDAR_ID) {
      return;
    }

    const master = findMasterEvent(event);
    if (!master) {
      await alert('일정을 찾을 수 없습니다.');
      return;
    }

    if (!isRecurringEvent(master)) {
      await removeEvent(master.id);
      setActiveEvent(null);
      setActiveEventDay(null);
      setPopoverAnchor(null);
      if (options.fromEditor) {
        closeEditor();
      }
      return;
    }

    const occurrenceDate =
      options.occurrenceDate
      ?? pendingEdit?.occurrenceDate
      ?? getOccurrenceDate(event, activeEventDay);
    setPendingDelete({
      master,
      occurrenceDate,
    });
    setScopeDialog({ mode: 'delete' });
  }, [
    activeEventDay,
    alert,
    closeEditor,
    findMasterEvent,
    isLoggedIn,
    pendingEdit?.occurrenceDate,
    removeEvent,
  ]);

  const handleScopeSelect = useCallback(async (scope) => {
    const dialogMode = scopeDialog?.mode;
    setScopeDialog(null);

    try {
      if (dialogMode === 'edit' && pendingEdit?.payload && pendingEdit?.master) {
        const master = pendingEdit.master;
        const editPayload = pendingEdit.payload;
        const occurrenceDate = pendingEdit.occurrenceDate;
        dismissEditorAfterSave();
        await applyRecurringEdit(master, editPayload, occurrenceDate, scope);
        return;
      }

      if (dialogMode === 'complete' && pendingComplete?.master) {
        const { master, occurrenceDate, completed } = pendingComplete;
        const nextCompleted = Boolean(completed);
        const durationDays = Math.max(
          1,
          Math.round(
            (new Date(`${master.endDate || master.startDate}T00:00:00`).getTime()
              - new Date(`${master.startDate}T00:00:00`).getTime())
              / 86400000,
          ) + 1,
        );
        const occurrenceEndDate = toDateKey(addDays(new Date(`${occurrenceDate}T00:00:00`), durationDays - 1));
        const payload = {
          ...eventToMutationPayload(master),
          startDate: occurrenceDate,
          endDate: occurrenceEndDate,
          completed: nextCompleted,
        };
        await applyRecurringEdit(master, payload, occurrenceDate, scope);
        setPendingComplete(null);
        setActiveEvent((prev) => (prev ? { ...prev, completed: nextCompleted } : prev));
        return;
      }

      if (dialogMode === 'delete' && pendingDelete?.master) {
        const { master, occurrenceDate } = pendingDelete;
        if (scope === 'all') {
          await removeEvent(master.id);
        } else if (scope === 'single') {
          const withExdate = addExdate(master, occurrenceDate);
          await editEvent(master.id, { exdates: withExdate.exdates });
        } else {
          const truncated = truncateSeriesBefore(master, occurrenceDate);
          if ((truncated.repeat ?? 'none') === 'none') {
            await removeEvent(master.id);
          } else {
            await editEvent(master.id, {
              repeatUntil: truncated.repeatUntil,
              repeatCount: null,
            });
          }
        }
        setPendingDelete(null);
        setActiveEvent(null);
        setActiveEventDay(null);
        setPopoverAnchor(null);
        closeEditor();
      }
    } catch (err) {
      await alert(err instanceof Error ? err.message : '반복 일정 처리에 실패했습니다.');
    }
  }, [
    alert,
    applyRecurringEdit,
    closeEditor,
    dismissEditorAfterSave,
    editEvent,
    pendingComplete,
    pendingDelete,
    pendingEdit,
    removeEvent,
    scopeDialog,
  ]);

  const handleLogout = useCallback(() => {
    logout();
    clearHistory();
    setLoginError(null);
    setLoginOpen(false);
    setSettingsOpen(false);
    setEditorOpen(false);
    setEditorEvent(null);
    setPendingEdit(null);
    setPendingDelete(null);
    setPendingComplete(null);
    setScopeDialog(null);
    setActiveEvent(null);
    setActiveEventDay(null);
    setPopoverAnchor(null);
    void refresh();
  }, [clearHistory, logout, refresh]);

  const handleAuthToggle = useCallback(() => {
    // Reachable on the DesktopHost surface too — see openSearch/openSettings above for
    // why the old isDesktopSurfaceHost() guard here is gone.
    if (isLoggedIn) {
      handleLogout();
      return;
    }
    setLoginError(null);
    setLoginOpen(true);
  }, [handleLogout, isLoggedIn]);

  const handleLogin = useCallback(async (id, password, rememberMe = true) => {
    try {
      setLoginError(null);
      await login(id, password, rememberMe);
      setLoginOpen(false);
      await refresh();
      void resumeDesktopEmbedIfNeeded();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '로그인에 실패했습니다.');
    }
  }, [login, refresh, resumeDesktopEmbedIfNeeded]);

  const handleExport = useCallback(async (format) => {
    if (!isLoggedIn) {
      await alert('관리자 로그인이 필요합니다.');
      return;
    }

    const isExcel = format === 'excel';
    const formatLabel = isExcel ? 'Excel' : 'PDF';
    const exportYear = viewDate.getFullYear();
    const exportMonth = viewDate.getMonth() + 1;
    const ok = await confirm(
      `${exportYear}년 ${exportMonth}월 일정을 ${formatLabel} 파일로 저장하시겠습니까?`,
      {
        title: `${formatLabel} 내보내기`,
        confirmLabel: '저장',
        cancelLabel: '취소',
      },
    );
    if (!ok) {
      return;
    }

    setExporting(true);
    try {
      const params = new URLSearchParams({
        year: String(exportYear),
        month: String(exportMonth),
        scope: 'month',
        format,
      });

      const response = await fetchExport(params);
      const extension = isExcel ? 'xlsx' : 'pdf';
      const fallbackName = `${getExportFileBaseName({ viewDate })}.${extension}`;
      await downloadExportResponse(response, fallbackName, format);
      await alert(
        `${exportYear}년 ${exportMonth}월 일정을 ${formatLabel} 파일로 저장했습니다.`,
        { title: '내보내기 완료' },
      );
    } catch (err) {
      await alert(err instanceof Error ? err.message : '내보내기에 실패했습니다.');
    } finally {
      setExporting(false);
    }
  }, [alert, confirm, isLoggedIn, viewDate]);

  runUiActionRef.current = (action) => {
    const resumeSoon = () => {
      void resumeDesktopEmbedIfNeeded();
    };

    switch (action) {
      case 'search':
        if (settingsOpen) {
          resumeSoon();
          return;
        }
        assertCurrentColorScheme();
        setSearchOpen(true);
        return;
      case 'settings':
        if (!isLoggedIn || searchOpen) {
          resumeSoon();
          return;
        }
        assertCurrentColorScheme();
        setSettingsOpen(true);
        return;
      case 'auth':
        if (isLoggedIn) {
          handleLogout();
          resumeSoon();
          return;
        }
        setLoginError(null);
        setLoginOpen(true);
        return;
      case 'export-excel':
        void handleExport('excel').finally(resumeSoon);
        return;
      case 'export-pdf':
        void handleExport('pdf').finally(resumeSoon);
        return;
      case 'today':
        goToday();
        return;
      // hide/show-events and hide/show-completed used to have cases here too, mirrored
      // from Header's chrome-nav path — removed along with that mirror (see
      // hide/show-events|completed: apply via settings store broadcast only.
      case 'open-web': {
        const port = Number(syncInfo?.port) || 0;
        if ((syncInfo?.running ?? syncInfo?.serverRunning) && port > 0) {
          void openExternalUrl(`http://localhost:${port}/`);
        }
        return;
      }
      case 'prev':
        if (viewMode === 'year') shiftYear(-1);
        else if (viewMode === 'week') shiftWeek(-1);
        else shiftMonth(-1);
        return;
      case 'next':
        if (viewMode === 'year') shiftYear(1);
        else if (viewMode === 'week') shiftWeek(1);
        else shiftMonth(1);
        return;
      case 'prev-year':
        shiftYear(-1);
        return;
      case 'next-year':
        shiftYear(1);
        return;
      case 'view-month':
        handleViewModeChange('month');
        return;
      case 'view-week':
        handleViewModeChange('week');
        return;
      case 'view-year':
        handleViewModeChange('year');
        return;
      case 'reload':
        window.location.reload();
        return;
      case 'desktop-mode':
        // Same as header / tray: enter locked desktop mode.
        void window.myCalendar?.applyWidgetToDesktop?.();
        return;
      default:
        break;
    }
  };

  const calendars = store?.calendars ?? [];
  const events = store?.events ?? [];

  useEffect(() => {
    if (activeEvent && !isEventVisibleToViewer(activeEvent, calendars, isLoggedIn)) {
      setActiveEvent(null);
      setActiveEventDay(null);
      setPopoverAnchor(null);
    }
  }, [activeEvent, calendars, isLoggedIn]);

  const viewOptions = { ...DEFAULT_VIEW_OPTIONS, ...store?.settings?.viewOptions };
  const storeEventsHidden = viewOptions.eventsHidden === true;
  const storeCompletedHidden = viewOptions.completedHidden === true;
  const eventsHidden = eventsHiddenOverride ?? storeEventsHidden;
  const completedHidden = completedHiddenOverride ?? storeCompletedHidden;

  // Drop local overrides only after the store matches for a short settle — avoids one
  // paint where override clears while a racing store still has the previous flag.
  useEffect(() => {
    if (eventsHiddenOverride === null) return;
    if (storeEventsHidden !== eventsHiddenOverride) return;
    const id = window.setTimeout(() => {
      eventsHiddenOverrideRef.current = null;
      setEventsHiddenOverride(null);
    }, 400);
    return () => window.clearTimeout(id);
  }, [storeEventsHidden, eventsHiddenOverride]);

  useEffect(() => {
    if (completedHiddenOverride === null) return;
    if (storeCompletedHidden !== completedHiddenOverride) return;
    const id = window.setTimeout(() => {
      completedHiddenOverrideRef.current = null;
      setCompletedHiddenOverride(null);
    }, 400);
    return () => window.clearTimeout(id);
  }, [storeCompletedHidden, completedHiddenOverride]);

  useEffect(() => {
    if (!eventsHidden) return;
    // Search is a find/inspect path — don't dismiss a result the user just opened.
    if (detailFromSearchRef.current) return;
    clearEventDetail();
  }, [eventsHidden, clearEventDetail]);

  useEffect(() => {
    if (!completedHidden || !activeEvent?.completed) return;
    if (detailFromSearchRef.current) return;
    clearEventDetail();
  }, [completedHidden, activeEvent?.completed, clearEventDetail]);
  const colorScheme = store?.settings?.viewOptions
    ? getColorScheme(store.settings.viewOptions)
    : (readStoredColorScheme() ?? 'system');
  useEffect(() => {
    applyColorScheme(colorScheme);
    const effective = resolveEffectiveColorScheme(colorScheme);
    // Native ApplyFrameTheme is idempotent when dark is unchanged.
    void window.myCalendar?.setWindowFrameTheme?.(effective === 'dark');
  }, [colorScheme]);

  const accentColor = store?.settings?.viewOptions
    ? getAccentColor(store.settings.viewOptions)
    : (readStoredAccentColor() ?? DEFAULT_VIEW_OPTIONS.accentColor);
  useEffect(() => {
    applyAccentColor(accentColor);
  }, [accentColor]);

  useEffect(() => {
    const onEffective = (event) => {
      void window.myCalendar?.setWindowFrameTheme?.(Boolean(event.detail?.dark));
    };
    window.addEventListener('mycalendar:colorSchemeEffective', onEffective);
    return () => {
      window.removeEventListener('mycalendar:colorSchemeEffective', onEffective);
    };
  }, []);

  const hasStore = Boolean(store);
  useEffect(() => {
    if (!loading && hasStore) {
      notifyShellReady();
      // First-launch window mode on Win11 24H2: re-apply resize chrome after UI is up.
      void window.myCalendar?.ensureWindowResizable?.();
    }
    // `hasStore` (not `store`) is intentional — `notifyShellReady()` triggers a native
    // "content-ready" round trip that re-pushes a *fresh* store object (new `updatedAt`
    // every time), which would change `store`'s reference and re-fire this effect,
    // which sends content-ready again... an infinite loop that pegged the native bridge
    // at 100-260 calls/sec and ran WebView2 RAM up into the GBs. Only fire once per
    // loading→loaded transition.
  }, [loading, hasStore]);

  // Desktop locked: any in-app double-click raises; stay up while pointer is down /
  // overlays are open; idle (~10s) or outside click returns under other apps.
  // Must stay above any early return — conditional hooks trigger React #310.
  useDesktopForegroundSession({
    keepRaised: Boolean(
      quickEdit
      || editorOpen
      || settingsOpen
      || searchOpen
      || loginOpen
      || scopeDialog,
    ),
  });

  // Login wall: show the login dialog first whenever the app isn't authenticated yet.
  const autoLoginPromptedRef = useRef(false);
  useEffect(() => {
    if (autoLoginPromptedRef.current || loading || isLoggedIn) {
      return;
    }
    autoLoginPromptedRef.current = true;

    setLoginError(null);
    setLoginOpen(true);

    if (!isNeutralinoDesktopShell() || !window.myCalendar?.getWidgetStatus) {
      return undefined;
    }

    let cancelled = false;
    let suspended = false;
    let pollId = null;
    let stopTimer = null;
    const clearPolling = () => {
      if (pollId !== null) window.clearInterval(pollId);
      if (stopTimer !== null) window.clearTimeout(stopTimer);
    };
    const trySuspend = async () => {
      // Stop once the user dismissed the dialog themselves — don't re-unlock behind them.
      if (cancelled || suspended || !loginOpenRef.current) return;
      try {
        const status = await window.myCalendar.getWidgetStatus();
        if (status?.embedded && !status?.embedSuspended && window.myCalendar?.suspendDesktopEmbedForUi) {
          suspended = true;
          clearPolling();
          await window.myCalendar.suspendDesktopEmbedForUi('auth');
        }
      } catch {
        /* ignore — retried on the next tick */
      }
    };

    void (async () => {
      // When launchMode=desktop, OnLoaded deferred-embeds ~400ms after load. Claim suspend
      // first so that embed keeps App visible under the login dialog. Window-mode boot
      // (first install) no-ops the claim — otherwise the desktop toggle looks pressed.
      // If claim fails (embed already started), poll + suspendDesktopEmbedForUi as fallback.
      try {
        const claim = await window.myCalendar?.claimBootSuspendForAuth?.();
        if (claim?.claimed || cancelled) return;
      } catch {
        /* ignore — fall through to polling */
      }
      void trySuspend();
      pollId = window.setInterval(() => void trySuspend(), 200);
      stopTimer = window.setTimeout(clearPolling, 5000);
    })();

    return () => {
      cancelled = true;
      clearPolling();
    };
  }, [loading, isLoggedIn]);

  if (loading && !store) {
    return (
      <div className="grid h-full place-content-center gap-3 bg-gcal-page text-gcal-muted">
        <AppIcon size={56} className="mx-auto" />
        <p>캘린더 불러오는 중…</p>
      </div>
    );
  }

  // Always honor calendar eye-toggle (visible:false) — even when logged in.
  // Settings still receives the full `calendars` list so hidden ones can be re-shown.
  const viewableCalendars = filterCalendarsForViewer(calendars, false);
  const viewableEvents = filterEventsForViewer(events, calendars, false);
  // Keep events mounted for both hide toggles — MonthView hides via CSS / stable lanes
  // so the grid does not remount/flicker on toggle.
  const displayEvents = viewableEvents;
  const displayDayColors = store?.settings?.dayColors ?? {};
  const ownerName = store?.settings?.ownerName ?? DEFAULT_SETTINGS.ownerName;
  const weekStartsOn = getWeekStartsOn(viewOptions);
  const popoverEvent = isEventVisibleToViewer(activeEvent, calendars, false) ? activeEvent : null;
  const weeksInViewport = viewMode === 'week' ? 1 : 5;
  const suppressPointerZones = Boolean(
    settingsOpen || searchOpen || editorOpen || loginOpen || scopeDialog || quickEdit,
  );

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-gcal-page-alt to-gcal-page">
      {isNeutralinoDesktopShell() ? <TitleBar /> : null}
      <Header
        viewDate={viewDate}
        selectedDate={selectedDate}
        viewMode={viewMode}
        weekStartsOn={weekStartsOn}
        online={online}
        syncInfo={syncInfo}
        isLoggedIn={isLoggedIn}
        authUser={user}
        exporting={exporting}
        settingsOpen={settingsOpen}
        searchOpen={searchOpen}
        suppressPointerZones={suppressPointerZones}
        onToday={goToday}
        onPrev={() => {
          if (viewMode === 'year') shiftYear(-1);
          else if (viewMode === 'week') shiftWeek(-1);
          else shiftMonth(-1);
        }}
        onNext={() => {
          if (viewMode === 'year') shiftYear(1);
          else if (viewMode === 'week') shiftWeek(1);
          else shiftMonth(1);
        }}
        onPrevYear={() => shiftYear(-1)}
        onNextYear={() => shiftYear(1)}
        onViewModeChange={handleViewModeChange}
        onOpenSettings={openSettings}
        onOpenSearch={openSearch}
        onAuthToggle={handleAuthToggle}
        onExportExcel={() => {
          void handleExport('excel').finally(() => {
            void resumeDesktopEmbedIfNeeded();
          });
        }}
        onExportPdf={() => {
          void handleExport('pdf').finally(() => {
            void resumeDesktopEmbedIfNeeded();
          });
        }}
        onResumeDesktop={resumeDesktopEmbedIfNeeded}
        eventsHidden={eventsHidden}
        onToggleEventsHidden={handleToggleEventsHidden}
        completedHidden={completedHidden}
        onToggleCompletedHidden={handleToggleCompletedHidden}
      />

      <SearchPanel
        open={searchOpen}
        events={displayEvents}
        calendars={viewableCalendars}
        tags={store?.tags ?? []}
        onClose={closeSearch}
        onSelectResult={handleSearchSelect}
      />

      <main className="min-h-0 flex-1 overflow-hidden bg-gcal-page">
        {viewMode === 'year' ? (
          <YearView
            viewDate={viewDate}
            selectedDate={selectedDate}
            viewOptions={viewOptions}
            interactive={isLoggedIn}
            onSelectMonth={(monthIndex) => {
              setViewDate(new Date(viewDate.getFullYear(), monthIndex, 1));
              setViewMode('month');
              requestMonthAlign('month');
            }}
            onSelectDate={(date) => setSelectedDate(date)}
            onDayQuickEdit={(date) => {
              openDayQuickEditForDate(date, { alignMonth: true });
            }}
          />
        ) : (
          <MonthView
            viewDate={viewDate}
            selectedDate={selectedDate}
            events={displayEvents}
            calendars={viewableCalendars}
            tags={store?.tags ?? []}
            viewOptions={viewOptions}
            dayColors={displayDayColors}
            monthAlign={monthAlign}
            weeksInViewport={weeksInViewport}
            interactive={isLoggedIn}
            editorOpen={editorOpen}
            eventsHidden={eventsHidden}
            completedHidden={completedHidden}
            onVisibleMonthChange={handleVisibleMonthChange}
            onVisibleWeekChange={handleVisibleWeekChange}
            onSelectDate={(date) => setSelectedDate(date)}
            onDayQuickEdit={openDayQuickEdit}
            onCreateDate={(date) => openDayQuickEditForDate(date)}
            onEventClick={(event, _clientX, _clientY, dayKey) => {
              // Month grid bars no longer single-click open QE (window = desktop).
              // Kept for any remaining list / legacy callers.
              if (isDesktopSurfaceHost()) return;
              openDayQuickEditForEvent(event, dayKey);
            }}
            onEventDetail={(event, clientX, clientY, dayKey, anchorRect) => {
              // Bar / list click (or context menu) → read-only detail (in-place).
              if (!isEventVisibleToViewer(event, calendars, false)) return;
              if (quickEdit || editorOpen) return;
              openEventDetail(event, dayKey, anchorRect ?? { x: clientX, y: clientY });
            }}
            onCloseEventDetail={() => {
              // "더보기" list opening — close bar detail so the day list can open cleanly.
              clearEventDetail();
            }}
            onEventEdit={(event, dayKey) => {
              // Bar / list-row double-click → full EventEditor.
              openEditEvent(event, dayKey, { fromQuickEdit: false });
            }}
            onReorderEvents={handleReorderEvents}
            wheelLocked={settingsOpen || searchOpen || Boolean(quickEdit)}
          />
        )}
      </main>

      {quickEdit && (
        <DayQuickEditPopover
          date={quickEdit.date}
          dayKey={quickEdit.dayKey}
          events={viewableEvents}
          calendars={viewableCalendars}
          tags={store?.tags ?? []}
          dayColor={store?.settings?.dayColors?.[quickEdit.dayKey] ?? null}
          anchorRect={quickEdit.anchorRect}
          focusEvent={quickEdit.focusEvent}
          canEdit={isLoggedIn}
          expandBody={viewMode === 'month'}
          onClose={() => {
            if (scopeDialog) return;
            closeDayQuickEdit();
          }}
          onCreate={async (payload) => {
            if (!isLoggedIn) {
              await alert('관리자 로그인 후 일정을 추가할 수 있습니다.');
              return;
            }
            try {
              await addEvent(payload);
            } catch (err) {
              await alert(err instanceof Error ? err.message : '일정을 추가하지 못했습니다.');
            }
          }}
          onToggleCompleted={async (event, completed) => {
            if (!isLoggedIn) {
              await alert('관리자 로그인 후 일정을 수정할 수 있습니다.');
              return;
            }
            const master = findMasterEvent(event);
            if (!master || master.calendarId === HOLIDAYS_KR_CALENDAR_ID) return;
            try {
              if (!isRecurringEvent(master)) {
                await editEvent(master.id, { completed: Boolean(completed) });
                return;
              }
              const occurrenceDate = getOccurrenceDate(event, quickEdit.dayKey);
              setPendingComplete({
                master,
                occurrenceDate,
                completed: Boolean(completed),
              });
              setScopeDialog({ mode: 'complete' });
            } catch (err) {
              await alert(err instanceof Error ? err.message : '완료 상태를 변경하지 못했습니다.');
            }
          }}
          onEventMarkerShapeChange={async (event, shapeId) => {
            if (!isLoggedIn) {
              await alert('관리자 로그인 후 일정을 수정할 수 있습니다.');
              return;
            }
            const master = findMasterEvent(event);
            if (!master || master.calendarId === HOLIDAYS_KR_CALENDAR_ID) return;
            try {
              await editEvent(master.id, { markerShape: shapeId });
            } catch (err) {
              await alert(err instanceof Error ? err.message : '표시 도형을 변경하지 못했습니다.');
            }
          }}
          onEventLinkChange={async (event, nextLinks) => {
            if (!isLoggedIn) {
              await alert('관리자 로그인 후 일정을 수정할 수 있습니다.');
              return;
            }
            const master = findMasterEvent(event);
            if (!master || master.calendarId === HOLIDAYS_KR_CALENDAR_ID) return;
            try {
              const links = normalizeEventLinksArray(nextLinks);
              await editEvent(master.id, {
                links,
                link: getPrimaryEventLinkUrl({ links }),
              });
            } catch (err) {
              await alert(err instanceof Error ? err.message : '바로가기를 변경하지 못했습니다.');
            }
          }}
          onEventCalendarChange={async (event, calendarId) => {
            if (!isLoggedIn) {
              await alert('관리자 로그인 후 일정을 수정할 수 있습니다.');
              return;
            }
            const master = findMasterEvent(event);
            if (!master || master.calendarId === HOLIDAYS_KR_CALENDAR_ID) return;
            try {
              await editEvent(master.id, { calendarId });
            } catch (err) {
              await alert(err instanceof Error ? err.message : '캘린더를 변경하지 못했습니다.');
            }
          }}
          onEventTagChange={async (event, tagIds) => {
            if (!isLoggedIn) {
              await alert('관리자 로그인 후 일정을 수정할 수 있습니다.');
              return;
            }
            const master = findMasterEvent(event);
            if (!master || master.calendarId === HOLIDAYS_KR_CALENDAR_ID) return;
            try {
              await editEvent(master.id, { tagIds: Array.isArray(tagIds) ? tagIds : [] });
            } catch (err) {
              await alert(err instanceof Error ? err.message : '태그를 변경하지 못했습니다.');
            }
          }}
          onReorderEvents={handleReorderEvents}
          onAttachFiles={async (event) => {
            if (!isLoggedIn) {
              await alert('관리자 로그인 후 파일을 첨부할 수 있습니다.');
              return;
            }
            if (!isNativeHost()) {
              await alert('파일 첨부는 데스크톱 앱에서만 사용할 수 있습니다.');
              return;
            }
            const master = findMasterEvent(event);
            if (!master || master.calendarId === HOLIDAYS_KR_CALENDAR_ID) {
              await alert('저장된 일정에만 파일을 첨부할 수 있습니다.');
              return;
            }
            try {
              await addEventAttachments(master.id);
            } catch (err) {
              await alert(err instanceof Error ? err.message : '파일을 첨부하지 못했습니다.');
            }
          }}
          onDayColorChange={(color) => {
            if (!isLoggedIn) {
              void alert('로그인 후 날짜 배경 색상을 변경할 수 있습니다.');
              return;
            }
            const dayKey = quickEdit.dayKey;
            const current = { ...(storeThemeRef.current?.settings?.dayColors ?? {}) };
            if (color) {
              current[dayKey] = color;
            } else {
              delete current[dayKey];
            }
            // Fire-and-forget: updateSettings already applies dayColors optimistically
            // so the cell paints on the same click frame, not after the PATCH round-trip.
            void updateSettings({ dayColors: current }).catch((err) => {
              void alert(err instanceof Error ? err.message : '날짜 색상을 저장하지 못했습니다.');
            });
          }}
          onOpenMore={(date, selectedEvent) => {
            if (
              selectedEvent
              && selectedEvent.calendarId !== HOLIDAYS_KR_CALENDAR_ID
              && isLoggedIn
            ) {
              openEditEvent(selectedEvent, quickEdit.dayKey, { fromQuickEdit: true });
              return;
            }
            openCreateEvent(date, { fromQuickEdit: true });
          }}
        />
      )}

      <footer
        data-shell-chrome="footer"
        className="relative z-20 flex shrink-0 items-center justify-end border-t border-gcal-border-light bg-[#efefef] px-4 py-2 dark:bg-gcal-page"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <SiteLink />
      </footer>

      <EventPopover
        event={popoverEvent}
        calendar={viewableCalendars.find((c) => c.id === popoverEvent?.calendarId)}
        tags={store?.tags ?? []}
        dayKey={activeEventDay}
        anchorRect={popoverAnchor}
        canEdit={isLoggedIn && popoverEvent?.calendarId !== HOLIDAYS_KR_CALENDAR_ID}
        onClose={clearEventDetail}
        onEdit={(event) => {
          // Detail pencil → full EventEditor (not quick-edit). Closes detail + day list.
          openEditEvent(event, activeEventDay, { fromQuickEdit: false });
        }}
        onDelete={handleDeleteRequest}
        onToggleCompleted={async (event, completed) => {
          if (!isLoggedIn) {
            await alert('관리자 로그인 후 일정을 수정할 수 있습니다.');
            return;
          }
          const master = findMasterEvent(event);
          if (!master || master.calendarId === HOLIDAYS_KR_CALENDAR_ID) return;
          const nextCompleted = Boolean(completed);
          try {
            if (!isRecurringEvent(master)) {
              await editEvent(master.id, { completed: nextCompleted });
              setActiveEvent((prev) => (prev ? { ...prev, completed: nextCompleted } : prev));
              return;
            }
            const occurrenceDate = getOccurrenceDate(event, activeEventDay);
            setPendingComplete({
              master,
              occurrenceDate,
              completed: nextCompleted,
            });
            setScopeDialog({ mode: 'complete' });
          } catch (err) {
            await alert(err instanceof Error ? err.message : '완료 상태를 변경하지 못했습니다.');
          }
        }}
      />

      {isLoggedIn && (
        <EventEditor
          open={editorOpen}
          event={editorEvent}
          calendars={calendars}
          tags={store?.tags ?? []}
          defaultDate={selectedDate}
          onClose={closeEditor}
          onSave={handleSave}
          onDelete={(event) => void handleDeleteRequest(event, { fromEditor: true })}
          onEventRefresh={(updated) => {
            if (!updated?.id) return;
            setEditorEvent((prev) => {
              if (!prev || prev.id !== updated.id) return prev;
              return {
                ...prev,
                attachments: Array.isArray(updated.attachments) ? updated.attachments : [],
              };
            });
          }}
        />
      )}

      <RecurrenceScopeDialog
        open={Boolean(scopeDialog)}
        mode={scopeDialog?.mode ?? 'edit'}
        onClose={() => {
          setScopeDialog(null);
          if (scopeDialog?.mode === 'edit') {
            /* keep editor open so user can cancel scope and continue editing */
          }
          if (scopeDialog?.mode === 'delete') {
            setPendingDelete(null);
          }
          if (scopeDialog?.mode === 'complete') {
            setPendingComplete(null);
          }
        }}
        onSelect={(scope) => void handleScopeSelect(scope)}
      />

      {isLoggedIn && (
        <SettingsPanel
          open={settingsOpen}
          onClose={closeSettings}
          store={store}
          settings={store?.settings}
          ownerName={ownerName}
          calendars={calendars}
          currentLoginId={user ?? ''}
          isSuperAdmin={isSuperAdmin}
          onCreateCalendar={addCalendar}
          onAddEvent={addEvent}
          onUpdateCalendar={editCalendar}
          onClearCalendarEvents={clearCalendarEvents}
          onDeleteCalendar={removeCalendar}
          onCreateTag={addTag}
          onUpdateTag={editTag}
          onDeleteTag={removeTag}
          onImportStore={replaceStore}
          onImportIntoCalendar={importEventsIntoCalendar}
          onSaveSettings={updateSettings}
          onToggleCalendarVisibility={toggleCalendar}
          onSyncHolidays={syncHolidays}
        />
      )}

      <LoginDialog
        open={loginOpen}
        loggingIn={loggingIn}
        error={loginError}
        dismissible
        onClose={() => {
          setLoginOpen(false);
          setLoginError(null);
          void resumeDesktopEmbedIfNeeded();
        }}
        onLogin={handleLogin}
      />

    </div>
  );
}
