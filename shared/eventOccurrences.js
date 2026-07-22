/**
 * Expand stored events into display occurrences for a date range.
 * Series masters stay as single records; repeat is unfolded for UI/export only.
 *
 * Optional series fields:
 * - exdates: string[] YYYY-MM-DD excluded occurrence starts
 * - repeatUntil: string YYYY-MM-DD inclusive last allowed start
 * - repeatCount: number max occurrences from series start
 */

import {
  collectLunarMonthlyStarts,
  collectLunarYearlyStarts,
  solarDateKeyToLunar,
} from './lunarRecurrence.js';

/**
 * @param {string} dateKey YYYY-MM-DD
 */
export function parseDateKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * @param {Date} date
 */
export function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * @param {string} dateKey
 * @param {number} days
 */
export function addDaysToDateKey(dateKey, days) {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

/**
 * @param {object} event
 */
export function getEventDurationDays(event) {
  const start = parseDateKey(event.seriesStartDate ?? event.startDate);
  const end = parseDateKey(event.seriesEndDate ?? event.endDate ?? event.startDate);
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
}

/**
 * @param {string} dateKey
 * @param {number} dayOfMonth 1-31
 */
function clampDayOfMonth(dateKey, dayOfMonth) {
  const date = parseDateKey(dateKey);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(dayOfMonth, lastDay));
  return toDateKey(date);
}

/**
 * @param {object} event
 */
export function getRepeatMode(event) {
  const repeat = event?.repeat ?? 'none';
  return repeat || 'none';
}

/**
 * @param {object} event
 */
export function isRecurringEvent(event) {
  return getRepeatMode(event) !== 'none';
}

/**
 * @param {object} event
 */
export function getExdates(event) {
  return Array.isArray(event?.exdates)
    ? event.exdates.map(String).filter(Boolean)
    : [];
}

/**
 * @param {string} occurrenceStart
 * @param {number} durationDays
 * @param {string} rangeStart
 * @param {string} rangeEnd
 */
function overlapsRange(occurrenceStart, durationDays, rangeStart, rangeEnd) {
  const occurrenceEnd = addDaysToDateKey(occurrenceStart, durationDays - 1);
  return occurrenceStart <= rangeEnd && occurrenceEnd >= rangeStart;
}

/**
 * @param {object} event
 * @param {string} occurrenceStart
 */
function isAllowedOccurrenceStart(event, occurrenceStart) {
  if (getExdates(event).includes(occurrenceStart)) return false;
  if (event.repeatUntil && occurrenceStart > event.repeatUntil) return false;
  return true;
}

/**
 * @param {string} startKey
 * @param {string} endKey
 */
function diffDaysBetween(startKey, endKey) {
  return Math.round((parseDateKey(endKey).getTime() - parseDateKey(startKey).getTime()) / 86400000);
}

/**
 * Walk all occurrence starts from series start (honoring until/count/exdates).
 * Stops after `limitDate` (inclusive) or when count is reached.
 *
 * @param {object} event
 * @param {string} [limitDate]
 * @param {string | null} [rangeStartHint] Earliest occurrence start the caller actually
 *   needs (e.g. the visible week's start). Lets day-granularity walks (daily/weekly/
 *   weekdays) skip the leading stretch of an old, still-open-ended series instead of
 *   always re-walking from seriesStart — that walk is what turned "generate layout for
 *   ~209 weeks" into an O(weeks * daysSinceSeriesStart) blowup for long-running daily
 *   events, multi-second UI freezes on view-mode switches with real (years-old) data.
 *   Only safe when there's no repeatCount to tally (that count must stay exact from the
 *   true series start), so it's ignored whenever maxCount is set.
 * @returns {string[]}
 */
