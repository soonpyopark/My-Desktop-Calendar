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

/**
 * Default calendar for a brand-new event: whichever editable calendar currently sits at the
 * TOP of the user's own "내 캘린더" drag-and-drop order (see {@link sortCalendarsByOrder}) — not
 * just the first entry in the raw store array. Prefers a visible calendar at/after the top of
 * the order (picking a hidden one by default would create events the user can't immediately see).
 * @param {object[]} calendars
 * @param {string} excludeId calendar id to exclude (e.g. the read-only Korean holidays calendar)
 * @param {string} fallbackId used when no editable calendar exists at all
 */
export function getDefaultCalendarId(calendars, excludeId, fallbackId = 'primary') {
  const ordered = sortCalendarsByOrder(
    (calendars ?? []).filter((calendar) => calendar.id !== excludeId),
  );
  if (!ordered.length) return fallbackId;
  return ordered.find((calendar) => calendar.visible !== false)?.id ?? ordered[0].id;
}
