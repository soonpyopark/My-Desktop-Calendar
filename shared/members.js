/**
 * Member accounts (settings → 회원관리). Mirrors NAS4USB shared/members.js.
 *
 * @typedef {'member' | 'super_admin'} MemberRole
 *
 * @typedef {{
 *   id: string,
 *   loginId: string,
 *   displayName: string,
 *   passwordHash: string,
 *   role: MemberRole,
 *   active: boolean,
 * }} MemberRecord
 *
 * @typedef {{
 *   id: string,
 *   loginId: string,
 *   displayName: string,
 *   role: MemberRole,
 *   active: boolean,
 *   isBootstrapAdmin?: boolean,
 * }} PublicMember
 */

export const MEMBER_ROLES = /** @type {const} */ (['member', 'super_admin']);

/** Fixed id of the seeded .env bootstrap admin row (mirrors MembersService). */
export const BOOTSTRAP_ADMIN_MEMBER_ID = 'member-bootstrap-admin';

/** @param {Pick<PublicMember, 'id' | 'isBootstrapAdmin'> | null | undefined} member */
export function isBootstrapAdminMember(member) {
  if (!member) return false;
  if (member.isBootstrapAdmin === true) return true;
  return member.id === BOOTSTRAP_ADMIN_MEMBER_ID;
}

/** @param {MemberRole | string | undefined} role */
export function memberRoleToLabel(role) {
  return role === 'super_admin' ? '총괄관리자' : '일반사용자';
}

/** @param {string} loginId */
export function defaultMemberPassword(loginId) {
  return `${String(loginId ?? '').trim()}!!`;
}

/**
 * @param {unknown} value
 * @returns {MemberRole}
 */
export function normalizeMemberRole(value) {
  return value === 'super_admin' ? 'super_admin' : 'member';
}