export function listAllOccurrenceStarts(event, limitDate = '9999-12-31', rangeStartHint = null) {
  const repeat = getRepeatMode(event);
  const seriesStart = event.seriesStartDate ?? event.startDate;
  if (!seriesStart) return [];

  if (repeat === 'none') {
    return isAllowedOccurrenceStart(event, seriesStart) ? [seriesStart] : [];
  }

  const hardLimit = event.repeatUntil && event.repeatUntil < limitDate
    ? event.repeatUntil
    : limitDate;
  const maxCount = Number.isFinite(Number(event.repeatCount)) && Number(event.repeatCount) > 0
    ? Math.floor(Number(event.repeatCount))
    : null;

  /** @type {string[]} */
  const starts = [];

  const pushIfAllowed = (candidate) => {
    if (candidate < seriesStart || candidate > hardLimit) return false;
    if (!isAllowedOccurrenceStart(event, candidate)) return true;
    starts.push(candidate);
    return maxCount == null || starts.length < maxCount;
  };

  // Earliest occurrence start that could still overlap rangeStartHint, accounting for
  // multi-day duration — never used when maxCount is set (see doc comment above).
  let earliestRelevant = null;
  if (maxCount == null && rangeStartHint) {
    const durationDays = getEventDurationDays(event);
    const candidate = addDaysToDateKey(rangeStartHint, -(durationDays - 1));
    if (candidate > seriesStart) {
      earliestRelevant = candidate;
    }
  }

  if (repeat === 'daily') {
    // Any day is a valid occurrence, so jumping straight to earliestRelevant is safe.
    let cursor = earliestRelevant ?? seriesStart;
    while (cursor <= hardLimit) {
      if (!pushIfAllowed(cursor)) break;
      cursor = addDaysToDateKey(cursor, 1);
    }
    return starts;
  }

  if (repeat === 'weekdays') {
    // Weekday-ness only depends on the candidate date itself, not phase vs seriesStart.
    let cursor = earliestRelevant ?? seriesStart;
    while (cursor <= hardLimit) {
      const day = parseDateKey(cursor).getDay();
      if (day >= 1 && day <= 5) {
        if (!pushIfAllowed(cursor)) break;
      }
      cursor = addDaysToDateKey(cursor, 1);
    }
    return starts;
  }

  if (repeat === 'weekly') {
    let cursor = seriesStart;
    if (earliestRelevant) {
      // Keep cursor on the same 7-day phase as seriesStart (floor, never overshoot).
      const weeksToSkip = Math.max(0, Math.floor(diffDaysBetween(seriesStart, earliestRelevant) / 7));
      cursor = addDaysToDateKey(seriesStart, weeksToSkip * 7);
    }
    while (cursor <= hardLimit) {
      if (isAllowedOccurrenceStart(event, cursor)) {
        starts.push(cursor);
        if (maxCount != null && starts.length >= maxCount) break;
      }
      cursor = addDaysToDateKey(cursor, 7);
    }
    return starts;
  }

  if (repeat === 'monthly') {
    const dayOfMonth = parseDateKey(seriesStart).getDate();
    let cursor = `${seriesStart.slice(0, 8)}01`;
    while (cursor.slice(0, 7) <= hardLimit.slice(0, 7)) {
      const occurrenceStart = clampDayOfMonth(cursor, dayOfMonth);
      if (occurrenceStart >= seriesStart && occurrenceStart <= hardLimit) {
        if (isAllowedOccurrenceStart(event, occurrenceStart)) {
          starts.push(occurrenceStart);
          if (maxCount != null && starts.length >= maxCount) break;
        }
      }
      const next = parseDateKey(cursor);
      next.setMonth(next.getMonth() + 1);
      cursor = toDateKey(next);
    }
    return starts;
  }

  if (repeat === 'yearly') {
    const start = parseDateKey(seriesStart);
    const month = start.getMonth();
    const dayOfMonth = start.getDate();
    let year = start.getFullYear();
    const endYear = parseDateKey(hardLimit).getFullYear();

    for (; year <= endYear; year += 1) {
      const lastDay = new Date(year, month + 1, 0).getDate();
      const occurrenceStart = toDateKey(new Date(year, month, Math.min(dayOfMonth, lastDay)));
      if (occurrenceStart < seriesStart || occurrenceStart > hardLimit) continue;
      if (!isAllowedOccurrenceStart(event, occurrenceStart)) continue;
      starts.push(occurrenceStart);
      if (maxCount != null && starts.length >= maxCount) break;
    }
    return starts;
  }

  if (repeat === 'lunar-yearly') {
    collectLunarYearlyStarts(
      solarDateKeyToLunar(seriesStart),
      seriesStart,
      hardLimit,
      pushIfAllowed,
    );
    return starts;
  }

  if (repeat === 'lunar-monthly') {
    collectLunarMonthlyStarts(
      solarDateKeyToLunar(seriesStart),
      seriesStart,
      hardLimit,
      pushIfAllowed,
    );
    return starts;
  }

  return isAllowedOccurrenceStart(event, seriesStart) ? [seriesStart] : [];
}

