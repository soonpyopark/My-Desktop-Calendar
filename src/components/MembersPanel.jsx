import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  defaultMemberPassword,
  isBootstrapAdminMember,
  memberRoleToLabel,
  normalizeMemberRole,
} from '../../shared/members.js';
import { listMembers, saveMembers } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { useAppDialog } from './AppDialogProvider.jsx';

/**
 * @typedef {import('../../shared/members.js').PublicMember} PublicMember
 * @typedef {import('../../shared/members.js').MemberRole} MemberRole
 * @typedef {PublicMember & { password?: string, isNew?: boolean, markedDelete?: boolean }} MemberDraft
 * @typedef {'member-list' | 'member-add'} MembersSubTab
 */

const fieldClass =
  'w-full rounded-lg border border-gcal-border bg-gcal-input px-3 py-2 text-sm text-gcal-heading outline-none focus:border-gcal-blue focus:ring-2 focus:ring-gcal-blue/15';

/**
 * @param {PublicMember} member
 * @returns {MemberDraft}
 */
function createMemberDraft(member) {
  return { ...member, password: '', isNew: false, markedDelete: false };
}

/**
 * @param {MemberDraft} member
 * @param {string} query
 */
function matchesMemberSearch(member, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    member.displayName.toLowerCase().includes(normalized)
    || member.loginId.toLowerCase().includes(normalized)
  );
}

/**
 * @param {MemberDraft[]} draftMembers
 */
function buildPayloadFromDraft(draftMembers) {
  /** @type {Array<Record<string, unknown>>} */
  const memberPayload = [];
  for (const member of draftMembers) {
    if (member.markedDelete && !member.isNew) {
      memberPayload.push({
        id: member.id,
        loginId: member.loginId,
        displayName: member.displayName,
        role: member.role,
        active: member.active,
        _delete: true,
      });
      continue;
    }
    if (member.markedDelete) continue;
    if (member.isNew) {
      memberPayload.push({
        loginId: member.loginId,
        displayName: member.displayName,
        role: member.role,
        active: member.active,
        password: member.password,
      });
    } else {
      memberPayload.push({
        id: member.id,
        loginId: member.loginId,
        displayName: member.displayName,
        role: member.role,
        active: member.active,
        ...(member.password ? { password: member.password } : {}),
      });
    }
  }
  return { members: memberPayload };
}

