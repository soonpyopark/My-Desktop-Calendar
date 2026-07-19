/** Fixed event lane sizing — row height only changes visible count, not bar height. */
export const EVENT_LAYOUT = {
  laneHeight: 18,
  laneGap: 2,
  dayEventGap: 6,
  moreOffset: 4,
  cellPaddingY: 8,
  dayNumberHeight: 28,
};

export function getEventLaneStep() {
  return EVENT_LAYOUT.laneHeight + EVENT_LAYOUT.laneGap;
}

/**
 * @param {number} rowHeight
 */
export function getEventRowCapacity(rowHeight) {
  if (rowHeight <= 0) return { maxAll: 0, maxWithMore: 0 };

  const {
    cellPaddingY,
    dayNumberHeight,
    dayEventGap,
    moreOffset,
    laneHeight,
  } = EVENT_LAYOUT;
  const laneStep = getEventLaneStep();

  const available = rowHeight - cellPaddingY - dayNumberHeight - dayEventGap;
  if (available <= 0) return { maxAll: 0, maxWithMore: 0 };

  const maxAll = Math.max(0, Math.floor(available / laneStep));
  const moreTail = moreOffset + laneHeight;
  const maxWithMore = Math.max(0, Math.min(maxAll - 1, Math.floor((available - moreTail) / laneStep)));

  return { maxAll, maxWithMore };
}

/**
 * @returns {Record<string, string>}
 */
export function getEventLayoutCssVars() {
  const { laneHeight, dayEventGap, moreOffset } = EVENT_LAYOUT;
  return {
    '--event-lane-height': `${laneHeight}px`,
    '--event-lane-step': `${getEventLaneStep()}px`,
    '--day-event-gap': `${dayEventGap}px`,
    '--event-more-offset': `${moreOffset}px`,
  };
}

/**
 * @param {{ event: object, lane: number }[]} daySegments
 * @param {{ maxAll: number, maxWithMore: number }} capacity
 */
export function resolveDayVisibleEventLimit(daySegments, capacity) {
  const sortedSegments = [...daySegments].sort((a, b) => a.lane - b.lane);
  const eventCount = sortedSegments.length;

  if (eventCount <= capacity.maxAll) {
    return {
      visibleCount: eventCount,
      hiddenEventCount: 0,
    };
  }

  const visibleCount = Math.max(1, capacity.maxWithMore);
  return {
    visibleCount,
    hiddenEventCount: eventCount - visibleCount,
  };
}