/**
 * @param {object} event
 * @param {string} occurrenceStart
 * @param {number} durationDays
 */
export function buildOccurrence(event, occurrenceStart, durationDays = getEventDurationDays(event)) {
  const occurrenceEnd = addDaysToDateKey(occurrenceStart, durationDays - 1);
  const seriesId = event.seriesId ?? event.id;
  const seriesStartDate = event.seriesStartDate ?? event.startDate;
  const seriesEndDate = event.seriesEndDate ?? event.endDate ?? event.startDate;
  const isOccurrence = isRecurringEvent(event);

  return {
    ...event,
    id: isOccurrence ? `${seriesId}::${occurrenceStart}` : seriesId,
    seriesId,
    seriesStartDate,
    seriesEndDate,
    startDate: occurrenceStart,
    endDate: occurrenceEnd,
    isOccurrence,
    occurrenceDate: occurrenceStart,
  };
}

/**
 * @param {object} event
 * @param {string} rangeStart
 * @param {string} rangeEnd
 * @returns {string[]}
 */
export function listOccurrenceStarts(event, rangeStart, rangeEnd) {
  const durationDays = getEventDurationDays(event);
  const walkLimit = addDaysToDateKey(rangeEnd, durationDays);
  return listAllOccurrenceStarts(event, walkLimit, rangeStart).filter((start) =>
    overlapsRange(start, durationDays, rangeStart, rangeEnd),
  );
}

/**
 * @param {object} event
 * @param {string} rangeStart
 * @param {string} rangeEnd
 */
export function expandEventForRange(event, rangeStart, rangeEnd) {
  if (!event?.startDate) return [];
  if (event.isOccurrence) {
    return event.startDate <= rangeEnd && event.endDate >= rangeStart ? [event] : [];
  }
  const durationDays = getEventDurationDays(event);
  return listOccurrenceStarts(event, rangeStart, rangeEnd).map((start) =>
    buildOccurrence(event, start, durationDays),
  );
}

/**
 * @param {object[]} events
 * @param {string} rangeStart YYYY-MM-DD
 * @param {string} rangeEnd YYYY-MM-DD
 */
export function expandEventsForRange(events, rangeStart, rangeEnd) {
  if (!Array.isArray(events) || !rangeStart || !rangeEnd) return [];
  /** @type {object[]} */
  const expanded = [];
  for (const event of events) {
    expanded.push(...expandEventForRange(event, rangeStart, rangeEnd));
  }
  return expanded;
}

/**
 * @param {object} event display occurrence or master
 */
export function getSeriesId(event) {
  if (!event) return null;
  if (event.seriesId) return event.seriesId;
  if (typeof event.id === 'string' && event.id.includes('::')) {
    return event.id.split('::')[0];
  }
  return event.id;
}

/**
 * @param {object} event
 * @param {string | null | undefined} fallbackDayKey
 */
export function getOccurrenceDate(event, fallbackDayKey = null) {
  if (event?.occurrenceDate) return event.occurrenceDate;
  if (typeof event?.id === 'string' && event.id.includes('::')) {
    return event.id.split('::')[1];
  }
  return fallbackDayKey ?? event?.startDate ?? null;
}

/**
 * @param {object} master
 * @param {string} occurrenceDate
 */
