import { expandEventsForRange } from '../../shared/eventOccurrences.js';
import { compareEventsForDisplay } from '../../shared/eventBarFormat.js';
import { resolveEventTags } from '../../shared/eventTags.js';
import { toDateKey } from './calendarUtils.js';

/**
 * @param {Date} [now]
 * @returns {{ start: string, end: string }}
 */
export function getDefaultSearchRange(now = new Date()) {
  const year = now.getFullYear();
  return {
    start: `${year - 1}-01-01`,
    end: `${year + 1}-12-31`,
  };
}

/**
 * @param {string} query
 * @param {object} event
 * @param {object | undefined} calendar
 * @param {object[]} [tags]
 */
function matchesQuery(query, event, calendar, tags) {
  const tagNames = resolveEventTags(event, tags).map((tag) => tag.name);
  const haystack = [
    event.title,
    event.description,
    event.location,
    calendar?.name,
    ...tagNames,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

/**
 * Search visible calendar events (expanded occurrences) by
 * title/description/location/calendar/tag name.
 *
 * @param {{
 *   query: string,
 *   events: object[],
 *   calendars: object[],
 *   tags?: object[],
 *   rangeStart?: string,
 *   rangeEnd?: string,
 *   limit?: number,
 * }} options
 */
export function searchCalendarEvents({
  query,
  events,
  calendars,
  tags = [],
  rangeStart,
  rangeEnd,
  limit = 50,
}) {
  const normalized = String(query ?? '').trim().toLowerCase();
  if (!normalized) return [];

  const range = rangeStart && rangeEnd
    ? { start: rangeStart, end: rangeEnd }
    : getDefaultSearchRange();

  const calendarById = new Map((calendars ?? []).map((calendar) => [calendar.id, calendar]));
  const expanded = expandEventsForRange(events ?? [], range.start, range.end);

  return expanded
    .filter((event) => matchesQuery(normalized, event, calendarById.get(event.calendarId), tags))
    .sort(compareEventsForDisplay)
    .slice(0, limit);
}

/**
 * @param {string} dateKey
 */
export function formatSearchResultDate(dateKey) {
  if (!dateKey) return '';
  const [y, m, d] = String(dateKey).split('-').map(Number);
  if (!y || !m || !d) return dateKey;
  const date = new Date(y, m - 1, d);
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  return `${y}년 ${m}월 ${d}일 (${weekdays[date.getDay()]})`;
}

/**
 * @param {string} dateKey
 */
export function dateFromDateKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export { toDateKey };
