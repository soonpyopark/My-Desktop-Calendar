/**
 * Shared event bar label / sort helpers for month view and exports.
 */
import { HOLIDAYS_KR_CALENDAR_ID } from './constants.js';
import { formatTaggedEventTitle } from './eventTags.js';

// Bar/list labels use plain titles + EventTagIcons in the UI.
// Export / detail may still use formatTaggedEventTitle for text context.

/**
 * @param {string | null | undefined} time
 */
export function formatTime24(time) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * @param {object} event
 */
export function isTimedEvent(event) {
  return event.allDay === false && Boolean(event.startTime);
}

/**
 * @param {object} event
 */
export function isMultiDayEvent(event) {
  return event.startDate !== event.endDate;
}

/**
 * @param {string} key
 */
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * @param {object} event
 * @param {string} dayKey
 */
export function getEventDayIndex(event, dayKey) {
  const start = parseDateKey(event.startDate);
  const current = parseDateKey(dayKey);
  const diffMs = current.getTime() - start.getTime();
  return Math.round(diffMs / 86400000) + 1;
}

/**
 * @param {object} event
 */
export function getEventDurationDays(event) {
  const start = new Date(`${event.startDate}T00:00:00`);
  const end = new Date(`${event.endDate}T00:00:00`);
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

/**
 * Day counter for multi-day bars, e.g. `1/3` (current day / span length).
 * @param {object} event
 * @param {string} dayKey
 */
export function getEventDayIndexLabel(event, dayKey) {
  const current = getEventDayIndex(event, dayKey);
  const total = getEventDurationDays(event);
  return `${current}/${total}`;
}

/**
 * @param {object} event
 * @param {string} dayKey
 */
export function isEventContinuingOnDay(event, dayKey) {
  return dayKey > event.startDate && dayKey <= event.endDate;
}

/**
 * Global manual display order (legacy / fallback).
 * @param {object} event
 * @returns {number | null}
 */
export function getEventSortOrder(event) {
  const value = event?.sortOrder;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Per-day order from date-cell DnD. Falls back to global sortOrder when unset for that day.
 * @param {object} event
 * @param {string} [dayKey]
 * @returns {number | null}
 */
export function getEventSortOrderForDay(event, dayKey) {
  if (dayKey && event?.sortOrderByDay && typeof event.sortOrderByDay === 'object') {
    const value = event.sortOrderByDay[dayKey];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return getEventSortOrder(event);
}

/**
 * @param {object} event
 * @param {string} dayKey
 * @param {number} sortOrder
 * @returns {Record<string, number>}
 */
export function mergeSortOrderByDay(event, dayKey, sortOrder) {
  const prev = event?.sortOrderByDay && typeof event.sortOrderByDay === 'object'
    ? { ...event.sortOrderByDay }
    : {};
  prev[dayKey] = sortOrder;
  return prev;
}

/**
 * @param {object} a
 * @param {object} b
 * @param {string} [dayKey]
 * @returns {number | null} null when neither side has a manual order
 */
function compareBySortOrder(a, b, dayKey) {
  const orderA = dayKey ? getEventSortOrderForDay(a, dayKey) : getEventSortOrder(a);
  const orderB = dayKey ? getEventSortOrderForDay(b, dayKey) : getEventSortOrder(b);
  if (orderA == null && orderB == null) return null;
  if (orderA == null) return 1;
  if (orderB == null) return -1;
  if (orderA !== orderB) return orderA - orderB;
  return 0;
}

/**
 * Google Calendar-style month/day ordering:
 * Korean holidays first, then manual sortOrder, then all-day & multi-day, then timed.
 *
 * @param {object} a
 * @param {object} b
 */
export function compareEventsForDisplay(a, b) {
  const holidayA = a.calendarId === HOLIDAYS_KR_CALENDAR_ID;
  const holidayB = b.calendarId === HOLIDAYS_KR_CALENDAR_ID;
  if (holidayA !== holidayB) return holidayA ? -1 : 1;

  const byOrder = compareBySortOrder(a, b);
  if (byOrder != null && byOrder !== 0) return byOrder;

  const timedA = isTimedEvent(a);
  const timedB = isTimedEvent(b);
  // All-day / untimed above timed (Google month view)
  if (timedA !== timedB) return timedA ? 1 : -1;

  if (timedA && timedB) {
    const timeCmp = String(a.startTime).localeCompare(String(b.startTime));
    if (timeCmp !== 0) return timeCmp;
  }

  const byStart = a.startDate.localeCompare(b.startDate);
  if (byStart !== 0) return byStart;

  const durationDiff = getEventDurationDays(b) - getEventDurationDays(a);
  if (durationDiff !== 0) return durationDiff;

  return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'ko');
}

/**
 * @param {object[]} events
 */
export function sortEventsForDisplay(events) {
  return [...events].sort(compareEventsForDisplay);
}

/**
 * @param {object} a
 * @param {object} b
 * @param {string} dayKey
 */
export function compareEventsForDayDisplay(a, b, dayKey) {
  const holidayA = a.calendarId === HOLIDAYS_KR_CALENDAR_ID;
  const holidayB = b.calendarId === HOLIDAYS_KR_CALENDAR_ID;
  if (holidayA !== holidayB) return holidayA ? -1 : 1;

  // Per-day DnD order (sortOrderByDay) — independent across date cells.
  const byOrder = compareBySortOrder(a, b, dayKey);
  if (byOrder != null && byOrder !== 0) return byOrder;

  const continuingA = isEventContinuingOnDay(a, dayKey);
  const continuingB = isEventContinuingOnDay(b, dayKey);
  if (continuingA !== continuingB) return continuingA ? -1 : 1;

  return compareEventsForDisplay(a, b);
}

/**
 * @param {object[]} events
 * @param {string} dayKey
 */
export function sortEventsForDayDisplay(events, dayKey) {
  return [...events].sort((a, b) => compareEventsForDayDisplay(a, b, dayKey));
}

/**
 * @param {object} event
 * @param {string} dayKey
 * @param {object[]} [tags] unused for bar title (icons render separately); kept for call-site compat
 */
export function formatEventBarLabelForDay(event, dayKey, _tags) {
  const title = event.title ?? '';
  const showTime = isTimedEvent(event) && dayKey === event.startDate;

  if (!isMultiDayEvent(event)) {
    if (!isTimedEvent(event)) {
      return { time: null, dayIndex: null, title };
    }
    return {
      time: formatTime24(event.startTime),
      dayIndex: null,
      title,
    };
  }

  const dayIndex = getEventDayIndexLabel(event, dayKey);
  return {
    time: showTime ? formatTime24(event.startTime) : null,
    dayIndex,
    title,
  };
}

/**
 * @param {object} event
 * @param {string} dayKey
 * @param {object[]} [tags]
 */
export function formatExportEventLineText(event, dayKey, tags) {
  const label = formatEventBarLabelForDay(event, dayKey);
  const parts = [];

  if (label.time) parts.push(label.time);
  if (label.dayIndex != null) parts.push(`(${label.dayIndex})`);
  parts.push(formatTaggedEventTitle(event, tags));

  return parts.join(' ');
}
