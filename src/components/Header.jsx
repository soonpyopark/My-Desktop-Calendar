import { useCallback, useEffect, useRef, useState } from 'react';
import { getLunarMonthLabel } from '../lib/lunar.js';
import { cn } from '../lib/cn.js';
import { APP_NAME, APP_VERSION } from '../../shared/constants.js';
import { addDays, startOfWeek, toDateKey } from '../lib/calendarUtils.js';
import { openExternalUrl } from '../lib/openExternal.js';
import { isNeutralinoDesktopShell } from '../lib/isNeutralinoDesktopShell.js';
import { useAppDialog } from './AppDialogProvider.jsx';

const VIEW_MODE_OPTIONS = [
  { value: 'year', label: '연' },
  { value: 'week', label: '주' },
  { value: 'month', label: '월' },
];

const iconBtnClass =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-transparent text-gcal-muted transition-colors hover:border-gcal-border hover:bg-gcal-surface-2';

const navBtnClass =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-gcal-border bg-gcal-yellow-soft text-gcal-heading transition-colors hover:bg-[#fef0c3] dark:hover:bg-gcal-surface-2';

const yearNavBtnClass =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-gcal-border bg-gcal-yellow-soft text-gcal-heading transition-colors hover:bg-[#fef0c3] dark:hover:bg-gcal-surface-2';

/** Inactive/active are mutually exclusive full class strings — merging a base bg with a
 * conditional override bg (two same-specificity Tailwind utilities) is cascade-order
 * dependent and can silently lose to the base class, so pick one string outright instead. */
const viewModeIconBtnClass =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-gcal-border bg-gcal-green-soft text-gcal-heading transition-colors hover:bg-[#dcefe0] dark:hover:bg-gcal-surface-2';

const viewModeIconBtnActiveClass =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-gcal-blue bg-[#bbdefb] text-gcal-blue-dark transition-colors hover:bg-[#90caf9] dark:border-gcal-blue dark:bg-gcal-blue-soft';

const VIEW_MODE_ICONS = {
  month: MonthViewIcon,
  week: WeekViewIcon,
  year: YearViewIcon,
};

function DoubleChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.41 16.59 13.82 12l4.59-4.59L17 6l-6 6 6 6 1.41-1.41zM10 6H8v12h2V6z"
      />
    </svg>
  );
}

function DoubleChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M5.59 7.41 10.18 12l-4.59 4.59L7 18l6-6-6-6-1.41 1.41zM16 6h-2v12h2V6z"
      />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
    </svg>
  );
}

/** Shared calendar-page outline (tabs + header rule) that the view-mode icons fill in. */
function CalendarOutlineIcon({ children }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none">
      <path d="M7 2.5v3M17 2.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="3.25" y="4.5" width="17.5" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.25 9.25h17.5" stroke="currentColor" strokeWidth="1.6" />
      {children}
    </svg>
  );
}

/** 월(월별 격자) 보기 아이콘. */
function MonthViewIcon() {
  return (
    <CalendarOutlineIcon>
      <rect x="5.75" y="11" width="3.4" height="2.6" rx="0.6" fill="currentColor" />
      <rect x="10.3" y="11" width="3.4" height="2.6" rx="0.6" fill="currentColor" />
      <rect x="14.85" y="11" width="3.4" height="2.6" rx="0.6" fill="currentColor" />
      <rect x="5.75" y="15.4" width="3.4" height="2.6" rx="0.6" fill="currentColor" />
      <rect x="10.3" y="15.4" width="3.4" height="2.6" rx="0.6" fill="currentColor" />
    </CalendarOutlineIcon>
  );
}

/** 주(가로 한 줄) 보기 아이콘. */
function WeekViewIcon() {
  return (
    <CalendarOutlineIcon>
      <rect x="5.75" y="12.3" width="12.5" height="4" rx="0.8" fill="currentColor" />
    </CalendarOutlineIcon>
  );
}

/** 연(월별 12칸 소형 격자) 보기 아이콘. */
function YearViewIcon() {
  return (
    <CalendarOutlineIcon>
      {[11.05, 13.65, 16.25].map((y) => (
        [5.75, 9.15, 12.55, 15.95].map((x) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="2.3" height="1.7" rx="0.4" fill="currentColor" />
        ))
      ))}
    </CalendarOutlineIcon>
  );
}

