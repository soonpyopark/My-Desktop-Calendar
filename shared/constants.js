/** Default HTTP/WebSocket server port. */
export const DEFAULT_PORT = 3010;

import { CALENDAR_COLOR_PALETTE } from './calendarColorPalette.js';

/** Application display version. */
export const APP_VERSION = '1.1.7';

/** Application display name. */
export const APP_NAME = 'My Desktop Calendar';

/** Marketing / info site URL. */
export const SITE_URL = 'https://note4all.tistory.com';

/** Window title and About dialog heading. */
export const APP_TITLE = `${APP_NAME} v${APP_VERSION}`;

/** Default data directory name under portable/build root. */
export const DEFAULT_DATA_DIR = 'data';

/** Default administrator credentials (override via `.env`). */
export const DEFAULT_ADMIN_ID = 'admin';
export const DEFAULT_ADMIN_PW = 'admin1234';

/** Default calendar colors (Google Calendar palette). */
export const CALENDAR_COLORS = [
  '#7986cb',
  '#33b679',
  '#8e24aa',
  '#e67c73',
  '#f6bf26',
  '#f4511e',
  '#039be5',
  '#616161',
  '#3f51b5',
  '#0b8043',
  '#d50000',
];

/** Built-in Korean public holiday calendar id. */
export const HOLIDAYS_KR_CALENDAR_ID = 'holidays-kr';

/** Built-in primary calendar id. */
export const PRIMARY_CALENDAR_ID = 'primary';

/** Default yellow for the built-in primary calendar. */
export const PRIMARY_CALENDAR_COLOR = '#f6bf26';

/** Built-in calendar definitions. */
export const DEFAULT_CALENDARS = [
  {
    id: PRIMARY_CALENDAR_ID,
    name: '기본 캘린더',
    color: PRIMARY_CALENDAR_COLOR,
    visible: true,
    owner: 'local',
  },
  { id: HOLIDAYS_KR_CALENDAR_ID, name: '대한민국의 휴일', color: '#d50000', visible: true, owner: 'shared' },
];

/** Built-in event tag catalog (seeded when store.tags is empty). */
export const DEFAULT_TAGS = [
  { id: 'tag-admin', name: '행정', color: '#039be5', sortOrder: 0 },
  { id: 'tag-work', name: '작업', color: '#ffe252', sortOrder: 1 },
  { id: 'tag-duty', name: '회의', color: '#8e24aa', sortOrder: 2 },
  { id: 'tag-trip', name: '출장', color: '#f4511e', sortOrder: 3 },
  { id: 'tag-personal', name: '개인', color: '#33b679', sortOrder: 4 },
];

/** Default user/settings profile. */
export const DEFAULT_NOTIFICATION_SETTINGS = {
  enabled: 'none',
  reminderTiming: '1min',
  playSound: true,
  onlyYesOrMaybe: false,
};

export const DEFAULT_VIEW_OPTIONS = {
  showWeekNumbers: true,
  weekStartsOnSunday: true,
  colorScheme: 'light',
  /**
   * Accent/theme color applied across buttons, highlights, and selections — any hex from
   * CALENDAR_COLOR_PALETTE (same palette as "새 캘린더 만들기"), independent of light/dark mode.
   */
  accentColor: CALENDAR_COLOR_PALETTE[0],
  runAtStartup: true,
  /** Hide event bars and day background colors (eye toolbar) — synced App ↔ web. */
  eventsHidden: false,
  /** Hide completed events only (checkbox toolbar) — synced App ↔ web. */
  completedHidden: false,
};

/** Default app window size as a ratio of the reference resolution (width and height). */
export const DEFAULT_APP_WINDOW_SIZE_RATIO = 0.8;

/** Reference resolution for default app window sizing (80% → 1536×864). */
export const DEFAULT_APP_WINDOW_BASE_WIDTH = 1920;
export const DEFAULT_APP_WINDOW_BASE_HEIGHT = 1080;

/**
 * WebView2 browser flags for localhost + embedded iframe calendar (Windows).
 * @see https://neutralino.js.org/docs/configuration/neutralino.config.json/
 * @see https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags
 */
export const WEBVIEW2_BROWSER_ARGS =
  '--allow-insecure-localhost --disable-web-security --disable-site-isolation-trials';

/** Allowed values for viewOptions.colorScheme */
export const COLOR_SCHEME_OPTIONS = ['light', 'dark', 'system'];

/** Korean holiday sync settings (API key stored in settings when rememberKey is true). */
export const DEFAULT_HOLIDAYS_KR_SETTINGS = {
  serviceKey: '',
  rememberKey: false,
  ok: null,
  skipped: false,
  reason: null,
  message: null,
  years: [],
  count: 0,
  lastSyncedAt: null,
};

export const DEFAULT_DESKTOP_WIDGET_BOUNDS = {
  x: 400,
  y: 60,
  width: 1480,
  height: 950,
};

export const DEFAULT_DESKTOP_WIDGET_MARGINS = {
  left: 0.2,
  top: 0.05,
  right: 0.05,
  bottom: 0.05,
};

/** WorkerW desktop widget defaults. Step 3: set launchMode or MYCALENDAR_DESKTOP_BACKGROUND=1 */
export const WIDGET_LAUNCH_MODE = {
  WINDOW: 'window',
  DESKTOP: 'desktop',
};

export const DEFAULT_WIDGET_SETTINGS = {
  launchMode: WIDGET_LAUNCH_MODE.DESKTOP,
  enabled: true,
  alwaysOnTop: false,
  /** @deprecated Window transparency removed; kept for settings.json compat. */
  opacity: 1,
  /** Unused — both modes use the in-app custom title bar (kept for settings compat). */
  chromeTopInset: 0,
  chromeLeftInset: 0,
  chromeRightInset: 0,
  chromeBottomInset: 0,
  bounds: { ...DEFAULT_DESKTOP_WIDGET_BOUNDS },
  margins: { ...DEFAULT_DESKTOP_WIDGET_MARGINS },
};

/**
 * @param {{ launchMode?: string, enabled?: boolean } | null | undefined} widget
 * @returns {'window' | 'desktop'}
 */
export function normalizeWidgetLaunchMode(widget) {
  if (widget?.launchMode === WIDGET_LAUNCH_MODE.DESKTOP) {
    return WIDGET_LAUNCH_MODE.DESKTOP;
  }
  if (widget?.launchMode === WIDGET_LAUNCH_MODE.WINDOW) {
    return WIDGET_LAUNCH_MODE.WINDOW;
  }
  return widget?.enabled === true ? WIDGET_LAUNCH_MODE.DESKTOP : WIDGET_LAUNCH_MODE.WINDOW;
}

export const DEFAULT_SETTINGS = {
  ownerName: '박순표',
  timezone: 'Asia/Seoul',
  timezoneLabel: '(GMT+09:00) 한국 표준시 - 서울',
  notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
  viewOptions: { ...DEFAULT_VIEW_OPTIONS },
  holidaysKr: { ...DEFAULT_HOLIDAYS_KR_SETTINGS },
  widget: { ...DEFAULT_WIDGET_SETTINGS },
  /** @type {Record<string, string>} YYYY-MM-DD → hex color */
  dayColors: {},
  /** @type {{ cidr: string, description?: string }[]} LAN HTTP allowlist (empty = allow all) */
  allowedIpCidrs: [],
};
