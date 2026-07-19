import {
  formatTime24,
  isTimedEvent,
  isMultiDayEvent,
  getEventDayIndex,
  formatEventBarLabelForDay,
  formatExportEventLineText,
  compareEventsForDisplay,
  compareEventsForDayDisplay,
  sortEventsForDisplay,
  sortEventsForDayDisplay,
  isEventContinuingOnDay,
} from '../../shared/eventBarFormat.js';

export {
  formatTime24,
  isTimedEvent,
  isMultiDayEvent,
  getEventDayIndex,
  formatEventBarLabelForDay,
  formatExportEventLineText,
  compareEventsForDisplay,
  compareEventsForDayDisplay,
  sortEventsForDisplay,
  sortEventsForDayDisplay,
  isEventContinuingOnDay,
};

import { eventOnDay, parseDateKey } from './calendarUtils.js';

const WEEKDAY_NAMES = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

const REPEAT_LABELS = {
  none: null,
  daily: '매일',
  weekly: '매주',
  monthly: '매월',
  yearly: '매년',
  'lunar-monthly': '음력 매월',
  'lunar-yearly': '음력 매년',
  weekdays: '주중(월~금)',
};

/**
 * @param {Date} date
 */
function formatShortDate(date) {
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

/**
 * @param {object} event
 * @param {boolean} showOnDay
 */
/**
 * Quick-edit list label (plain title; tag icons render separately).
 * @param {object} event
 * @param {boolean} showOnDay
 * @param {object[]} [_tags]
 */
export function formatEventBarLabel(event, showOnDay, _tags) {
  if (!showOnDay) return null;

  const title = event.title ?? '';
  if (!isTimedEvent(event)) {
    return { time: null, title };
  }

  return {
    time: formatTime24(event.startTime),
    title,
  };
}

/**
 * @param {object} event
 * @param {string} [dayKey]
 */
export function formatEventPopoverSchedule(event, dayKey) {
  const refKey = dayKey && eventOnDay(event, dayKey) ? dayKey : event.startDate;
  const date = parseDateKey(refKey);
  const datePart = `${date.getMonth() + 1}월 ${date.getDate()}일 (${WEEKDAY_NAMES[date.getDay()]})`;

  if (event.startDate !== event.endDate) {
    const start = parseDateKey(event.startDate);
    const end = parseDateKey(event.endDate);

    if (isTimedEvent(event)) {
      return `${formatShortDate(start)} ${formatTime24(event.startTime)} ~ ${formatShortDate(end)} ${formatTime24(event.endTime)}`;
    }

    const rangePart =
      start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()
        ? `${formatShortDate(start)}~${end.getDate()}일`
        : `${formatShortDate(start)}~${formatShortDate(end)}`;

    return `${rangePart} · 종일`;
  }

  if (isTimedEvent(event)) {
    return `${datePart} · ${formatTime24(event.startTime)}~${formatTime24(event.endTime)}`;
  }

  return `${datePart} · 종일`;
}

/**
 * @param {object | null | undefined} event
 */
export function formatRepeatLabel(event) {
  if (!event) return null;
  const repeat = typeof event === 'string' ? event : (event.repeat ?? 'none');
  if (!repeat || repeat === 'none') return null;
  const base = REPEAT_LABELS[repeat];
  if (!base) return null;

  if (typeof event === 'string') return base;

  if (event.repeatUntil) {
    const [y, m, d] = String(event.repeatUntil).split('-');
    return `${base} · ${Number(y)}년 ${Number(m)}월 ${Number(d)}일까지`;
  }
  if (event.repeatCount) {
    return `${base} · ${event.repeatCount}회`;
  }
  return base;
}