const desktopModeIconBtnClass =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-40';

/** Soft blue fill for window / desktop / web / eye / completed toolbar icons. */
const softBlueIconBtnClass =
  'border-gcal-border bg-[#e3f2fd] text-gcal-blue-dark hover:bg-[#bbdefb] dark:border-gcal-border dark:bg-gcal-blue-soft dark:text-gcal-heading dark:hover:bg-gcal-surface-2';

const softBlueIconBtnActiveClass =
  'border-gcal-blue bg-[#bbdefb] text-gcal-blue-dark hover:bg-[#90caf9] dark:border-gcal-blue dark:bg-gcal-blue-soft';

/** Current mode already applied — keep soft blue but fade the control. */
const softBlueIconBtnMutedClass = 'opacity-45 hover:opacity-70';

function WindowModeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m0 16H5V8h14v11z"
      />
    </svg>
  );
}

function DesktopModeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7l-2 3v1h8v-1l-2-3h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 12H3V4h18v10z"
      />
    </svg>
  );
}

function WebBrowserIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
      />
    </svg>
  );
}

/** @param {{ open: boolean }} props */
function HideEventsEyeIcon({ open }) {
  if (open) {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"
      />
    </svg>
  );
}

/** @param {{ checked: boolean }} props */
function HideCompletedCheckIcon({ checked }) {
  if (checked) {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"
      />
    </svg>
  );
}

/** Shared page-with-folded-corner outline that Excel/PDF icons label. */
function DocumentOutlineIcon({ children }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"
      />
      {children}
    </svg>
  );
}

function ExcelIcon() {
  return (
    <DocumentOutlineIcon>
      <text x="12.5" y="17.2" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor">X</text>
    </DocumentOutlineIcon>
  );
}

function PdfIcon() {
  return (
    <DocumentOutlineIcon>
      <text x="12.5" y="16.8" textAnchor="middle" fontSize="5.5" fontWeight="700" fill="currentColor">PDF</text>
    </DocumentOutlineIcon>
  );
}

const actionBtnBase =
  'inline-flex h-9 shrink-0 items-center justify-center rounded border border-gcal-border px-2 text-xs font-semibold text-gcal-heading disabled:cursor-not-allowed disabled:opacity-40 sm:min-w-[72px] sm:px-3 sm:text-sm';

/**
 * @param {Date} date
 * @param {number} weekStartsOn
 */