export function addExdate(master, occurrenceDate) {
  const exdates = new Set(getExdates(master));
  exdates.add(occurrenceDate);
  return {
    ...master,
    exdates: [...exdates].sort(),
  };
}

/**
 * Truncate series so occurrences on/after `fromDate` are removed.
 * @param {object} master
 * @param {string} fromDate
 */
export function truncateSeriesBefore(master, fromDate) {
  const until = addDaysToDateKey(fromDate, -1);
  if (until < (master.startDate ?? until)) {
    return { ...master, repeat: 'none', repeatUntil: null, repeatCount: null };
  }
  return {
    ...master,
    repeatUntil: master.repeatUntil && master.repeatUntil < until ? master.repeatUntil : until,
    repeatCount: null,
  };
}

/**
 * Build a standalone event payload from an edited occurrence ("this event only").
 * @param {object} master
 * @param {object} patch
 * @param {string} occurrenceDate
 */
export function buildSingleExceptionEvent(master, patch, occurrenceDate) {
  const durationDays = getEventDurationDays({
    startDate: patch.startDate ?? occurrenceDate,
    endDate: patch.endDate ?? patch.startDate ?? occurrenceDate,
  });
  const startDate = patch.startDate ?? occurrenceDate;
  return {
    calendarId: patch.calendarId ?? master.calendarId,
    title: patch.title ?? master.title,
    description: patch.description ?? master.description ?? '',
    location: patch.location ?? master.location ?? '',
    startDate,
    endDate: patch.endDate ?? addDaysToDateKey(startDate, durationDays - 1),
    allDay: patch.allDay ?? master.allDay,
    startTime: patch.startTime ?? master.startTime,
    endTime: patch.endTime ?? master.endTime,
    repeat: 'none',
    repeatUntil: null,
    repeatCount: null,
    exdates: [],
    color: patch.color ?? master.color ?? null,
    guests: Array.isArray(patch.guests) ? patch.guests : (master.guests ?? []),
    completed: Boolean(patch.completed ?? master.completed),
    markerShape: patch.markerShape ?? master.markerShape ?? null,
    links: Array.isArray(patch.links)
      ? patch.links
      : (Array.isArray(master.links) ? master.links : undefined),
    link: patch.link ?? master.link ?? '',
    sortOrder: patch.sortOrder ?? master.sortOrder ?? null,
    sortOrderByDay: patch.sortOrderByDay ?? master.sortOrderByDay ?? undefined,
  };
}

/**
 * Build a new series starting at occurrence ("this and following").
 * @param {object} master
 * @param {object} patch
 * @param {string} occurrenceDate
 */
export function buildFollowingSeriesEvent(master, patch, occurrenceDate) {
  const startDate = patch.startDate ?? occurrenceDate;
  const endDate = patch.endDate ?? startDate;
  return {
    calendarId: patch.calendarId ?? master.calendarId,
    title: patch.title ?? master.title,
    description: patch.description ?? master.description ?? '',
    location: patch.location ?? master.location ?? '',
    startDate,
    endDate,
    allDay: patch.allDay ?? master.allDay,
    startTime: patch.startTime ?? master.startTime,
    endTime: patch.endTime ?? master.endTime,
    repeat: patch.repeat ?? master.repeat ?? 'none',
    repeatUntil: patch.repeatUntil ?? null,
    repeatCount: patch.repeatCount ?? null,
    exdates: [],
    color: patch.color ?? master.color ?? null,
    guests: Array.isArray(patch.guests) ? patch.guests : (master.guests ?? []),
    completed: Boolean(patch.completed ?? master.completed),
    markerShape: patch.markerShape ?? master.markerShape ?? null,
    links: Array.isArray(patch.links)
      ? patch.links
      : (Array.isArray(master.links) ? master.links : undefined),
    link: patch.link ?? master.link ?? '',
    sortOrder: patch.sortOrder ?? master.sortOrder ?? null,
    sortOrderByDay: patch.sortOrderByDay ?? master.sortOrderByDay ?? undefined,
  };
}
