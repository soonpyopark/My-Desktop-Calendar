/**
 * Membership / personal-calendar helpers (mirrors server FilterStore rules).
 */

import { HOLIDAYS_KR_CALENDAR_ID } from './constants.js';

/**
 * @param {{ role?: string, isSuperAdmin?: boolean, loginId?: string } | null | undefined} auth
 */
export function isSuperAdminUser(auth) {
  if (!auth) return false;
  if (auth.isSuperAdmin === true) return true;
  return auth.role === 'super_admin';
}

/**
 * @param {object | null | undefined} calendar
 * @param {string | null | undefined} loginId
 */
export function isPersonalCalendarOwnedBy(calendar, loginId) {
  if (!calendar || !loginId) return false;
  if (calendar.id === HOLIDAYS_KR_CALENDAR_ID) return false;
  return String(calendar.ownerLoginId ?? '').toLowerCase() === String(loginId).toLowerCase();
}

/**
 * @param {object | null | undefined} calendar
 */
export function isHolidaysCalendar(calendar) {
  return calendar?.id === HOLIDAYS_KR_CALENDAR_ID;
}