function formatWeekTitle(date, weekStartsOn) {
  const start = startOfWeek(date, weekStartsOn);
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    return `${start.getFullYear()}년 ${start.getMonth() + 1}월 ${start.getDate()}일 – ${end.getDate()}일`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${start.getFullYear()}년 ${start.getMonth() + 1}월 ${start.getDate()}일 – ${end.getMonth() + 1}월 ${end.getDate()}일`;
  }
  return `${start.getFullYear()}년 ${start.getMonth() + 1}월 ${start.getDate()}일 – ${end.getFullYear()}년 ${end.getMonth() + 1}월 ${end.getDate()}일`;
}

export default function Header({
  viewDate,
  selectedDate,
  viewMode,
  weekStartsOn = 0,
  online,
  syncInfo,
  isLoggedIn,
  authUser,
  exporting,
  settingsOpen = false,
  searchOpen = false,
  suppressPointerZones = false,
  onToday,
  onPrev,
  onNext,
  onPrevYear,
  onNextYear,
  onViewModeChange,
  onOpenSettings,
  onOpenSearch,
  onAuthToggle,
  onExportExcel,
  onExportPdf,
  onResumeDesktop,
  eventsHidden = false,
  onToggleEventsHidden,
  completedHidden = false,
  onToggleCompletedHidden,
}) {
  const { alert } = useAppDialog();
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth() + 1;
  const lunarLabel = viewMode === 'month' ? getLunarMonthLabel(year, month) : null;
  const titleDate = selectedDate ?? viewDate;

  let periodTitle = `${year}년 ${month}월`;
  if (viewMode === 'year') periodTitle = `${year}년`;
  if (viewMode === 'week') periodTitle = formatWeekTitle(titleDate, weekStartsOn);

  const prevLabel = viewMode === 'year' ? '이전 연도' : viewMode === 'week' ? '이전 주' : '이전 월';
  const nextLabel = viewMode === 'year' ? '다음 연도' : viewMode === 'week' ? '다음 주' : '다음 월';

  const [desktopWidgetAvailable, setDesktopWidgetAvailable] = useState(false);
  const [desktopEmbedded, setDesktopEmbedded] = useState(false);
  const [desktopEditMode, setDesktopEditMode] = useState(false);
  const [actuallyEmbedded, setActuallyEmbedded] = useState(false);
  /** Top-level WS_POPUP desktop — native clicks reach React; do not suppress onClick. */
  const [popupStyleEmbed, setPopupStyleEmbed] = useState(false);
  const [desktopReady, setDesktopReady] = useState(true);
  const [desktopChecks, setDesktopChecks] = useState([]);
  const [applyingDesktop, setApplyingDesktop] = useState(false);
  const windowModeBtnRef = useRef(null);
  const headerRef = useRef(null);

  const webEditPort = Number(syncInfo?.port) || 0;
  const webEditRunning = Boolean(syncInfo?.running ?? syncInfo?.serverRunning);
  const webEditAvailable = webEditRunning && webEditPort > 0;
  const webEditUrl = webEditAvailable ? `http://localhost:${webEditPort}/` : '';

  const isWindowModeActive = !desktopEmbedded || desktopEditMode;
  const isDesktopModeActive = desktopEmbedded && !desktopEditMode;
  const needsUiSuspend = desktopWidgetAvailable && desktopEmbedded && !desktopEditMode;

  const CHROME_NAV_ACTIONS = new Set([
    'prev',
    'next',
    'today',
    'prev-year',
    'next-year',
    'open-web',
    'view-mode',
    'view-month',
    'view-week',
    'view-year',
  ]);

  /**
   * Unlike CHROME_NAV_ACTIONS (pure ephemeral, per-surface React state with no other
   * sync path — the explicit suspendDesktopEmbedForUi mirror is the *only* way the
   * other WebView2 surface ever learns "today" advanced), hide/show-events and
   * hide/show-completed toggle a persisted setting (viewOptions.eventsHidden /
   * completedHidden). onToggleEventsHidden/onToggleCompletedHidden already call
   * updateSettings(), which round-trips through CalendarStoreService.StoreChanged →
   * NativeBridge.OnStoreChanged → a "store-updated" broadcast to *both* surfaces —
   * so the other surface was always going to pick this up on its own. Also firing the
   * chrome-nav mirror raced that broadcast: if the mirror's pendingUiAction reached
   * the other surface before its own store-updated broadcast did, that surface's
   * local eventsHidden/completedHidden hadn't flipped yet, so the guard in
   * applyEventsHidden/applyCompletedHidden didn't catch it as a no-op — it ran a
   * *second* updateSettings() PATCH, forcing a second full store round-trip/re-render
   * a beat after the first (visible as a flicker on both surfaces).
   */
  const STORE_SYNCED_UI_ACTIONS = new Set([
    'hide-events',
    'show-events',
    'hide-completed',
    'show-completed',
  ]);

  const suspendForUi = useCallback((action) => {
    if (!needsUiSuspend || !window.myCalendar?.suspendDesktopEmbedForUi) {
      return;
    }
    void window.myCalendar.suspendDesktopEmbedForUi(action);
  }, [needsUiSuspend]);

  const resumeDesktop = useCallback(() => {
    void onResumeDesktop?.();
  }, [onResumeDesktop]);

  const selectViewMode = useCallback((mode) => {
    // Single-HWND now — no second surface left to mirror to (see withUiSuspend).
    onViewModeChange?.(mode);
  }, [onViewModeChange]);

  /** @param {string} action @param {(() => void) | undefined} fn @param {{ resume?: boolean }} [options] */
  const withUiSuspend = useCallback((action, fn, options = {}) => () => {
    // Eye / completed toggles are not hit-zones — always apply locally.
    if (STORE_SYNCED_UI_ACTIONS.has(action)) {
      fn?.();
      return;
    }

    // Legacy shell-child embed: DefView steals clicks; zones deliver UI actions.
    // Top-level WS_POPUP (popupStyleEmbed): native clicks reach React — run handlers.
    if (actuallyEmbedded && !desktopEditMode && !popupStyleEmbed) {
      return;
    }

    const shouldResume = Boolean(options.resume && needsUiSuspend);
    // Single-HWND now: fn() below always runs directly on this surface. Chrome-nav
    // actions used to also mirror through suspendDesktopEmbedForUi() so the *other*
    // (now-removed) surface's App view could hear "prev/next fired" and catch up — with
    // only one surface left, that round-trip just echoes pendingUiAction back to this
    // same WebView (via widget-status → mycalendar:pendingUiAction), re-running the same
    // navigation a second time and advancing the month/week by two per click.
    if (!CHROME_NAV_ACTIONS.has(action) && isNeutralinoDesktopShell()) {
      suspendForUi(action);
    }
    try {
      fn?.();
    } finally {
      if (shouldResume) {
        window.setTimeout(() => resumeDesktop(), 0);
      }
    }
  }, [needsUiSuspend, resumeDesktop, suspendForUi, actuallyEmbedded, desktopEditMode, popupStyleEmbed]);

  const reportUndockZone = useCallback(() => {
    if (!window.myCalendar?.setUndockZone) {
      return;
    }

    // WS_POPUP desktop: window-mode button uses native React onClick — no hit-zone.
    if (!actuallyEmbedded || desktopEditMode || popupStyleEmbed) {
      void window.myCalendar.clearUndockZone?.();
      return;
    }

    const el = windowModeBtnRef.current;
    if (!el) {
      void window.myCalendar.clearUndockZone?.();
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      void window.myCalendar.clearUndockZone?.();
      return;
    }

    void window.myCalendar.setUndockZone({
      clientRect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  }, [actuallyEmbedded, desktopEditMode, popupStyleEmbed]);

  const reportUiActionZones = useCallback(() => {
    if (!window.myCalendar?.setUiActionZones) {
      return;
    }

    // Zones only for legacy shell-child embeds (DefView steals clicks).
    // WS_POPUP / window mode: React onClick handles buttons — zones would double-fire.
    if (suppressPointerZones || !actuallyEmbedded || popupStyleEmbed) {
      void window.myCalendar.setUiActionZones(null);
      return;
    }

    const root = headerRef.current;
    if (!root) {
      void window.myCalendar.setUiActionZones(null);
      return;
    }

    /** @type {Array<{ left: number, top: number, width: number, height: number, action: string }>} */
    const clientRects = [];
    for (const el of root.querySelectorAll('[data-ui-action]')) {
      if (el instanceof HTMLButtonElement && el.disabled) {
        continue;
      }
      const action = el.getAttribute('data-ui-action')?.trim().toLowerCase();
      if (!action) continue;
      // Persisted hide toggles sync via store-updated only. Reporting them as hit-zones
      // lets UndockZoneMonitor fire SuspendForUi on the same physical click as React
      // onClick — which used to double-apply (or race) the setting on dual WebViews.
      if (STORE_SYNCED_UI_ACTIONS.has(action)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      clientRects.push({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        action,
      });
    }

    void window.myCalendar.setUiActionZones(
      clientRects.length ? { clientRects } : null,
    );
  }, [actuallyEmbedded, desktopEditMode, suppressPointerZones, popupStyleEmbed]);

  const refreshWidgetStatus = useCallback(async () => {
    if (!isNeutralinoDesktopShell() || !window.myCalendar?.getWidgetStatus) {
      setDesktopWidgetAvailable(false);
      setDesktopEmbedded(false);
      setDesktopEditMode(false);
      setActuallyEmbedded(false);
      setPopupStyleEmbed(false);
      setDesktopReady(true);
      setDesktopChecks([]);
      return;
    }
    try {
      const status = await window.myCalendar.getWidgetStatus();
      const suspended = Boolean(status.embedSuspended || status.resumeDesktopPending);
      setDesktopWidgetAvailable(Boolean(status.available));
      setActuallyEmbedded(Boolean(status.embedded));
      setPopupStyleEmbed(Boolean(status.popupStyleEmbed));
      // Treat temporary unlock (quick-edit/auth/export) as still desktop so closing
      // UI can resume embed, and the mode toggle stays correct while suspended.
      setDesktopEmbedded(Boolean(status.embedded) || suspended);
      setDesktopEditMode(Boolean(status.editMode) && !suspended);
      setDesktopReady(status.ready !== false);
      setDesktopChecks(Array.isArray(status.checks) ? status.checks : []);
    } catch {
      setDesktopWidgetAvailable(false);
      setDesktopEmbedded(false);
      setDesktopEditMode(false);
      setActuallyEmbedded(false);
      setPopupStyleEmbed(false);
      setDesktopReady(true);
      setDesktopChecks([]);
    }
  }, []);

  useEffect(() => {
    if (!desktopWidgetAvailable) {
      void window.myCalendar?.clearUndockZone?.();
      void window.myCalendar?.clearUiActionZones?.();
      return undefined;
    }

    const syncZone = () => {
      requestAnimationFrame(() => {
        reportUndockZone();
        reportUiActionZones();
      });
    };

    syncZone();
    window.addEventListener('resize', syncZone);

    const observed = [
      headerRef.current,
      windowModeBtnRef.current,
    ].filter(Boolean);
    let resizeObserver;
    if (observed.length && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(syncZone);
      for (const el of observed) {
        resizeObserver.observe(el);
      }
    }

    const intervalId = window.setInterval(syncZone, 2000);

    return () => {
      window.removeEventListener('resize', syncZone);
      resizeObserver?.disconnect();
      window.clearInterval(intervalId);
      void window.myCalendar?.clearUndockZone?.();
      void window.myCalendar?.clearUiActionZones?.();
    };
  }, [desktopWidgetAvailable, desktopEmbedded, actuallyEmbedded, reportUndockZone, reportUiActionZones, viewMode, isLoggedIn, suppressPointerZones, eventsHidden, completedHidden, webEditAvailable]);

  useEffect(() => {
    if (!desktopWidgetAvailable) {
      return undefined;
    }
    // Clear immediately when a modal opens, or when not truly embedded (window mode).
    if (suppressPointerZones || !actuallyEmbedded) {
      void window.myCalendar?.clearUiActionZones?.();
    } else {
      reportUiActionZones();
    }
    return undefined;
  }, [desktopWidgetAvailable, suppressPointerZones, actuallyEmbedded, reportUiActionZones, eventsHidden, completedHidden, webEditAvailable]);

  useEffect(() => {
    if (!desktopWidgetAvailable) {
      return undefined;
    }
    void refreshWidgetStatus();
    const intervalId = window.setInterval(() => {
      void refreshWidgetStatus();
    }, 3000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [desktopWidgetAvailable, refreshWidgetStatus]);

  useEffect(() => {
    void refreshWidgetStatus();
    const onStatus = () => {
      void refreshWidgetStatus();
    };
    window.addEventListener('mycalendar:widgetStatusChanged', onStatus);
    window.addEventListener('focus', onStatus);
    return () => {
      window.removeEventListener('mycalendar:widgetStatusChanged', onStatus);
      window.removeEventListener('focus', onStatus);
    };
  }, [refreshWidgetStatus]);

  const publishViewNav = useCallback(() => {
    window.myCalendar?.publishViewNav?.({
      viewMode,
      viewDate: toDateKey(viewDate),
      selectedDate: toDateKey(selectedDate ?? viewDate),
    });
  }, [selectedDate, viewDate, viewMode]);

  const handleOpenWebEditor = useCallback(() => {
    if (!webEditUrl) return;
    void openExternalUrl(webEditUrl);
  }, [webEditUrl]);

  const handleApplyDesktop = async () => {
    if (!window.myCalendar?.applyWidgetToDesktop) {
      return;
    }

    // Fresh readiness when possible — status poll may be stale.
    let ready = desktopReady;
    let checks = desktopChecks;
    if (window.myCalendar.getDesktopReadiness) {
      try {
        const readiness = await window.myCalendar.getDesktopReadiness();
        ready = readiness?.ready !== false && Boolean(readiness?.ready);
        checks = Array.isArray(readiness?.checks) ? readiness.checks : checks;
        setDesktopReady(ready);
        setDesktopChecks(checks);
      } catch {
        /* keep polled state */
      }
    }

    if (!ready) {
      const missing = checks
        .filter((item) => item && item.ok === false)
        .map((item) => `• ${item.detail || item.label || '알 수 없는 조건'}`);
      await alert(
        [
          '바탕화면 모드에 필요한 조건이 부족합니다.',
          '',
          ...(missing.length ? missing : ['• 조건을 확인할 수 없습니다']),
          '',
          '창 모드에서는 계속 사용할 수 있습니다.',
        ].join('\n'),
        { title: '바탕화면 모드' },
      );
      return;
    }

    setApplyingDesktop(true);
    try {
      publishViewNav();
      const result = await window.myCalendar.applyWidgetToDesktop();
      await refreshWidgetStatus();
      // Readiness passed but the native embed itself came back without an exception and
      // still didn't take — mirror the tray menu's post-call IsEmbedded check so this path
      // isn't a silent no-op (see EnterDesktopModeFromTrayAsync in MainWindow.xaml.cs).
      if (result && result.available !== false && !result.embedded) {
        await alert(
          ['바탕화면 모드 전환에 실패했습니다.', '', '창 모드에서는 계속 사용할 수 있습니다.'].join('\n'),
          { title: '바탕화면 모드' },
        );
      }
    } catch (err) {
      console.error('[desktop] apply widget failed:', err);
      await alert(
        [
          '바탕화면 모드 전환에 실패했습니다.',
          '',
          err?.message || '알 수 없는 오류',
          '',
          '창 모드에서는 계속 사용할 수 있습니다.',
        ].join('\n'),
        { title: '바탕화면 모드' },
      );
    } finally {
      setApplyingDesktop(false);
    }
  };

  const handleEnterWindowMode = async () => {
    if (!window.myCalendar?.enterWidgetEditMode) {
      return;
    }
    try {
      publishViewNav();
      await window.myCalendar.enterWidgetEditMode();
      await refreshWidgetStatus();
    } catch (err) {
      console.error('[desktop] enter window mode failed:', err);
    }
  };

  return (
    <header
      ref={headerRef}
      data-shell-chrome="header"
      className="relative z-20 flex shrink-0 flex-col gap-2 border-b border-gcal-border-light bg-[#efefef] px-4 py-2 dark:bg-gcal-page"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div
        data-shell-chrome="header-actions"
        className="flex min-w-0 items-center justify-between gap-2"
      >
        <div className="flex min-w-0 items-center gap-2.5 whitespace-nowrap">
          <div className="flex items-baseline gap-2">
            <button
              type="button"
              data-ui-action="reload"
              className="whitespace-nowrap border-0 bg-transparent p-0 text-[22px] tracking-tight text-gcal-muted transition-colors hover:text-gcal-blue"
              title="새로고침"
              aria-label="새로고침"
              onClick={withUiSuspend('reload', () => {
                window.location.reload();
              })}
            >
              {APP_NAME}
            </button>
            <span className="shrink-0 text-xs font-medium text-gcal-muted/80">v{APP_VERSION}</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-nowrap items-center justify-end gap-1.5 sm:gap-2">
          <span
            className={cn(
              'hidden shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium xl:inline-flex',
              online ? 'bg-gcal-green-soft text-gcal-green' : 'bg-gcal-red-soft text-[#c5221f]',
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {online ? '온라인' : '오프라인'}
          </span>
          {syncInfo?.addresses?.length > 0 && (
            <span
              className="hidden shrink-0 rounded-full bg-gcal-blue-soft px-2.5 py-1 text-xs text-gcal-blue-dark xl:inline"
              title={`LAN: ${syncInfo.addresses.join(', ')}`}
            >
              LAN :{syncInfo.port}
            </span>
          )}
          <button
            type="button"
            data-ui-action="search"
            className={cn(iconBtnClass, 'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent')}
            aria-label="검색"
            disabled={settingsOpen}
            title={settingsOpen ? '설정을 닫은 후 검색할 수 있습니다' : '검색'}
            onClick={withUiSuspend('search', onOpenSearch)}
          >
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C8.01 14 6 11.99 6 9.5S8.01 5 10.5 5 15 7.01 15 9.5 12.99 14 10.5 14z" /></svg>
          </button>
          {isLoggedIn && (
            <button
              type="button"
              data-ui-action="settings"
              className={cn(iconBtnClass, 'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent')}
              aria-label="설정"
              disabled={searchOpen}
              title={searchOpen ? '검색을 닫은 후 설정할 수 있습니다' : '설정'}
              onClick={withUiSuspend('settings', onOpenSettings)}
            >
              <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" /></svg>
            </button>
          )}
          {desktopWidgetAvailable && (
            <>
              <button
                type="button"
                data-ui-action="desktop-mode"
                className={cn(
                  iconBtnClass,
                  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent',
                  isDesktopModeActive && softBlueIconBtnMutedClass,
                  !desktopReady && !isDesktopModeActive && softBlueIconBtnMutedClass,
                )}
                aria-label="바탕화면"
                aria-pressed={isDesktopModeActive}
                aria-disabled={applyingDesktop || isDesktopModeActive || !desktopReady}
                title={
                  isDesktopModeActive
                    ? '바탕화면 모드 (이동·크기조절·창 버튼 잠금)'
                    : desktopReady
                      ? '현재 위치·크기로 잠금 (이동·크기조절·창 버튼 숨김)'
                      : '조건 미충족 — 클릭하여 확인'
                }
                disabled={applyingDesktop || isDesktopModeActive}
                onClick={() => void handleApplyDesktop()}
              >
                <DesktopModeIcon />
              </button>
              <button
                ref={windowModeBtnRef}
                type="button"
                className={cn(
                  iconBtnClass,
                  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent',
                  isWindowModeActive && softBlueIconBtnMutedClass,
                )}
                aria-label="창모드"
                aria-pressed={isWindowModeActive}
                title="잠금 해제 — 이동·크기조절·창 버튼 사용"
                onClick={() => void handleEnterWindowMode()}
              >
                <WindowModeIcon />
              </button>
            </>
          )}
          <button
            type="button"
            data-ui-action="auth"
            className={cn(actionBtnBase, 'bg-gcal-blue-soft hover:bg-[#d2e3fc]')}
            onClick={withUiSuspend('auth', onAuthToggle)}
            title={isLoggedIn && authUser ? `${authUser} 로그아웃` : '로그인'}
          >
            {isLoggedIn ? '로그아웃' : '로그인'}
          </button>
        </div>
      </div>

      <div className="header-period-row flex min-w-0 items-center justify-center gap-2">
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="보기 모드">
          {VIEW_MODE_OPTIONS.map((opt) => {
            const ViewIcon = VIEW_MODE_ICONS[opt.value];
            const active = viewMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                data-ui-action={`view-${opt.value}`}
                className={active ? viewModeIconBtnActiveClass : viewModeIconBtnClass}
                aria-label={`${opt.label} 보기`}
                aria-pressed={active}
                title={`${opt.label} 보기`}
                onClick={() => selectViewMode(opt.value)}
              >
                <ViewIcon />
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {viewMode === 'month' && (
            <button
              type="button"
              data-ui-action="prev-year"
              className={yearNavBtnClass}
              onClick={withUiSuspend('prev-year', onPrevYear)}
              aria-label="이전 연도"
              title="이전 연도"
            >
              <DoubleChevronLeftIcon />
            </button>
          )}
          <button
            type="button"
            data-ui-action="prev"
            className={`${navBtnClass} mr-5`}
            onClick={withUiSuspend('prev', onPrev)}
            aria-label={prevLabel}
            title={prevLabel}
          >
            <ChevronLeftIcon />
          </button>
          <div className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
            <h1 className="m-0 text-[22px] font-semibold tracking-tight text-gcal-heading">
              {periodTitle}
            </h1>
            {lunarLabel && (
              <span className="hidden shrink-0 rounded-full bg-gcal-blue-soft px-2 py-0.5 text-xs text-gcal-blue-dark xl:inline-block">
                {lunarLabel}
              </span>
            )}
          </div>
          <button
            type="button"
            data-ui-action="next"
            className={`${navBtnClass} ml-5`}
            onClick={withUiSuspend('next', onNext)}
            aria-label={nextLabel}
            title={nextLabel}
          >
            <ChevronRightIcon />
          </button>
          {viewMode === 'month' && (
            <button
              type="button"
              data-ui-action="next-year"
              className={yearNavBtnClass}
              onClick={withUiSuspend('next-year', onNextYear)}
              aria-label="다음 연도"
              title="다음 연도"
            >
              <DoubleChevronRightIcon />
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            data-ui-action="today"
            className="h-9 shrink-0 rounded border border-gcal-border bg-gcal-red-soft px-[18px] font-medium transition-colors hover:bg-[#fad2cf]"
            onClick={withUiSuspend('today', onToday)}
          >
            오늘
          </button>
          {isNeutralinoDesktopShell() && (
              <button
                type="button"
                data-ui-action="open-web"
                className={cn(desktopModeIconBtnClass, softBlueIconBtnClass)}
                aria-label="브라우저에서 편집"
                title={
                  webEditAvailable
                    ? `브라우저에서 편집 (${webEditUrl})`
                    : '로컬 웹 서버가 꺼져 있습니다 (.env의 PORT 확인)'
                }
                disabled={!webEditAvailable}
                onClick={handleOpenWebEditor}
              >
                <WebBrowserIcon />
              </button>
          )}
          <button
            type="button"
            className={cn(
              desktopModeIconBtnClass,
              softBlueIconBtnClass,
              eventsHidden && softBlueIconBtnActiveClass,
            )}
            aria-label={eventsHidden ? '일정 보이기' : '일정 숨기기'}
            aria-pressed={eventsHidden}
            title={
              !isLoggedIn
                ? '로그인 후 일정을 숨길 수 있습니다'
                : eventsHidden
                  ? '일정·날짜 배경 다시 보이기'
                  : '일정과 날짜 배경색을 모두 숨기기'
            }
            disabled={!isLoggedIn}
            onClick={(event) => {
              // Store-synced toggles only — never chrome-nav / UI-zone suspend (that
              // double-applied the setting and felt like needing two clicks).
              event.preventDefault();
              event.stopPropagation();
              onToggleEventsHidden?.();
            }}
          >
            <HideEventsEyeIcon open={!eventsHidden} />
          </button>
          <button
            type="button"
            className={cn(
              desktopModeIconBtnClass,
              softBlueIconBtnClass,
              completedHidden && softBlueIconBtnActiveClass,
            )}
            aria-label={completedHidden ? '완료 일정 보이기' : '완료 일정 숨기기'}
            aria-pressed={completedHidden}
            title={
              !isLoggedIn
                ? '로그인 후 완료 일정을 숨길 수 있습니다'
                : completedHidden
                  ? '완료된 일정 다시 보이기'
                  : '완료된 일정만 숨기기'
            }
            disabled={!isLoggedIn}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleCompletedHidden?.();
            }}
          >
            <HideCompletedCheckIcon checked={completedHidden} />
          </button>
          <button
            type="button"
            data-ui-action="export-excel"
            className={cn(desktopModeIconBtnClass, softBlueIconBtnClass)}
            aria-label="Excel로 내보내기"
            title="Excel로 내보내기"
            disabled={exporting}
            onClick={withUiSuspend('export-excel', onExportExcel)}
          >
            <ExcelIcon />
          </button>
          <button
            type="button"
            data-ui-action="export-pdf"
            className={cn(desktopModeIconBtnClass, softBlueIconBtnClass)}
            aria-label="PDF로 내보내기"
            title="PDF로 내보내기"
            disabled={exporting}
            onClick={withUiSuspend('export-pdf', onExportPdf)}
          >
            <PdfIcon />
          </button>
        </div>
      </div>
    </header>
  );
}
