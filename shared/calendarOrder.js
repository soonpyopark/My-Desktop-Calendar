/**
 * Sort calendars by their user-configured `sortOrder` (set via drag-and-drop reordering in
 * calendar settings). Calendars without a `sortOrder` yet fall back to their current array
 * position, so introducing the field never reshuffles a list that hasn't been reordered.
 * @param {object[]} calendars
 */
export function sortCalendarsByOrder(calendars) {
  return (calendars ?? [])
    .map((calendar, index) => ({ calendar, index }))
    .sort((a, b) => {
      const ao = typeof a.calendar.sortOrder === 'number' ? a.calendar.sortOrder : a.index;
      const bo = typeof b.calendar.sortOrder === 'number' ? b.calendar.sortOrder : b.index;
      if (ao !== bo) return ao - bo;
      return a.index - b.index;
    })
    .map(({ calendar }) => calendar);
}
