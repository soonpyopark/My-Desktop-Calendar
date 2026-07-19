import { eventOnDay, parseDateKey } from './calendarUtils.js';
import { formatTime24, sortEventsForDisplay } from './eventFormat.js';
import { isCalendarPublished } from './calendarVisibility.js';

const WEEKDAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * @param {number} year
 * @param {number} month 1-12
 */
export function getMonthDateRange(year, month) {
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { monthStart, monthEnd };
}

/**
 * @param {object} event
 * @param {number} year
 * @param {number} month 1-12
 */
export function eventOverlapsMonth(event, year, month) {
  const { monthStart, monthEnd } = getMonthDateRange(year, month);
  return event.startDate <= monthEnd && event.endDate >= monthStart;
}

/**
 * @param {object} event
 * @param {number} year
 */
export function eventOverlapsYear(event, year) {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  return event.startDate <= yearEnd && event.endDate >= yearStart;
}

/**
 * @param {object[]} events
 * @param {{ viewMode: 'month' | 'year', viewDate: Date, calendars: object[] }} options
 */
export function getEventsForExport(events, { viewDate, calendars }) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth() + 1;
  const calendarMap = new Map(calendars.map((c) => [c.id, c]));

  const filtered = sortEventsForDisplay(
    events.filter((event) => {
      const cal = calendarMap.get(event.calendarId);
      if (!isCalendarPublished(cal)) return false;
      return eventOverlapsMonth(event, year, month);
    }),
  );

  return filtered.map((event) => {
    const calendar = calendarMap.get(event.calendarId);
    const start = parseDateKey(event.startDate);
    const end = parseDateKey(event.endDate);
    const dateLabel = event.startDate === event.endDate
      ? formatDateLabel(start)
      : `${formatDateLabel(start)} ~ ${formatDateLabel(end)}`;
    const timeLabel = event.allDay === false && event.startTime
      ? `${formatTime24(event.startTime)}${event.endTime ? ` ~ ${formatTime24(event.endTime)}` : ''}`
      : '종일';

    return {
      id: event.id,
      dateLabel,
      weekday: WEEKDAY_NAMES[start.getDay()],
      timeLabel,
      title: event.title ?? '',
      calendarName: calendar?.name ?? '',
      description: event.description ?? '',
      startDate: event.startDate,
      endDate: event.endDate,
    };
  });
}

/**
 * @param {object[]} dayEvents events for a single day
 * @param {string} dayKey
 * @param {{ viewMode: 'month' | 'year', viewDate: Date, calendars: object[] }} options
 */
export function getEventsForDayExport(dayEvents, dayKey, options) {
  return getEventsForExport(dayEvents, options).filter((row) => {
    return dayEvents.some((event) => event.id === row.id && eventOnDay(event, dayKey));
  });
}

function formatDateLabel(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * @param {{ viewMode: 'month' | 'year', viewDate: Date }} options
 */
export function getExportPeriodLabel({ viewDate }) {
  const year = viewDate.getFullYear();
  return `${year}년 ${viewDate.getMonth() + 1}월`;
}

/**
 * @param {Date} [date]
 */
export function getJsonExportTimestamp(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yy}${mm}${dd}-${hh}${mi}${ss}`;
}

/**
 * @param {{ viewDate: Date }} options
 */
export function getExportFileBaseName({ viewDate }) {
  const year = viewDate.getFullYear();
  const month = String(viewDate.getMonth() + 1).padStart(2, '0');
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  return `calendar_${year}${month}_${stamp}`;
}
