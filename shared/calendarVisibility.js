/**
 * @param {object | undefined | null} calendar
 */
export function isCalendarPublished(calendar) {
  return calendar?.visible !== false;
}

/**
 * @param {object[]} calendars
 * @param {boolean} [asAdmin=false]
 */
export function filterCalendarsForViewer(calendars, asAdmin = false) {
  if (asAdmin) return calendars;
  return calendars.filter(isCalendarPublished);
}

/**
 * @param {object[]} events
 * @param {object[]} calendars
 * @param {boolean} [asAdmin=false]
 */
export function filterEventsForViewer(events, calendars, asAdmin = false) {
  if (asAdmin) return events;
  const publishedIds = new Set(
    filterCalendarsForViewer(calendars, false).map((calendar) => calendar.id),
  );
  return events.filter((event) => publishedIds.has(event.calendarId));
}

/**
 * @param {object | undefined | null} event
 * @param {object[]} calendars
 * @param {boolean} [asAdmin=false]
 */
export function isEventVisibleToViewer(event, calendars, asAdmin = false) {
  if (!event) return false;
  if (asAdmin) return true;
  const calendar = calendars.find((item) => item.id === event.calendarId);
  return isCalendarPublished(calendar);
}

/**
 * @param {object | null | undefined} store
 * @param {boolean} [asAdmin=false]
 */
export function filterStoreForViewer(store, asAdmin = false) {
  if (!store || asAdmin) return store;
  const holidaysKr = store.settings?.holidaysKr
    ? {
        ...store.settings.holidaysKr,
        serviceKey: '',
      }
    : store.settings?.holidaysKr;
  return {
    ...store,
    settings: store.settings
      ? {
          ...store.settings,
          holidaysKr,
        }
      : store.settings,
    events: filterEventsForViewer(store.events ?? [], store.calendars ?? [], false),
  };
}
