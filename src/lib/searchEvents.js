import { expandEventsForRange } from '../../shared/eventOccurrences.js';
import { compareEventsForDisplay } from '../../shared/eventBarFormat.js';
import { getEventLinks } from '../../shared/eventLinks.js';
import { resolveEventTags } from '../../shared/eventTags.js';
import { toDateKey } from './calendarUtils.js';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Default search window: today − 1 year … today + 1 year.
 * @param {Date} [now]
 * @returns {{ start: string, end: string }}
 */
export function getDefaultSearchRange(now = new Date()) {
  const start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
  return {
    start: toDateKey(start),
    end: toDateKey(end),
  };
}

/**
 * @param {string | undefined} start
 * @param {string | undefined} end
 * @returns {{ start: string, end: string }}
 */
export function normalizeSearchRange(start, end) {
  const defaults = getDefaultSearchRange();
  let from = DATE_KEY_RE.test(String(start ?? '')) ? String(start) : defaults.start;
  let to = DATE_KEY_RE.test(String(end ?? '')) ? String(end) : defaults.end;
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  return { start: from, end: to };
}

/**
 * @param {object} event
 * @returns {string[]}
 */
function collectLinkSearchParts(event) {
  const parts = [];
  for (const link of getEventLinks(event)) {
    if (link.title) parts.push(link.title);
    if (link.url) parts.push(link.url);
  }
  return parts;
}

/**
 * @param {object} event
 * @returns {string[]}
 */
function collectAttachmentSearchParts(event) {
  if (!Array.isArray(event?.attachments)) return [];
  return event.attachments
    .map((item) => item?.name || item?.fileName || item?.path || '')
    .filter(Boolean);
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
    ...collectLinkSearchParts(event),
    ...collectAttachmentSearchParts(event),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

/**
 * Search visible calendar events (expanded occurrences) by
 * title/description/location/calendar/tag name/link/attachment name.
 * Returns the full match list — callers page/slice as needed.
 *
 * @param {{
 *   query: string,
 *   events: object[],
 *   calendars: object[],
 *   tags?: object[],
 *   rangeStart?: string,
 *   rangeEnd?: string,
 * }} options
 * @returns {object[]}
 */
export function searchCalendarEvents({
  query,
  events,
  calendars,
  tags = [],
  rangeStart,
  rangeEnd,
}) {
  const normalized = String(query ?? '').trim().toLowerCase();
  if (!normalized) return [];

  const range = normalizeSearchRange(rangeStart, rangeEnd);
  const calendarById = new Map((calendars ?? []).map((calendar) => [calendar.id, calendar]));
  const expanded = expandEventsForRange(events ?? [], range.start, range.end);

  return expanded
    .filter((event) => matchesQuery(normalized, event, calendarById.get(event.calendarId), tags))
    .sort(compareEventsForDisplay);
}

/**
 * Build page number tokens for a compact pager: numbers and `'ellipsis'`.
 * @param {number} page 1-based
 * @param {number} totalPages
 * @returns {Array<number | 'ellipsis'>}
 */
export function buildSearchPageItems(page, totalPages) {
  const total = Math.max(1, Number(totalPages) || 1);
  const current = Math.min(Math.max(1, Number(page) || 1), total);
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  /** @type {Array<number | 'ellipsis'>} */
  const items = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  if (start > 2) items.push('ellipsis');
  for (let n = start; n <= end; n += 1) items.push(n);
  if (end < total - 1) items.push('ellipsis');
  items.push(total);
  return items;
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

export const SEARCH_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
