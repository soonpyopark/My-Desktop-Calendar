import { formatEventBarLabelForDay, compareEventsForDisplay } from './eventBarFormat.js';
import { expandEventsForRange } from './eventOccurrences.js';

/**
 * @param {Date} date
 */
function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * @param {object} event
 * @param {string} dayKey
 */
function eventOnDay(event, dayKey) {
  return dayKey >= event.startDate && dayKey <= event.endDate;
}

/**
 * @param {object} event
 * @param {string} dayKey
 */
function getEventSegmentType(event, dayKey) {
  if (!eventOnDay(event, dayKey)) return null;
  const isStart = dayKey === event.startDate;
  const isEnd = dayKey === event.endDate;
  if (isStart && isEnd) return 'single';
  if (isStart) return 'start';
  if (isEnd) return 'end';
  return 'middle';
}

/**
 * @param {{ date: Date }[]} week
 * @param {object[]} events
 */
/**
 * @param {{ date: Date }[]} week
 * @param {object[]} events
 * @param {object[]} [tags]
 */
export function buildWeekEventLayout(week, events, tags) {
  const dayKeys = week.map(({ date }) => toDateKey(date));
  const rangeStart = dayKeys[0];
  const rangeEnd = dayKeys[dayKeys.length - 1];

  const weekEvents = expandEventsForRange(events, rangeStart, rangeEnd)
    .sort(compareEventsForDisplay);

  /** @type {Map<string, Set<number>>} */
  const occupiedByDay = new Map(dayKeys.map((dayKey) => [dayKey, new Set()]));
  /** @type {Map<string, number>} */
  const laneByEventId = new Map();

  for (const event of weekEvents) {
    const daysInWeek = dayKeys.filter((dayKey) => eventOnDay(event, dayKey));
    let lane = 0;

    while (daysInWeek.some((dayKey) => occupiedByDay.get(dayKey)?.has(lane))) {
      lane += 1;
    }

    laneByEventId.set(event.id, lane);
    for (const dayKey of daysInWeek) {
      occupiedByDay.get(dayKey)?.add(lane);
    }
  }

  /** @type {Record<string, object[]>} */
  const layoutByDay = Object.fromEntries(dayKeys.map((dayKey) => [dayKey, []]));

  for (const event of weekEvents) {
    const lane = laneByEventId.get(event.id) ?? 0;

    for (const dayKey of dayKeys) {
      if (!eventOnDay(event, dayKey)) continue;

      const segment = getEventSegmentType(event, dayKey);
      if (!segment) continue;

      layoutByDay[dayKey].push({
        event,
        segment,
        lane,
        label: formatEventBarLabelForDay(event, dayKey, tags),
        continuation: segment === 'middle' || segment === 'end',
      });
    }
  }

  for (const dayKey of dayKeys) {
    layoutByDay[dayKey].sort((a, b) => a.lane - b.lane);
  }

  return layoutByDay;
}

/**
 * @param {{ event: object, lane: number }[]} segments
 * @param {number} maxVisible
 */
export function countHiddenWeekEvents(segments, maxVisible) {
  return new Set(
    segments.filter((segment) => segment.lane >= maxVisible).map((segment) => segment.event.id),
  ).size;
}