/** Settings → 회원관리 (ported from NAS4USB MembersSettingsPanel). */
export default function MembersPanel() {
  const { alert, confirm } = useAppDialog();
  /** @type {[MembersSubTab, Function]} */
  const [tab, setTab] = useState('member-list');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /** @type {[MemberDraft[], Function]} */
  const [members, setMembers] = useState([]);
  const [editingMemberId, setEditingMemberId] = useState(/** @type {string | null} */ (null));
  const [memberLoginId, setMemberLoginId] = useState('');
  /** @type {[MemberRole, Function]} */
  const [memberRole, setMemberRole] = useState('member');
  const [memberActive, setMemberActive] = useState(true);
  const [memberPassword, setMemberPassword] = useState('');
  const [memberSearchQuery, setMemberSearchQuery] = useState('');

  const applyMembers = useCallback((nextMembers) => {
    setMembers((Array.isArray(nextMembers) ? nextMembers : []).map(createMemberDraft));
  }, []);

  const loadMembers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listMembers();
      applyMembers(result?.members ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '회원 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [applyMembers]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  const visibleMembers = members.filter((member) => !member.markedDelete);
  const filteredMembers = useMemo(
    () => visibleMembers.filter((member) => matchesMemberSearch(member, memberSearchQuery)),
    [visibleMembers, memberSearchQuery],
  );

  const resetMemberForm = () => {
    setEditingMemberId(null);
    setMemberLoginId('');
    setMemberRole('member');
    setMemberActive(true);
    setMemberPassword('');
  };

  const openMemberAddTab = () => {
    resetMemberForm();
    setTab('member-add');
  };

  const startEditMember = (member) => {
    setEditingMemberId(member.id);
    setMemberLoginId(member.loginId);
    setMemberRole(normalizeMemberRole(member.role));
    setMemberActive(member.active);
    setMemberPassword('');
    setTab('member-add');
  };

  /**
   * @param {MemberDraft[]} draftMembers
   * @param {{ silent?: boolean }} [options]
   */
  const persistMembers = async (draftMembers, { silent = false } = {}) => {
    setSaving(true);
    setError('');
    try {
      const result = await saveMembers(buildPayloadFromDraft(draftMembers));
      if (result?.ok === false) {
        const message = result?.message || '회원 저장에 실패했습니다.';
        setError(message);
        setMembers(draftMembers);
        await alert(message, { title: '회원 관리' });
        return false;
      }
      applyMembers(result.members ?? []);
      if (!silent) {
        await alert('회원 설정을 저장했습니다.', { title: '회원 관리' });
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : '회원 저장에 실패했습니다.';
      setError(message);
      setMembers(draftMembers);
      await alert(message, { title: '회원 관리' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const editingMember = editingMemberId
    ? members.find((member) => member.id === editingMemberId) ?? null
    : null;
  const editingBootstrapAdmin = isBootstrapAdminMember(editingMember);

  const handleMemberSubmit = async () => {
    const loginId = (editingBootstrapAdmin
      ? (editingMember?.loginId ?? memberLoginId)
      : memberLoginId
    ).trim();
    if (!loginId) {
      await alert('로그인 아이디를 입력해 주세요.', { title: '회원 관리' });
      return;
    }
    if (!editingMemberId && memberPassword.trim().length < 6) {
      await alert('비밀번호는 6자 이상이어야 합니다.', { title: '회원 관리' });
      return;
    }
    if (editingMemberId && memberPassword.trim() && memberPassword.trim().length < 6) {
      await alert('비밀번호는 6자 이상이어야 합니다.', { title: '회원 관리' });
      return;
    }

    const duplicate = members.some(
      (member) =>
        !member.markedDelete
        && member.id !== editingMemberId
        && member.loginId.toLowerCase() === loginId.toLowerCase(),
    );
    if (duplicate) {
      await alert(`아이디 「${loginId}」가 이미 사용 중입니다.`, { title: '회원 관리' });
      return;
    }

    /** @type {MemberDraft[]} */
    let nextMembers;
    if (editingMemberId) {
      nextMembers = members.map((member) =>
        (member.id === editingMemberId
          ? {
              ...member,
              loginId: editingBootstrapAdmin ? member.loginId : loginId,
              displayName: editingBootstrapAdmin ? member.displayName || member.loginId : loginId,
              role: editingBootstrapAdmin ? 'super_admin' : memberRole,
              active: editingBootstrapAdmin ? true : memberActive,
              password: memberPassword,
            }
          : member),
      );
    } else {
      nextMembers = [
        ...members,
        {
          id: `new-member-${Date.now()}`,
          loginId,
          displayName: loginId,
          role: memberRole,
          active: memberActive,
          password: memberPassword,
          isNew: true,
        },
      ];
    }

    setMembers(nextMembers);
    resetMemberForm();
    setTab('member-list');
    await persistMembers(nextMembers, { silent: true });
  };

  const markMemberDelete = async (member) => {
    if (isBootstrapAdminMember(member)) {
      await alert('기본 관리자(admin) 계정은 삭제할 수 없습니다.', { title: '회원 관리' });
      return;
    }
    const ok = await confirm(
      `「${member.loginId}」 회원과 해당 회원의 캘린더·일정이 모두 삭제됩니다.`,
      {
        title: '회원 삭제',
        confirmLabel: '삭제',
        variant: 'danger',
      },
    );
    if (!ok) return;

    /** @type {MemberDraft[]} */
    const nextMembers = member.isNew
      ? members.filter((entry) => entry.id !== member.id)
      : members.map((entry) =>
          (entry.id === member.id ? { ...entry, markedDelete: true } : entry),
        );

    if (editingMemberId === member.id) resetMemberForm();
    setMembers(nextMembers);
    await persistMembers(nextMembers, { silent: true });
  };

  return (
    <div className="w-full max-w-full text-left">
      <h2 className="mb-2 text-[22px] font-normal text-gcal-heading">회원 관리</h2>
      <p className="mb-6 text-sm text-gcal-muted">
        로그인할 수 있는 계정을 추가·수정합니다. 기본 관리자(admin)는 목록에 포함되며,
        여기서 바꾼 비밀번호가 .env 설정보다 우선합니다.
      </p>

      <div className="mb-4 flex gap-1 border-b border-gcal-border-light" role="tablist" aria-label="회원 관리">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'member-list'}
          className={cn(
            '-mb-px rounded-t-lg px-3 py-2 text-sm',
            tab === 'member-list'
              ? 'border border-b-transparent border-gcal-border-light bg-gcal-surface font-medium text-gcal-heading'
              : 'border border-transparent font-medium text-gcal-muted hover:text-gcal-heading',
          )}
          onClick={() => setTab('member-list')}
        >
          회원목록
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'member-add'}
          className={cn(
            '-mb-px rounded-t-lg px-3 py-2 text-sm',
            tab === 'member-add'
              ? 'border border-b-transparent border-gcal-border-light bg-gcal-surface font-medium text-gcal-heading'
              : 'border border-transparent font-medium text-gcal-muted hover:text-gcal-heading',
          )}
          onClick={openMemberAddTab}
        >
          회원추가
        </button>
      </div>

      {loading ? <p className="text-sm text-gcal-muted">회원 목록을 불러오는 중…</p> : null}
      {error ? <p className="text-sm text-[#c5221f]">{error}</p> : null}
      {saving ? <p className="text-sm text-gcal-muted">저장 중…</p> : null}

      {!loading && tab === 'member-list' ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium text-gcal-heading">회원 목록</h3>
              <p className="text-xs text-gcal-muted">
                총 {visibleMembers.length}명
                {memberSearchQuery.trim() ? ` · 검색 결과 ${filteredMembers.length}명` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="search"
                className="h-8 w-52 rounded-lg border border-gcal-border bg-gcal-input px-2 text-sm text-gcal-heading outline-none focus:border-gcal-blue"
                value={memberSearchQuery}
                onChange={(event) => setMemberSearchQuery(event.target.value)}
                placeholder="회원 이름·아이디 검색"
                aria-label="회원 검색"
              />
              {memberSearchQuery ? (
                <button
                  type="button"
                  className="h-8 rounded-lg border border-gcal-border px-2 text-xs text-gcal-muted hover:bg-gcal-surface-2"
                  onClick={() => setMemberSearchQuery('')}
                >
                  검색 초기화
                </button>
              ) : null}
            </div>
          </div>

          {filteredMembers.length === 0 ? (
            <p className="rounded-lg border border-dashed border-gcal-border px-3 py-4 text-sm text-gcal-muted">
              표시할 회원이 없습니다.
            </p>
          ) : (
            <ul className="m-0 list-none divide-y divide-gcal-border-light overflow-hidden rounded-lg border border-gcal-border-light p-0">
              {filteredMembers.map((member) => {
                const bootstrapAdmin = isBootstrapAdminMember(member);
                return (
                <li
                  key={member.id}
                  className={cn(
                    'flex items-center justify-between gap-3 px-3 py-2.5',
                    editingMemberId === member.id ? 'bg-gcal-blue-soft/50' : 'bg-gcal-surface',
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gcal-heading">
                      {member.displayName}
                      {bootstrapAdmin ? (
                        <span className="ml-1.5 text-xs font-normal text-gcal-muted">(기본 관리자)</span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-gcal-muted">
                      {member.loginId}
                      {' · '}
                      {memberRoleToLabel(member.role)}
                      {!member.active ? ' · 비활성' : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button
                      type="button"
                      className="rounded-lg border border-gcal-border px-2 py-1 text-xs text-gcal-heading hover:bg-gcal-surface-2"
                      disabled={saving}
                      onClick={() => startEditMember(member)}
                    >
                      수정
                    </button>
                    {bootstrapAdmin ? null : (
                      <button
                        type="button"
                        className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                        disabled={saving}
                        onClick={() => void markMemberDelete(member)}
                      >
                        삭제
                      </button>
                    )}
                  </div>
                </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {!loading && tab === 'member-add' ? (
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-gcal-heading">
            {editingMemberId
              ? (editingBootstrapAdmin ? '기본 관리자 수정' : '회원 수정')
              : '회원 추가'}
          </h3>
          <p className="text-xs text-gcal-muted">
            {editingBootstrapAdmin
              ? '기본 관리자 비밀번호를 변경할 수 있습니다. 변경한 비밀번호가 .env 설정보다 우선합니다.'
              : editingMemberId
                ? '회원 정보를 수정합니다. 비밀번호는 변경할 때만 입력하세요.'
                : '새 회원을 추가합니다. 표시 이름은 로그인 아이디와 동일하게 등록됩니다.'}
          </p>
          <div className="space-y-3 rounded-xl border border-gcal-border-light bg-gcal-surface p-4">
            <label className="block space-y-1">
              <span className="text-xs text-gcal-muted">로그인 아이디</span>
              <input
                type="text"
                className={fieldClass}
                value={memberLoginId}
                onChange={(event) => setMemberLoginId(event.target.value)}
                placeholder="로그인 아이디"
                autoComplete="off"
                disabled={editingBootstrapAdmin}
              />
            </label>
            {editingBootstrapAdmin ? null : (
              <>
                <label className="block space-y-1">
                  <span className="text-xs text-gcal-muted">역할</span>
                  <select
                    className={fieldClass}
                    value={memberRole}
                    onChange={(event) =>
                      setMemberRole(event.target.value === 'super_admin' ? 'super_admin' : 'member')
                    }
                  >
                    <option value="member">일반사용자</option>
                    <option value="super_admin">총괄관리자</option>
                  </select>
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-gcal-body">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gcal-border"
                    checked={memberActive}
                    onChange={(event) => setMemberActive(event.target.checked)}
                  />
                  활성 계정
                </label>
              </>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[12rem] flex-1 space-y-1">
                <span className="text-xs text-gcal-muted">비밀번호</span>
                <input
                  type="text"
                  className={fieldClass}
                  value={memberPassword}
                  onChange={(event) => setMemberPassword(event.target.value)}
                  placeholder={editingMemberId ? '비밀번호 (변경 시에만 입력)' : '비밀번호 (6자 이상)'}
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="h-[38px] rounded-lg border border-gcal-border bg-gcal-page px-3 text-sm text-gcal-heading hover:bg-gcal-surface-2"
                onClick={() => setMemberPassword(defaultMemberPassword(memberLoginId))}
              >
                초기 비밀번호 설정
              </button>
            </div>
            <div className="flex justify-end gap-2">
              {editingMemberId ? (
                <button
                  type="button"
                  className="rounded-lg border border-gcal-border bg-gcal-page px-3 py-1.5 text-sm text-gcal-heading hover:bg-gcal-surface-2"
                  disabled={saving}
                  onClick={() => {
                    resetMemberForm();
                    setTab('member-list');
                  }}
                >
                  취소
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-lg bg-gcal-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-[#1765cc] disabled:opacity-50"
                disabled={saving}
                onClick={() => void handleMemberSubmit()}
              >
                {saving ? '저장 중…' : editingMemberId ? '적용' : '회원 추가'}
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
