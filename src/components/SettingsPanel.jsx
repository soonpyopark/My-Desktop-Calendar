import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CALENDARS,
  DEFAULT_SETTINGS,
  DEFAULT_VIEW_OPTIONS,
  HOLIDAYS_KR_CALENDAR_ID,
} from '../../shared/constants.js';
import { applyColorScheme, getColorScheme, normalizeColorScheme } from '../lib/colorScheme.js';
import { applyAccentColor, getAccentColor, normalizeAccentColor } from '../lib/accentColor.js';
import { eventToMutationPayload } from '../lib/eventHistory.js';
import { getDefaultCalendarColor } from '../../shared/calendarColorPalette.js';
import { sortTags } from '../../shared/eventTags.js';
import { sortCalendarsByOrder } from '../../shared/calendarOrder.js';
import CalendarColorPalette from './CalendarColorPalette.jsx';
import { cn } from '../lib/cn.js';
import { isCalendarPublished } from '../lib/calendarVisibility.js';
import { getJsonExportTimestamp } from '../lib/exportEvents.js';
import {
  detectCalendarFileFormat,
  downloadCalendarFile,
  exportFullStore,
  exportSingleCalendar,
  extractEventsFromImportPayload,
  parseImportPayload,
} from '../../shared/calendarInterchange.js';
import CalendarFileFormatButton, { getAllImportAcceptAttribute } from './CalendarFileFormatButton.jsx';
import { useAppDialog } from './AppDialogProvider.jsx';
import MembersPanel from './MembersPanel.jsx';
import { ensureOnlineOrNotify, showOfflineNotice } from '../lib/offlineNotice.js';
import { isValidIpOrCidr, normalizeAllowedIpCidrs } from '../../shared/ipCidrCore.js';
import {
  buildSecuritySettingsPayload,
  parseSecuritySettingsPayload,
  securitySettingsExportFilename,
} from '../../shared/securitySettingsIo.js';
import { isNativeHost } from '../lib/nativeHost.js';

const fieldBoxClass =
  'rounded-lg border border-gcal-border bg-gcal-input px-4 py-3 focus-within:border-gcal-blue focus-within:ring-2 focus-within:ring-gcal-blue/15';

function FieldLabel({ children }) {
  return <span className="mb-1 block text-xs text-gcal-muted">{children}</span>;
}

function CreateCalendarForm({ ownerName, settings, calendars, onCreateCalendar, onDone }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(() => getDefaultCalendarColor(calendars.length));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('캘린더 이름을 입력해 주세요.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const created = await onCreateCalendar({
        name: name.trim(),
        description: description.trim(),
        timezone: settings?.timezone ?? DEFAULT_SETTINGS.timezone,
        timezoneLabel: settings?.timezoneLabel ?? DEFAULT_SETTINGS.timezoneLabel,
        color,
        ownerName,
        custom: true,
      });
      setName('');
      setDescription('');
      setColor(getDefaultCalendarColor(calendars.length + 1));
      onDone?.(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : '캘린더를 만들지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="w-full max-w-full text-left" onSubmit={handleSubmit}>
      <h2 className="mb-8 text-[22px] font-normal text-gcal-heading">새 캘린더 만들기</h2>

      <div className="space-y-5">
        <div>
          <FieldLabel>일정 색상</FieldLabel>
          <CalendarColorPalette value={color} onChange={setColor} />
        </div>

        <div className={fieldBoxClass}>
          <FieldLabel>이름</FieldLabel>
          <input
            className="w-full border-0 bg-transparent p-0 text-base text-gcal-heading outline-none placeholder:text-gcal-muted/70"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder=""
            autoFocus
          />
        </div>

        <div className={fieldBoxClass}>
          <FieldLabel>설명</FieldLabel>
          <textarea
            className="min-h-[88px] w-full resize-y border-0 bg-transparent p-0 text-base text-gcal-heading outline-none"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-[#c5221f]">{error}</p>}

      <button
        type="submit"
        disabled={saving}
        className="mt-8 rounded-full bg-gcal-blue px-6 py-2.5 text-sm font-medium text-white shadow-[0_1px_2px_rgba(26,115,232,0.35)] transition-colors hover:bg-[#1765cc] disabled:opacity-60"
      >
        {saving ? '만드는 중…' : '캘린더 만들기'}
      </button>
    </form>
  );
}

function ViewOptionsPanel({ settings, onSaveSettings }) {
  const shellControls = isNativeHost();
  const initial = { ...DEFAULT_VIEW_OPTIONS, ...settings?.viewOptions };
  const [showWeekNumbers, setShowWeekNumbers] = useState(initial.showWeekNumbers);
  const [weekStartsOnSunday, setWeekStartsOnSunday] = useState(initial.weekStartsOnSunday !== false);
  const [colorScheme, setColorScheme] = useState(() => getColorScheme(initial));
  const [accentColor, setAccentColor] = useState(() => getAccentColor(initial));
  const [runAtStartup, setRunAtStartup] = useState(initial.runAtStartup !== false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const next = { ...DEFAULT_VIEW_OPTIONS, ...settings?.viewOptions };
    setShowWeekNumbers(next.showWeekNumbers);
    setWeekStartsOnSunday(next.weekStartsOnSunday !== false);
    setColorScheme(getColorScheme(next));
    setAccentColor(getAccentColor(next));
    setRunAtStartup(next.runAtStartup !== false);
  }, [settings]);

  const buildViewOptions = (patch = {}) => ({
    showWeekNumbers,
    weekStartsOnSunday,
    colorScheme,
    accentColor,
    runAtStartup,
    eventsHidden: settings?.viewOptions?.eventsHidden === true,
    completedHidden: settings?.viewOptions?.completedHidden === true,
    ...patch,
  });

  const persistViewOptions = async (nextOptions) => {
    setSaving(true);
    setSaved(false);
    try {
      await onSaveSettings({ viewOptions: nextOptions });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const handleShowWeekNumbersChange = async (checked) => {
    setShowWeekNumbers(checked);
    await persistViewOptions(buildViewOptions({ showWeekNumbers: checked }));
  };

  const handleWeekStartsOnSundayChange = async (checked) => {
    setWeekStartsOnSunday(checked);
    await persistViewOptions(buildViewOptions({ weekStartsOnSunday: checked }));
  };

  const handleColorSchemeChange = async (nextScheme) => {
    const normalized = normalizeColorScheme(nextScheme);
    setColorScheme(normalized);
    applyColorScheme(normalized);
    await persistViewOptions(buildViewOptions({ colorScheme: normalized }));
  };

  const handleAccentColorChange = async (nextColor) => {
    const normalized = normalizeAccentColor(nextColor);
    setAccentColor(normalized);
    applyAccentColor(normalized);
    await persistViewOptions(buildViewOptions({ accentColor: normalized }));
  };

  const handleRunAtStartupChange = async (checked) => {
    setRunAtStartup(checked);
    await persistViewOptions(buildViewOptions({ runAtStartup: checked }));
  };

  const themeOptions = [
    { value: 'light', label: '라이트 모드' },
    { value: 'dark', label: '다크 모드' },
    { value: 'system', label: '시스템 설정' },
  ];

  return (
    <div className="w-full max-w-full text-left">
      <h2 className="mb-8 text-[22px] font-normal text-gcal-heading">보기 옵션</h2>
      <div className="space-y-4">
        <label className="flex items-center gap-2.5 text-sm text-gcal-body">
          <input
            type="checkbox"
            checked={showWeekNumbers}
            disabled={saving}
            onChange={(e) => void handleShowWeekNumbersChange(e.target.checked)}
          />
          몇 번째 주인지 표시
        </label>
        <label className="flex items-center gap-2.5 text-sm text-gcal-body">
          <input
            type="checkbox"
            checked={weekStartsOnSunday}
            disabled={saving}
            onChange={(e) => void handleWeekStartsOnSundayChange(e.target.checked)}
          />
          <span>
            1주일 시작일을 일요일로 하기
            <span className="text-gcal-muted"> (체크 해제 시 1주일 시작일이 월요일로 설정됨)</span>
          </span>
        </label>
      </div>

      <fieldset className="mt-8 space-y-3 border-0 p-0">
        <legend className="mb-8 text-[22px] font-normal text-gcal-heading">테마</legend>
        {themeOptions.map(({ value, label }) => (
          <label key={value} className="flex items-center gap-2.5 text-sm text-gcal-body">
            <input
              type="radio"
              name="colorScheme"
              value={value}
              checked={colorScheme === value}
              disabled={saving}
              onChange={() => void handleColorSchemeChange(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>

      <fieldset className="mt-8 border-0 p-0">
        <legend className="mb-3 text-[22px] font-normal text-gcal-heading">테마 색상</legend>
        <p className="mb-4 text-sm text-gcal-muted">
          버튼, 강조 표시, 선택된 날짜에 적용되는 강조 색상입니다. 라이트/다크 모드와 별개로
          선택할 수 있어요.
        </p>
        <CalendarColorPalette value={accentColor} onChange={(color) => void handleAccentColorChange(color)} />
      </fieldset>

      {shellControls && (
        <div className="mt-8">
          <h3 className="mb-8 text-[22px] font-normal text-gcal-heading">프로그램 시작시 실행 모드</h3>
          <label className="flex items-center gap-2.5 text-sm text-gcal-body">
            <input
              type="checkbox"
              checked={runAtStartup}
              disabled={saving}
              onChange={(e) => void handleRunAtStartupChange(e.target.checked)}
            />
            컴퓨터 시작시 자동 실행
          </label>
        </div>
      )}

      {saved && <p className="mt-4 text-sm text-gcal-green">저장되었습니다.</p>}
    </div>
  );
}

function EyeIcon({ open }) {
  if (open) {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"
      />
    </svg>
  );
}

function isCalendarVisible(calendar) {
  return isCalendarPublished(calendar);
}

function isSharedCalendar(calendar) {
  return calendar.owner === 'shared';
}

function calendarOwnerLoginId(calendar) {
  return String(calendar?.ownerLoginId ?? '').trim();
}

/** Personal calendars owned by the signed-in user (excludes shared + other members). */
function isMyCalendar(calendar, currentLoginId) {
  if (isSharedCalendar(calendar)) return false;
  const owner = calendarOwnerLoginId(calendar);
  const me = String(currentLoginId ?? '').trim();
  if (!me) return owner.length === 0;
  return owner.length === 0 || owner.toLowerCase() === me.toLowerCase();
}

/** Personal calendars owned by other members (super-admin store only). */
function isMemberCalendar(calendar, currentLoginId) {
  if (isSharedCalendar(calendar)) return false;
  const owner = calendarOwnerLoginId(calendar);
  if (!owner) return false;
  const me = String(currentLoginId ?? '').trim();
  if (!me) return true;
  return owner.toLowerCase() !== me.toLowerCase();
}

function formatHolidaySyncTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('ko-KR');
  } catch {
    return iso;
  }
}

/** Map internal bridge/timeout errors to a user-facing holiday sync message. */
function friendlyHolidaySyncError(message) {
  const text = String(message ?? '').trim();
  if (!text || /native bridge timeout|native host unavailable|timeout/i.test(text)) {
    return '동기화에 실패하였습니다. 잠시 후 다시 시도해 보세요.';
  }
  return text;
}

function HolidaysSyncPanel({ settings, onSyncHolidays, onSaveSettings }) {
  const { alert } = useAppDialog();
  const [syncing, setSyncing] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [serviceKey, setServiceKey] = useState(settings?.holidaysKr?.serviceKey ?? '');
  const [rememberKey, setRememberKey] = useState(Boolean(settings?.holidaysKr?.rememberKey));
  const [keySaved, setKeySaved] = useState(false);
  const status = settings?.holidaysKr ?? null;

  useEffect(() => {
    setServiceKey(settings?.holidaysKr?.serviceKey ?? '');
    setRememberKey(Boolean(settings?.holidaysKr?.rememberKey));
    setKeySaved(false);
  }, [settings?.holidaysKr?.serviceKey, settings?.holidaysKr?.rememberKey]);

  const handleSaveKey = async () => {
    const trimmed = serviceKey.trim();
    if (rememberKey && !trimmed) {
      await alert('저장할 API 인증키를 입력해 주세요.');
      return;
    }
    setSavingKey(true);
    setKeySaved(false);
    try {
      await onSaveSettings({
        holidaysKr: {
          ...status,
          serviceKey: rememberKey ? trimmed : '',
          rememberKey: rememberKey && Boolean(trimmed),
        },
      });
      setKeySaved(true);
    } catch (err) {
      await alert(err instanceof Error ? err.message : 'API 키를 저장하지 못했습니다.');
    } finally {
      setSavingKey(false);
    }
  };

  const handleSync = async () => {
    const trimmed = serviceKey.trim();
    if (!trimmed) {
      await alert('API 인증키를 입력해 주세요.');
      return;
    }
    const online = await ensureOnlineOrNotify('공휴일 동기화는 인터넷 연결이 필요합니다.');
    if (!online) return;

    setSyncing(true);
    try {
      const result = await onSyncHolidays({
        serviceKey: trimmed,
        rememberKey,
      });
      if (result?.skipped) {
        await alert(result.message || '공휴일 API 인증키가 필요합니다.');
        return;
      }
      if (!result?.ok) {
        const raw = String(result?.message ?? result?.error ?? '');
        const offline = result?.reason === 'offline'
          || /인터넷 연결이 필요합니다|fetch failed|network|offline/i.test(raw);
        if (offline) {
          await showOfflineNotice('공휴일 동기화는 인터넷 연결이 필요합니다.');
          return;
        }
        await alert(friendlyHolidaySyncError(raw) || '동기화에 실패하였습니다. 잠시 후 다시 시도해 보세요.');
        return;
      }
      await alert(result.message || '공휴일을 동기화했습니다.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? '');
      const offline = /인터넷 연결이 필요합니다|fetch failed|network|offline|Failed to fetch/i.test(message);
      if (offline) {
        await showOfflineNotice('공휴일 동기화는 인터넷 연결이 필요합니다.');
        return;
      }
      await alert(friendlyHolidaySyncError(message) || '동기화에 실패하였습니다. 잠시 후 다시 시도해 보세요.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="w-full max-w-full text-left">
      <h2 className="mb-8 text-[22px] font-normal text-gcal-heading">대한민국의 휴일</h2>
      <div className="space-y-4">
        <div className="rounded-lg border border-gcal-border bg-gcal-surface p-5">
          <h3 className="mb-2 text-base font-medium text-gcal-heading">API 인증키</h3>
          <p className="mb-4 text-sm text-gcal-muted">
            공공데이터포털 특일 정보 API 인증키를 입력하세요.
            {' '}
            <span className="text-gcal-heading">저장</span>
            을 체크하면 다음 실행 후에도 유지되며, 동기화 버튼에 사용됩니다.
          </p>
          <div className={fieldBoxClass}>
            <FieldLabel>Service Key</FieldLabel>
            <input
              type="password"
              autoComplete="off"
              className="w-full border-0 bg-transparent p-0 text-base text-gcal-heading outline-none placeholder:text-gcal-muted/70"
              value={serviceKey}
              onChange={(e) => {
                setServiceKey(e.target.value);
                setKeySaved(false);
              }}
              placeholder="공공데이터포털 인증키"
            />
          </div>
          <label className="mt-3 inline-flex items-center gap-2 text-sm text-gcal-body">
            <input
              type="checkbox"
              checked={rememberKey}
              onChange={(e) => {
                setRememberKey(e.target.checked);
                setKeySaved(false);
              }}
            />
            저장
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSaveKey()}
              disabled={savingKey || syncing}
              className="rounded-full border border-gcal-border bg-gcal-page px-5 py-2 text-sm font-medium hover:bg-gcal-surface-2 disabled:opacity-60"
            >
              {savingKey ? '저장 중…' : '키 저장'}
            </button>
            <p className="min-h-[1.25rem] text-sm text-gcal-muted">
              {keySaved && !savingKey ? '저장되었습니다.' : ''}
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-gcal-border bg-gcal-surface p-5">
          <h3 className="mb-2 text-base font-medium text-gcal-heading">공휴일 동기화</h3>
          <p className="mb-4 text-sm text-gcal-muted">
            공휴일·대체공휴일을 가져와
            {' '}
            <span className="text-gcal-heading">대한민국의 휴일</span>
            {' '}
            캘린더에 반영합니다. 이 캘린더의 일정은 동기화로만 갱신됩니다.
          </p>
          {status?.lastSyncedAt && (
            <p className="mb-4 text-sm text-gcal-muted">
              최근 동기화:
              {' '}
              {formatHolidaySyncTime(status.lastSyncedAt)}
              {typeof status.count === 'number' ? ` · ${status.count}건` : ''}
            </p>
          )}
          {status && status.ok === false && status.message && (
            <p className="mb-4 text-sm text-[#c5221f]">{status.message}</p>
          )}
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={syncing || savingKey}
            className="rounded-full bg-gcal-blue px-5 py-2 text-sm font-medium text-white hover:bg-[#1765cc] disabled:opacity-60"
          >
            {syncing ? '동기화 중…' : '지금 동기화'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TagDragHandleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M9 5h2v2H9V5zm4 0h2v2h-2V5zM9 11h2v2H9v-2zm4 0h2v2h-2v-2zM9 17h2v2H9v-2zm4 0h2v2h-2v-2z"
      />
    </svg>
  );
}

/** `<input type="color">` needs #rrggbb; fall back when tag color is missing/invalid. */
function toColorInputValue(color, fallback = '#9aa0a6') {
  const raw = String(color ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const [, r, g, b] = raw;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

/**
 * Isolated create form so typing the name only re-renders this subtree —
 * not the whole tag list (drag handlers / edit rows) under TagsPanel.
 */
function NewTagForm({ tagsCount, busy, onCreate }) {
  const { alert } = useAppDialog();
  const [nameDraft, setNameDraft] = useState('');
  const [colorDraft, setColorDraft] = useState(() => getDefaultCalendarColor(0));

  const handleCreate = async () => {
    const name = nameDraft.trim();
    if (!name) {
      await alert('태그 이름을 입력해 주세요.');
      return;
    }
    try {
      await onCreate({ name, color: colorDraft });
      setNameDraft('');
      setColorDraft(getDefaultCalendarColor(tagsCount + 1));
    } catch (err) {
      await alert(err instanceof Error ? err.message : '태그를 추가하지 못했습니다.');
    }
  };

  return (
    <div className="mb-6 space-y-4 rounded-xl border border-gcal-border-light bg-gcal-surface p-4">
      <div>
        <FieldLabel>태그 색상</FieldLabel>
        <CalendarColorPalette value={colorDraft} onChange={setColorDraft} />
      </div>
      <div>
        <FieldLabel>새 태그</FieldLabel>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            type="text"
            className={cn(fieldBoxClass, 'min-w-[10rem] flex-1')}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder="예: 행정"
            maxLength={32}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleCreate();
              }
            }}
          />
          <button
            type="button"
            className="inline-flex h-11 items-center rounded-lg bg-gcal-blue px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
            disabled={busy || !nameDraft.trim()}
            onClick={() => void handleCreate()}
          >
            추가
          </button>
        </div>
      </div>
    </div>
  );
}

function TagsPanel({ tags, onCreateTag, onUpdateTag, onDeleteTag }) {
  const { alert, confirm } = useAppDialog();
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState(() => getDefaultCalendarColor(0));
  const [busy, setBusy] = useState(false);
  const [orderIds, setOrderIds] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [dropId, setDropId] = useState(null);

  const sorted = useMemo(() => {
    const base = sortTags(tags ?? []);
    if (!orderIds?.length) return base;
    const byId = new Map(base.map((tag) => [tag.id, tag]));
    const ordered = [];
    for (const id of orderIds) {
      const tag = byId.get(id);
      if (tag) {
        ordered.push(tag);
        byId.delete(id);
      }
    }
    for (const tag of byId.values()) ordered.push(tag);
    return ordered;
  }, [tags, orderIds]);

  useEffect(() => {
    if (!orderIds?.length) return;
    const live = sortTags(tags ?? []).map((tag) => tag.id).join('\0');
    if (live === orderIds.join('\0')) setOrderIds(null);
  }, [tags, orderIds]);

  const handleCreate = useCallback(async (payload) => {
    setBusy(true);
    try {
      await onCreateTag(payload);
    } finally {
      setBusy(false);
    }
  }, [onCreateTag]);

  const handleSaveEdit = async (tag) => {
    const name = editName.trim();
    if (!name) {
      await alert('태그 이름을 입력해 주세요.');
      return;
    }
    const color = toColorInputValue(editColor, tag.color || getDefaultCalendarColor(0));
    setBusy(true);
    try {
      await onUpdateTag(tag.id, { name, color });
      setEditingId(null);
    } catch (err) {
      await alert(err instanceof Error ? err.message : '태그를 수정하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (tag) => {
    const ok = await confirm(`태그 “${tag.name}”을(를) 삭제할까요?\n이 태그가 붙은 일정에서는 태그가 제거됩니다.`, {
      variant: 'danger',
      confirmLabel: '삭제',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await onDeleteTag(tag.id);
    } catch (err) {
      await alert(err instanceof Error ? err.message : '태그를 삭제하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const reorderTags = async (fromId, toId) => {
    if (busy || editingId || !fromId || !toId || fromId === toId) return;
    const fromIndex = sorted.findIndex((tag) => tag.id === fromId);
    const toIndex = sorted.findIndex((tag) => tag.id === toId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const next = [...sorted];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    const nextIds = next.map((tag) => tag.id);
    setOrderIds(nextIds);
    setBusy(true);
    try {
      for (let i = 0; i < next.length; i += 1) {
        const tag = next[i];
        if (tag.sortOrder === i) continue;
        await onUpdateTag(tag.id, { sortOrder: i });
      }
    } catch (err) {
      setOrderIds(null);
      await alert(err instanceof Error ? err.message : '태그 순서를 바꾸지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const canDrag = !busy && !editingId;

  return (
    <div className="w-full max-w-full text-left">
      <h2 className="mb-2 text-[22px] font-normal text-gcal-heading">태그 관리</h2>
      <p className="mb-8 text-sm text-gcal-muted">
        일정에 붙일 태그를 등록합니다. 왼쪽 핸들을 끌어 순서를 바꿀 수 있습니다.
      </p>

      <NewTagForm
        tagsCount={tags?.length ?? 0}
        busy={busy}
        onCreate={handleCreate}
      />

      <ul className="m-0 list-none space-y-2 p-0">
        {sorted.length === 0 && (
          <li className="rounded-lg border border-dashed border-gcal-border px-4 py-6 text-center text-sm text-gcal-muted">
            등록된 태그가 없습니다.
          </li>
        )}
        {sorted.map((tag) => {
          const isEditing = editingId === tag.id;
          const isDragging = dragId === tag.id;
          const isDropTarget = dropId === tag.id && dragId && dragId !== tag.id;
          return (
            <li
              key={tag.id}
              className={cn(
                'flex flex-wrap items-center gap-2 rounded-lg border border-gcal-border-light px-3 py-2.5 transition-colors',
                isDragging && 'opacity-45',
                isDropTarget && 'border-gcal-blue bg-gcal-blue-soft/40',
              )}
              onDragOver={(e) => {
                if (!canDrag || !dragId || dragId === tag.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dropId !== tag.id) setDropId(tag.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) {
                  setDropId((current) => (current === tag.id ? null : current));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const fromId = e.dataTransfer.getData('text/plain') || dragId;
                setDragId(null);
                setDropId(null);
                void reorderTags(fromId, tag.id);
              }}
            >
              <button
                type="button"
                className={cn(
                  'inline-flex h-8 w-7 shrink-0 items-center justify-center rounded text-gcal-muted',
                  canDrag ? 'cursor-grab hover:bg-gcal-surface-2 hover:text-gcal-heading active:cursor-grabbing' : 'cursor-default opacity-40',
                )}
                draggable={canDrag}
                disabled={!canDrag}
                title="끌어 순서 변경"
                aria-label={`${tag.name} 순서 변경`}
                onDragStart={(e) => {
                  if (!canDrag) {
                    e.preventDefault();
                    return;
                  }
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', tag.id);
                  setDragId(tag.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropId(null);
                }}
              >
                <TagDragHandleIcon />
              </button>
              {isEditing ? null : (
                <span
                  className="h-3.5 w-3.5 shrink-0 rounded-sm"
                  style={{ background: tag.color || '#9aa0a6' }}
                  aria-hidden="true"
                />
              )}
              {isEditing ? (
                <input
                  type="text"
                  className={cn(fieldBoxClass, 'min-w-0 flex-1 py-2')}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={32}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleSaveEdit(tag);
                    }
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <span className="min-w-0 flex-1 text-sm text-gcal-heading">{tag.name}</span>
              )}
              <div className="flex shrink-0 items-center gap-1">
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      className="rounded-lg px-3 py-1.5 text-sm text-gcal-blue hover:bg-gcal-blue-soft"
                      disabled={busy}
                      onClick={() => void handleSaveEdit(tag)}
                    >
                      저장
                    </button>
                    <button
                      type="button"
                      className="rounded-lg px-3 py-1.5 text-sm text-gcal-muted hover:bg-gcal-surface-2"
                      onClick={() => setEditingId(null)}
                    >
                      취소
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="rounded-lg px-3 py-1.5 text-sm text-gcal-muted hover:bg-gcal-surface-2 hover:text-gcal-heading"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(tag.id);
                        setEditName(tag.name ?? '');
                        setEditColor(toColorInputValue(tag.color, getDefaultCalendarColor(0)));
                      }}
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      className="rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
                      disabled={busy}
                      onClick={() => void handleDelete(tag)}
                    >
                      삭제
                    </button>
                  </>
                )}
              </div>
              {isEditing ? (
                <div className="basis-full pl-9 pt-1">
                  <FieldLabel>태그 색상</FieldLabel>
                  <CalendarColorPalette value={editColor} onChange={setEditColor} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** NAS4USB-style LAN HTTP allowlist (settings.allowedIpCidrs). Empty = allow all. */
function SecurityPanel({ settings, onSaveSettings }) {
  const { alert, confirm } = useAppDialog();
  const importInputRef = useRef(null);
  const [allowedIpCidrs, setAllowedIpCidrs] = useState(() =>
    normalizeAllowedIpCidrs(settings?.allowedIpCidrs ?? []),
  );
  const [ipCidrDraft, setIpCidrDraft] = useState('');
  const [ipDescriptionDraft, setIpDescriptionDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const descriptionSaveTimerRef = useRef(null);

  useEffect(() => {
    setAllowedIpCidrs(normalizeAllowedIpCidrs(settings?.allowedIpCidrs ?? []));
  }, [settings?.allowedIpCidrs]);

  useEffect(() => () => {
    if (descriptionSaveTimerRef.current) {
      clearTimeout(descriptionSaveTimerRef.current);
    }
  }, []);

  const persistList = async (nextList, { silent = true } = {}) => {
    setSaving(true);
    try {
      const normalized = normalizeAllowedIpCidrs(nextList);
      await onSaveSettings({ allowedIpCidrs: normalized });
      setAllowedIpCidrs(normalized);
      if (!silent) {
        await alert('허용 IP 목록을 저장했습니다.');
      }
      return true;
    } catch (err) {
      await alert(err instanceof Error ? err.message : '허용 IP를 저장하지 못했습니다.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addAllowedIp = async () => {
    const value = ipCidrDraft.trim();
    if (!value) {
      await alert('허용 IP 주소를 입력해 주세요.');
      return;
    }
    if (!isValidIpOrCidr(value)) {
      await alert(
        '올바른 IPv4 주소, CIDR, 또는 IP 범위 형식이 아닙니다.\n예: 192.168.0.0/24, 10.0.0.30, 221.168.1.0-221.168.12.255',
      );
      return;
    }
    const key = value.toLowerCase();
    if (allowedIpCidrs.some((item) => item.cidr.toLowerCase() === key)) {
      await alert('이미 등록된 IP/CIDR/범위 입니다.');
      return;
    }
    const description = ipDescriptionDraft.trim();
    const nextList = [
      ...allowedIpCidrs,
      description ? { cidr: value, description } : { cidr: value },
    ];
    setIpCidrDraft('');
    setIpDescriptionDraft('');
    await persistList(nextList);
  };

  const removeAllowedIp = async (cidr) => {
    await persistList(allowedIpCidrs.filter((item) => item.cidr !== cidr));
  };

  const updateAllowedIpDescription = (cidr, description) => {
    const trimmed = description.trim();
    const nextList = allowedIpCidrs.map((item) => {
      if (item.cidr !== cidr) return item;
      if (!trimmed) return { cidr: item.cidr };
      return { cidr: item.cidr, description: trimmed };
    });
    setAllowedIpCidrs(nextList);
    if (descriptionSaveTimerRef.current) {
      clearTimeout(descriptionSaveTimerRef.current);
    }
    descriptionSaveTimerRef.current = setTimeout(() => {
      void persistList(nextList);
    }, 400);
  };

  const handleExportSecurity = async () => {
    try {
      const payload = buildSecuritySettingsPayload(allowedIpCidrs);
      const content = `${JSON.stringify(payload, null, 2)}\n`;
      downloadCalendarFile(content, securitySettingsExportFilename(), 'application/json');
      await alert(
        allowedIpCidrs.length === 0
          ? '허용 IP가 비어 있는 보안설정을 내보냈습니다.'
          : `허용 IP ${allowedIpCidrs.length}건을 포함한 보안설정을 내보냈습니다.`,
        { title: '보안설정 내보내기' },
      );
    } catch (err) {
      await alert(err instanceof Error ? err.message : '보안설정을 내보내지 못했습니다.');
    }
  };

  const handleImportSecurity = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const { allowedIpCidrs: nextList } = parseSecuritySettingsPayload(text);
      const ok = await confirm(
        nextList.length === 0
          ? `「${file.name}」의 허용 IP가 비어 있습니다.\n현재 목록을 모두 지울까요?`
          : `「${file.name}」에서 허용 IP ${nextList.length}건을 가져옵니다.\n현재 목록을 이 내용으로 바꿀까요?`,
        {
          title: '보안설정 가져오기',
          confirmLabel: '가져오기',
        },
      );
      if (!ok) return;

      const saved = await persistList(nextList, { silent: true });
      if (saved) {
        await alert(
          nextList.length === 0
            ? '허용 IP 목록을 비웠습니다.'
            : `허용 IP ${nextList.length}건을 가져왔습니다.`,
          { title: '보안설정 가져오기' },
        );
      }
    } catch (err) {
      await alert(err instanceof Error ? err.message : '보안설정을 가져오지 못했습니다.');
    }
  };

  return (
    <div className="w-full max-w-full text-left">
      <h2 className="mb-8 text-[22px] font-normal text-gcal-heading">보안 관리</h2>
      <div className="space-y-4">
        <div className="rounded-lg border border-gcal-border bg-gcal-surface p-5">
          <h3 className="mb-2 text-base font-medium text-gcal-heading">접속 허용 IP</h3>
          <p className="mb-4 text-sm leading-relaxed text-gcal-muted">
            웹(HTTP)으로 다른 PC에서 접속할 때 사용합니다. 목록이 비어 있으면 모든 IP에서 접속할 수 있습니다.
            항목을 추가하면 등록된 주소·대역·범위에서만 접속할 수 있습니다. 단일 IP, CIDR(
            <code className="rounded bg-gcal-page px-1 text-[12px]">192.168.0.0/24</code>
            ), 범위(
            <code className="rounded bg-gcal-page px-1 text-[12px]">221.168.1.0-221.168.12.255</code>
            ) 형식을 지원합니다. 서버 PC의{' '}
            <code className="rounded bg-gcal-page px-1 text-[12px]">127.0.0.1</code>
            {' '}은 항상 허용됩니다.
            {' '}설치 폴더
            <code className="rounded bg-gcal-page px-1 text-[12px]">.env</code>
            의
            {' '}
            <code className="rounded bg-gcal-page px-1 text-[12px]">HOSTNAME=0.0.0.0</code>
            과 URL ACL·방화벽도 함께 필요합니다.
          </p>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-full border border-gcal-border bg-gcal-page px-4 py-2 text-sm font-medium hover:bg-gcal-surface-2 disabled:opacity-60"
              disabled={saving}
              onClick={() => void handleExportSecurity()}
            >
              보안설정 내보내기
            </button>
            <button
              type="button"
              className="rounded-full border border-gcal-border bg-gcal-page px-4 py-2 text-sm font-medium hover:bg-gcal-surface-2 disabled:opacity-60"
              disabled={saving}
              onClick={() => importInputRef.current?.click()}
            >
              보안설정 가져오기
            </button>
            <input
              ref={importInputRef}
              type="file"
              className="hidden"
              accept=".json,application/json"
              onChange={(event) => void handleImportSecurity(event)}
            />
          </div>

          <ul className="mb-4 space-y-3">
            {allowedIpCidrs.length === 0 ? (
              <li className="list-none rounded-lg border border-dashed border-gcal-border px-3 py-3 text-sm text-gcal-muted">
                등록된 허용 IP가 없습니다.
              </li>
            ) : (
              allowedIpCidrs.map((entry) => (
                <li
                  key={entry.cidr}
                  className="list-none rounded-lg border border-gcal-border bg-gcal-page px-3 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 break-all font-mono text-sm font-semibold text-gcal-heading">
                      {entry.cidr}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 rounded-full border border-[#f6aea9] bg-white px-3 py-1 text-xs font-medium text-[#c5221f] hover:bg-[#fce8e6] disabled:opacity-50"
                      disabled={saving}
                      onClick={() => void removeAllowedIp(entry.cidr)}
                    >
                      삭제
                    </button>
                  </div>
                  <label className="mt-2 flex items-center gap-2">
                    <span className="shrink-0 text-xs font-medium text-gcal-muted">설명</span>
                    <input
                      type="text"
                      className="min-w-0 flex-1 border-0 border-b border-gcal-border bg-transparent px-0 py-1 text-sm text-gcal-heading outline-none focus:border-gcal-blue"
                      placeholder="예: 본사 사내망, VPN 대역"
                      value={entry.description ?? ''}
                      onChange={(event) =>
                        updateAllowedIpDescription(entry.cidr, event.target.value)
                      }
                    />
                  </label>
                </li>
              ))
            )}
          </ul>

          <div className="space-y-3 rounded-lg border border-gcal-border bg-gcal-page p-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-gcal-muted">허용 IP 주소</span>
              <input
                type="text"
                className="w-full rounded-md border border-gcal-border bg-gcal-input px-3 py-2 text-sm text-gcal-heading outline-none focus:border-gcal-blue"
                placeholder="예: 192.168.0.0/24, 10.0.0.30, 221.168.1.0-221.168.12.255"
                value={ipCidrDraft}
                onChange={(event) => setIpCidrDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void addAllowedIp();
                  }
                }}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-gcal-muted">설명 (선택)</span>
              <input
                type="text"
                className="w-full rounded-md border border-gcal-border bg-gcal-input px-3 py-2 text-sm text-gcal-heading outline-none focus:border-gcal-blue"
                placeholder="예: 본사 사내망, VPN 대역"
                value={ipDescriptionDraft}
                onChange={(event) => setIpDescriptionDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void addAllowedIp();
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="rounded-full border border-gcal-border bg-gcal-surface px-5 py-2 text-sm font-medium hover:bg-gcal-surface-2 disabled:opacity-60"
              disabled={saving}
              onClick={() => void addAllowedIp()}
            >
              {saving ? '저장 중…' : 'IP 추가'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SharedCalendarsNavList({
  calendars,
  activeCalendarId,
  activeSection,
  onOpenCalendarSettings,
  onToggleCalendarVisibility,
}) {
  const sharedCalendars = calendars.filter(isSharedCalendar);

  if (sharedCalendars.length === 0) {
    return null;
  }

  return (
    <div className="px-2 pt-1">
      <ul className="space-y-0.5">
        {sharedCalendars.map((calendar) => {
          const isVisible = isCalendarVisible(calendar);
          const settingsActive =
            activeSection === 'calendar-settings' && activeCalendarId === calendar.id;

          return (
            <li key={calendar.id}>
              <div
                className={cn(
                  'flex items-center gap-1 rounded-lg py-2 pl-5 pr-2 text-sm transition-colors',
                  settingsActive ? 'bg-gcal-blue-soft text-gcal-blue-dark' : 'text-gcal-heading',
                  !isVisible && !settingsActive && 'opacity-60',
                )}
              >
                <button
                  type="button"
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left transition-colors',
                    settingsActive ? 'font-medium' : 'hover:text-gcal-blue',
                  )}
                  onClick={() => onOpenCalendarSettings(calendar.id)}
                >
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]"
                    style={{ background: calendar.color ?? '#d50000' }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-gcal-muted transition-colors hover:bg-gcal-surface-2 hover:text-gcal-heading"
                  aria-label={isVisible ? '캘린더 숨기기' : '캘린더 보이기'}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleCalendarVisibility(calendar.id);
                  }}
                >
                  <EyeIcon open={isVisible} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MemberCalendarsPanel({
  calendars,
  currentLoginId,
  onOpenCalendarSettings,
  onToggleCalendarVisibility,
}) {
  const [memberSearchQuery, setMemberSearchQuery] = useState('');

  const groups = useMemo(() => {
    const memberCalendars = calendars.filter((calendar) => isMemberCalendar(calendar, currentLoginId));
    /** @type {Map<string, typeof memberCalendars>} */
    const byOwner = new Map();
    for (const calendar of memberCalendars) {
      const owner = calendarOwnerLoginId(calendar);
      const list = byOwner.get(owner) ?? [];
      list.push(calendar);
      byOwner.set(owner, list);
    }
    return [...byOwner.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'ko'))
      .map(([ownerLoginId, items]) => ({
        ownerLoginId,
        calendars: sortCalendarsByOrder(items),
      }));
  }, [calendars, currentLoginId]);

  const filteredGroups = useMemo(() => {
    const q = memberSearchQuery.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((group) => group.ownerLoginId.toLowerCase().includes(q));
  }, [groups, memberSearchQuery]);

  return (
    <div className="w-full max-w-full text-left">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[22px] font-normal text-gcal-heading">회원 캘린더 관리</h2>
          <p className="mt-1 text-sm text-gcal-muted">
            회원별 캘린더를 확인하고 표시 여부를 설정합니다.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            type="search"
            className="h-9 w-52 rounded-lg border border-gcal-border bg-gcal-input px-3 text-sm text-gcal-heading outline-none focus:border-gcal-blue focus:ring-2 focus:ring-gcal-blue/15"
            value={memberSearchQuery}
            onChange={(event) => setMemberSearchQuery(event.target.value)}
            placeholder="멤버명 검색"
            aria-label="멤버명 검색"
          />
          {memberSearchQuery ? (
            <button
              type="button"
              className="h-9 rounded-lg border border-gcal-border px-2.5 text-xs text-gcal-muted hover:bg-gcal-surface-2"
              onClick={() => setMemberSearchQuery('')}
            >
              초기화
            </button>
          ) : null}
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gcal-border px-4 py-6 text-sm text-gcal-muted">
          표시할 회원 캘린더가 없습니다.
        </p>
      ) : filteredGroups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gcal-border px-4 py-6 text-sm text-gcal-muted">
          검색 결과가 없습니다.
        </p>
      ) : (
        <ul className="m-0 list-none space-y-5 p-0">
          {filteredGroups.map((group) => (
            <li key={group.ownerLoginId}>
              <h3 className="mb-2 text-sm font-medium text-gcal-heading">{group.ownerLoginId}</h3>
              <ul className="m-0 list-none divide-y divide-gcal-border-light overflow-hidden rounded-lg border border-gcal-border-light p-0">
                {group.calendars.map((calendar) => {
                  const isVisible = isCalendarVisible(calendar);
                  return (
                    <li
                      key={calendar.id}
                      className={cn(
                        'flex items-center justify-between gap-3 bg-gcal-surface px-3 py-2.5',
                        !isVisible && 'opacity-60',
                      )}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent p-0 text-left hover:text-gcal-blue"
                        onClick={() => onOpenCalendarSettings(calendar.id)}
                      >
                        <span
                          className="h-3.5 w-3.5 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]"
                          style={{ background: calendar.color ?? '#039be5' }}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 truncate text-sm text-gcal-heading">{calendar.name}</span>
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-gcal-muted transition-colors hover:bg-gcal-surface-2 hover:text-gcal-heading"
                        aria-label={isVisible ? '캘린더 숨기기' : '캘린더 보이기'}
                        onClick={(event) => {
                          // Same as MyCalendarsNavList — stopPropagation so the settings
                          // overlay's click-outside close cannot swallow the toggle.
                          event.stopPropagation();
                          onToggleCalendarVisibility(calendar.id);
                        }}
                      >
                        <EyeIcon open={isVisible} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MyCalendarsNavList({
  calendars,
  currentLoginId,
  activeCalendarId,
  activeSection,
  onOpenCalendarSettings,
  onToggleCalendarVisibility,
  onUpdateCalendar,
}) {
  const { alert } = useAppDialog();
  const [orderIds, setOrderIds] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [dropId, setDropId] = useState(null);
  const [busy, setBusy] = useState(false);

  const myCalendars = calendars.filter((calendar) => isMyCalendar(calendar, currentLoginId));

  const sorted = useMemo(() => {
    const base = sortCalendarsByOrder(myCalendars);
    if (!orderIds?.length) return base;
    const byId = new Map(base.map((calendar) => [calendar.id, calendar]));
    const ordered = [];
    for (const id of orderIds) {
      const calendar = byId.get(id);
      if (calendar) {
        ordered.push(calendar);
        byId.delete(id);
      }
    }
    for (const calendar of byId.values()) ordered.push(calendar);
    return ordered;
  }, [myCalendars, orderIds]);

  useEffect(() => {
    if (!orderIds?.length) return;
    const live = sortCalendarsByOrder(myCalendars).map((calendar) => calendar.id).join('\0');
    if (live === orderIds.join('\0')) setOrderIds(null);
  }, [myCalendars, orderIds]);

  if (myCalendars.length === 0) {
    return null;
  }

  const dragEnabled = Boolean(onUpdateCalendar);
  const canDrag = dragEnabled && !busy;

  const reorderCalendars = async (fromId, toId) => {
    if (!canDrag || !fromId || !toId || fromId === toId) return;
    const fromIndex = sorted.findIndex((calendar) => calendar.id === fromId);
    const toIndex = sorted.findIndex((calendar) => calendar.id === toId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const next = [...sorted];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    const nextIds = next.map((calendar) => calendar.id);
    setOrderIds(nextIds);
    setBusy(true);
    try {
      for (let i = 0; i < next.length; i += 1) {
        const calendar = next[i];
        if (calendar.sortOrder === i) continue;
        await onUpdateCalendar(calendar.id, { sortOrder: i });
      }
    } catch (err) {
      setOrderIds(null);
      await alert(err instanceof Error ? err.message : '캘린더 순서를 바꾸지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-2 pt-1">
      <ul className="space-y-0.5">
        {sorted.map((calendar) => {
          const isVisible = isCalendarVisible(calendar);
          const settingsActive =
            activeSection === 'calendar-settings' && activeCalendarId === calendar.id;
          const isDragging = dragId === calendar.id;
          const isDropTarget = dropId === calendar.id && dragId && dragId !== calendar.id;

          return (
            <li key={calendar.id}>
              <div
                className={cn(
                  'flex items-center gap-0.5 rounded-lg py-2 pl-2 pr-2 text-sm transition-colors',
                  settingsActive ? 'bg-gcal-blue-soft text-gcal-blue-dark' : 'text-gcal-heading',
                  !isVisible && !settingsActive && 'opacity-60',
                  isDragging && 'opacity-45',
                  isDropTarget && 'ring-1 ring-inset ring-gcal-blue bg-gcal-blue-soft/40',
                )}
                onDragOver={(e) => {
                  if (!canDrag || !dragId || dragId === calendar.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dropId !== calendar.id) setDropId(calendar.id);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget)) {
                    setDropId((current) => (current === calendar.id ? null : current));
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const fromId = e.dataTransfer.getData('text/plain') || dragId;
                  setDragId(null);
                  setDropId(null);
                  void reorderCalendars(fromId, calendar.id);
                }}
              >
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-8 w-5 shrink-0 items-center justify-center rounded text-gcal-muted',
                    !dragEnabled && 'opacity-0',
                    dragEnabled && (canDrag
                      ? 'cursor-grab hover:bg-gcal-surface-2 hover:text-gcal-heading active:cursor-grabbing'
                      : 'cursor-default opacity-40'),
                  )}
                  draggable={canDrag}
                  disabled={!canDrag}
                  tabIndex={canDrag ? 0 : -1}
                  title="끌어 순서 변경"
                  aria-label={`${calendar.name} 순서 변경`}
                  onDragStart={(e) => {
                    if (!canDrag) {
                      e.preventDefault();
                      return;
                    }
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', calendar.id);
                    setDragId(calendar.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropId(null);
                  }}
                >
                  <TagDragHandleIcon />
                </button>
                <button
                  type="button"
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left transition-colors',
                    settingsActive ? 'font-medium' : 'hover:text-gcal-blue',
                  )}
                  onClick={() => onOpenCalendarSettings(calendar.id)}
                >
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]"
                    style={{ background: calendar.color ?? '#039be5' }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-gcal-muted transition-colors hover:bg-gcal-surface-2 hover:text-gcal-heading"
                  aria-label={isVisible ? '캘린더 숨기기' : '캘린더 보이기'}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleCalendarVisibility(calendar.id);
                  }}
                >
                  <EyeIcon open={isVisible} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CalendarSettingsPanel({
  calendarId,
  calendars,
  store,
  onUpdateCalendar,
  onCreateCalendar,
  onAddEvent,
  onClearCalendarEvents,
  onDeleteCalendar,
  onImportIntoCalendar,
  onDeleted,
  onDuplicated,
}) {
  const { alert, confirm } = useAppDialog();
  const importInputRef = useRef(null);
  const calendar = calendars.find((item) => item.id === calendarId);
  const [name, setName] = useState(calendar?.name ?? '');
  const [description, setDescription] = useState(calendar?.description ?? '');
  const [color, setColor] = useState(calendar?.color ?? getDefaultCalendarColor(0));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    setName(calendar?.name ?? '');
    setDescription(calendar?.description ?? '');
    setColor(calendar?.color ?? getDefaultCalendarColor(0));
    setSaved(false);
  }, [calendar?.id, calendar?.name, calendar?.description, calendar?.color]);

  if (!calendar) return null;

  const isHolidaysKr = calendar.id === HOLIDAYS_KR_CALENDAR_ID;
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const isDirty =
    !isHolidaysKr
    && (trimmedName !== calendar.name
      || trimmedDescription !== (calendar.description ?? '')
      || color !== calendar.color);

  const handleSave = async () => {
    if (!trimmedName) {
      await alert('캘린더 이름을 입력해 주세요.');
      return;
    }
    if (!isDirty) return;

    const patch = {};
    if (trimmedName !== calendar.name) patch.name = trimmedName;
    if (trimmedDescription !== (calendar.description ?? '')) patch.description = trimmedDescription;
    if (color !== calendar.color) patch.color = color;

    setSaving(true);
    setSaved(false);
    try {
      await onUpdateCalendar(calendar.id, patch);
      setSaved(true);
    } catch (err) {
      await alert(err instanceof Error ? err.message : '캘린더 설정을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicate = async () => {
    setDuplicating(true);
    try {
      const existingNames = new Set(calendars.map((item) => item.name));
      let suffix = 1;
      let duplicateName = `${calendar.name} (${suffix})`;
      while (existingNames.has(duplicateName)) {
        suffix += 1;
        duplicateName = `${calendar.name} (${suffix})`;
      }

      const created = await onCreateCalendar({
        name: duplicateName,
        description: calendar.description ?? '',
        timezone: calendar.timezone,
        timezoneLabel: calendar.timezoneLabel,
        color: calendar.color,
        ownerName: calendar.ownerName,
        custom: true,
      });

      if (created?.id) {
        const sourceEvents = (store?.events ?? []).filter((event) => event.calendarId === calendar.id);
        for (const event of sourceEvents) {
          // eslint-disable-next-line no-await-in-loop -- events must land in creation order
          await onAddEvent({ ...eventToMutationPayload(event), calendarId: created.id });
        }
      }

      onDuplicated?.(created);
    } catch (err) {
      await alert(err instanceof Error ? err.message : '캘린더를 복사하지 못했습니다.');
    } finally {
      setDuplicating(false);
    }
  };

  const handleExportCalendar = async (format) => {
    try {
      const exportData = {
        calendar,
        events: (store?.events ?? []).filter((event) => event.calendarId === calendar.id),
      };
      const { content, filename, mimeType } = exportSingleCalendar(
        exportData,
        format,
        getJsonExportTimestamp(),
      );
      downloadCalendarFile(content, filename, mimeType);
      await alert(`「${calendar.name}」 캘린더를 ${format.toUpperCase()} 파일로 내보냈습니다.`, {
        title: '내보내기 완료',
      });
    } catch (err) {
      await alert(err instanceof Error ? err.message : '캘린더 내보내기에 실패했습니다.');
    }
  };

  const handleImportCalendar = async (event) => {
    const input = event.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !onImportIntoCalendar) return;

    setImporting(true);
    try {
      const text = await file.text();
      const format = detectCalendarFileFormat(file.name);
      const parsed = parseImportPayload(text, format, file.name);
      const events = extractEventsFromImportPayload(parsed);
      if (!events.length) {
        throw new Error('가져올 일정이 없습니다.');
      }
      const result = await onImportIntoCalendar(calendar.id, events);
      const count = result?.importedCount ?? events.length;
      await alert(
        `「${calendar.name}」에 일정 ${count}건을 가져왔습니다.`,
        { title: '가져오기 완료' },
      );
    } catch (err) {
      await alert(err instanceof Error ? err.message : '캘린더 가져오기에 실패했습니다.');
    } finally {
      setImporting(false);
    }
  };

  const handleClearCalendarEvents = async () => {
    const ok = await confirm('이 캘린더의 모든 일정이 삭제됩니다.', {
      variant: 'danger',
      confirmLabel: '초기화',
    });
    if (!ok) return;

    setClearing(true);
    try {
      await onClearCalendarEvents(calendar.id);
    } catch (err) {
      await alert(err instanceof Error ? err.message : '캘린더를 초기화하지 못했습니다.');
    } finally {
      setClearing(false);
    }
  };

  const handleDeleteCalendar = async () => {
    const ok = await confirm('이 캘린더의 모든 일정이 삭제됩니다.', {
      variant: 'danger',
      confirmLabel: '삭제',
    });
    if (!ok) return;

    setDeleting(true);
    try {
      await onDeleteCalendar(calendar.id);
      onDeleted?.();
    } catch (err) {
      await alert(err instanceof Error ? err.message : '캘린더를 삭제하지 못했습니다.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="w-full max-w-full text-left">
      <h2 className="mb-8 text-[22px] font-normal text-gcal-heading">캘린더 설정</h2>
      {isHolidaysKr && (
        <p className="mb-5 text-sm text-gcal-muted">
          이 캘린더의 일정은 설정 → 공휴일 동기화로만 갱신됩니다.
        </p>
      )}
      <div className="space-y-5">
        <div>
          <FieldLabel>일정 색상</FieldLabel>
          <CalendarColorPalette
            value={color}
            onChange={(nextColor) => {
              if (isHolidaysKr) return;
              setColor(nextColor);
              setSaved(false);
            }}
          />
        </div>

        <div className={fieldBoxClass}>
          <FieldLabel>이름</FieldLabel>
          <input
            className="w-full border-0 bg-transparent p-0 text-base text-gcal-heading outline-none disabled:opacity-70"
            value={name}
            disabled={isHolidaysKr}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
        </div>

        <div className={fieldBoxClass}>
          <FieldLabel>설명</FieldLabel>
          <textarea
            className="min-h-[88px] w-full resize-y border-0 bg-transparent p-0 text-base text-gcal-heading outline-none disabled:opacity-70"
            value={description}
            disabled={isHolidaysKr}
            onChange={(e) => {
              setDescription(e.target.value);
              setSaved(false);
            }}
            rows={3}
          />
        </div>
      </div>

      <div className="mt-8 space-y-3">
        {isHolidaysKr ? (
          <div className="flex flex-wrap gap-3">
            <CalendarFileFormatButton
              label="내보내기"
              mode="export"
              className="px-6 py-2.5 text-gcal-blue"
              onSelectFormat={(format) => void handleExportCalendar(format)}
            />
          </div>
        ) : (
          <div className="cal-actions-container">
            <div className="cal-settings-actions">
              <button
                type="button"
                style={{ gridArea: 'save' }}
                onClick={() => void handleSave()}
                disabled={saving || !isDirty || !trimmedName}
                className="rounded-full bg-gcal-blue px-6 py-2.5 text-sm font-medium text-white shadow-[0_1px_2px_rgba(26,115,232,0.35)] transition-colors hover:bg-[#1765cc] disabled:opacity-60"
              >
                {saving ? '저장 중…' : '저장'}
              </button>

              <button
                type="button"
                style={{ gridArea: 'copy' }}
                onClick={() => void handleDuplicate()}
                disabled={duplicating || saving || clearing || deleting}
                className="rounded-full border border-gcal-border bg-gcal-page px-6 py-2.5 text-sm font-medium text-gcal-heading transition-colors hover:bg-gcal-surface-2 disabled:opacity-60"
              >
                {duplicating ? '복사 중…' : '복사'}
              </button>

              <div style={{ gridArea: 'export' }}>
                <CalendarFileFormatButton
                  label="내보내기"
                  mode="export"
                  className="px-6 py-2.5 text-gcal-blue"
                  onSelectFormat={(format) => void handleExportCalendar(format)}
                />
              </div>

              <button
                type="button"
                style={{ gridArea: 'import' }}
                onClick={() => importInputRef.current?.click()}
                disabled={importing || clearing || deleting || duplicating || saving}
                className="rounded-full border border-gcal-border bg-gcal-page px-6 py-2.5 text-sm font-medium text-gcal-heading transition-colors hover:bg-gcal-surface-2 disabled:opacity-60"
              >
                {importing ? '가져오는 중…' : '가져오기'}
              </button>
              <input
                ref={importInputRef}
                type="file"
                className="hidden"
                accept={getAllImportAcceptAttribute()}
                onChange={(ev) => void handleImportCalendar(ev)}
              />

              <button
                type="button"
                style={{ gridArea: 'clear' }}
                onClick={() => void handleClearCalendarEvents()}
                disabled={clearing || deleting || duplicating || importing}
                className="rounded-full border border-[#f6aea9] bg-gcal-page px-6 py-2.5 text-sm font-medium text-[#c5221f] transition-colors hover:bg-[#fce8e6] disabled:opacity-60"
              >
                {clearing ? '초기화 중…' : '초기화'}
              </button>

              <button
                type="button"
                style={{ gridArea: 'delete' }}
                onClick={() => void handleDeleteCalendar()}
                disabled={clearing || deleting || duplicating || importing}
                className="rounded-full border border-[#f6aea9] bg-gcal-page px-6 py-2.5 text-sm font-medium text-[#c5221f] transition-colors hover:bg-[#fce8e6] disabled:opacity-60"
              >
                {deleting ? '삭제 중…' : '삭제'}
              </button>
            </div>
          </div>
        )}

        <p className="min-h-[1.25rem] text-sm text-gcal-muted">
          {saved && !saving ? '저장되었습니다.' : ''}
        </p>
      </div>
    </div>
  );
}

function ImportExportPanel({ store, onImport }) {
  const { alert } = useAppDialog();
  const importInputRef = useRef(null);
  const [statusMessage, setStatusMessage] = useState('');

  const handleExport = async (format) => {
    try {
      const { content, filename, mimeType } = exportFullStore(store, format, getJsonExportTimestamp());
      downloadCalendarFile(content, filename, mimeType);
      const message = `전체 캘린더를 ${format.toUpperCase()} 파일로 내보냈습니다.`;
      setStatusMessage(message);
      await alert(message, { title: '내보내기 완료' });
    } catch (err) {
      setStatusMessage('');
      await alert(err instanceof Error ? err.message : '내보내기에 실패했습니다.');
    }
  };

  const openImportPicker = () => {
    importInputRef.current?.click();
  };

  const handleImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const format = detectCalendarFileFormat(file.name);
    if (!format) {
      await alert('JSON, ICS, CSV 파일만 가져올 수 있습니다.');
      return;
    }

    try {
      const text = await file.text();
      const parsed = parseImportPayload(text, format, file.name);
      await onImport(parsed.kind === 'json' ? parsed.data : parsed.data);
      const message = `「${file.name}」 가져오기가 완료되었습니다.`;
      setStatusMessage(message);
      await alert(message, { title: '가져오기 완료' });
    } catch (err) {
      setStatusMessage('');
      const message =
        err instanceof Error && err.message
          ? err.message
          : '가져오기에 실패했습니다. 파일 형식을 확인해 주세요.';
      await alert(message);
    }
  };

  return (
    <div className="w-full max-w-full text-left">
      <h2 className="mb-8 text-[22px] font-normal text-gcal-heading">가져오기 / 내보내기</h2>
      <div className="space-y-4">
        <div className="rounded-lg border border-gcal-border bg-gcal-surface p-5">
          <h3 className="mb-2 text-base font-medium text-gcal-heading">가져오기</h3>
          <p className="mb-4 text-sm text-gcal-muted">
            JSON, ICS, CSV 파일을 불러옵니다. JSON 전체 내보내기·개별 캘린더 파일과 ICS/CSV는 기존 데이터에
            병합됩니다. 「대한민국의 휴일」은 동기화로만 갱신되며 가져오기로 덮어쓰지 않습니다.
          </p>
          <button
            type="button"
            className="rounded-full bg-gcal-blue px-5 py-2 text-sm font-medium text-white hover:bg-[#1765cc]"
            onClick={openImportPicker}
          >
            파일 선택
          </button>
          <input
            ref={importInputRef}
            type="file"
            className="hidden"
            accept={getAllImportAcceptAttribute()}
            onChange={handleImport}
          />
        </div>
        <div className="rounded-lg border border-gcal-border bg-gcal-surface p-5">
          <h3 className="mb-2 text-base font-medium text-gcal-heading">내보내기</h3>
          <p className="mb-4 text-sm text-gcal-muted">
            모든 캘린더와 일정을 JSON, ICS, CSV 형식으로 저장합니다.
          </p>
          <CalendarFileFormatButton label="내보내기" mode="export" onSelectFormat={(format) => void handleExport(format)} />
        </div>
        {statusMessage ? (
          <p className="rounded-lg border border-[#ceead6] bg-[#e6f4ea] px-4 py-3 text-sm text-[#137333]">
            {statusMessage}
          </p>
        ) : null}
        <div className="rounded-lg border border-gcal-border bg-gcal-surface p-5">
          <h3 className="mb-4 text-base font-medium text-gcal-heading">파일 형식 안내</h3>
          <div className="space-y-2.5 text-sm text-gcal-muted">
            <p>
              <span className="font-medium text-gcal-heading">JSON</span>
              {' '}
              — 이 앱 전용 백업 형식입니다. 캘린더·일정·설정을 그대로 저장하고, 나중에 이 앱에서
              다시 불러올 수 있습니다.
            </p>
            <p>
              <span className="font-medium text-gcal-heading">ICS</span>
              {' '}
              — iCalendar 표준 형식입니다. Google Calendar, Outlook 등 다른 캘린더 앱으로
              가져와 사용할 수 있습니다.
            </p>
            <p>
              <span className="font-medium text-gcal-heading">CSV</span>
              {' '}
              — 표 형식 파일입니다. Google Calendar 가져오기나 Excel에서 열어 확인·편집하기에
              적합합니다.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SettingsPanel({
  open,
  onClose,
  store,
  settings,
  ownerName,
  calendars,
  currentLoginId = '',
  isSuperAdmin = false,
  onCreateCalendar,
  onAddEvent,
  onUpdateCalendar,
  onClearCalendarEvents,
  onDeleteCalendar,
  onCreateTag,
  onUpdateTag,
  onDeleteTag,
  onImportStore,
  onImportIntoCalendar,
  onSaveSettings,
  onToggleCalendarVisibility,
  onSyncHolidays,
}) {
  const [section, setSection] = useState('general');
  const [selectedCalendarId, setSelectedCalendarId] = useState(null);

  useEffect(() => {
    if (isSuperAdmin) return;
    if (
      section === 'import-export'
      || section === 'security'
      || section === 'members'
      || section === 'holidays'
      || section === 'member-calendars'
    ) {
      setSection('general');
    }
  }, [isSuperAdmin, section]);

  const handleToggleCalendarVisibility = useCallback(
    (calendarId) => {
      const calendar = calendars.find((item) => item.id === calendarId);
      if (!calendar) return;
      void onToggleCalendarVisibility(calendarId, !isCalendarVisible(calendar));
    },
    [calendars, onToggleCalendarVisibility],
  );

  const handleOpenCalendarSettings = (calendarId) => {
    setSelectedCalendarId(calendarId);
    setSection('calendar-settings');
  };

  const handleCalendarCreated = useCallback((created) => {
    if (created?.id) {
      setSelectedCalendarId(created.id);
      setSection('calendar-settings');
      return;
    }
    setSection('general');
  }, []);

  const handleCalendarDeleted = () => {
    setSelectedCalendarId(null);
    setSection('general');
  };

  useEffect(() => {
    if (open) {
      setSection('general');
      setSelectedCalendarId(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Keep settings below title bar + Excel/PDF row; cover the period row (e.g. 2026년 7월).
  const measureChromeOffset = () => {
    let bottom = 0;
    for (const role of ['titlebar', 'header-actions']) {
      const el = document.querySelector(`[data-shell-chrome="${role}"]`);
      if (!el) continue;
      bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
    }
    if (bottom <= 0) {
      const header = document.querySelector('[data-shell-chrome="header"]');
      if (header) bottom = header.getBoundingClientRect().bottom;
    }
    return Math.max(0, Math.ceil(bottom));
  };

  const overlayRef = useRef(null);
  // Single-stage render (like SearchPanel): compute the offset synchronously during
  // render instead of via state+effect, so dim backdrop and panel appear together on
  // the very first paint — no separate "dim first, panel a beat later" pop-in.
  const [, forceRemeasure] = useState(0);
  useEffect(() => {
    if (!open) return undefined;
    const onResize = () => forceRemeasure((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);
  const chromeOffset = open ? measureChromeOffset() : 0;

  // Trap wheel on the overlay so it cannot scroll the calendar underneath.
  useEffect(() => {
    if (!open) return undefined;
    const root = overlayRef.current;
    if (!root) return undefined;

    const onWheel = (event) => {
      const scrollable = event.target instanceof Element
        ? event.target.closest('.settings-scroll')
        : null;
      if (scrollable instanceof HTMLElement) {
        const { scrollTop, scrollHeight, clientHeight } = scrollable;
        const atTop = scrollTop <= 0;
        const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
        if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom) || scrollHeight <= clientHeight) {
          event.preventDefault();
        }
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [open]);

  if (!open) return null;

  // Defer unmount so the same click cannot retarget to header PDF/Excel underneath.
  const requestClose = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    window.setTimeout(() => onClose(), 0);
  };

  // Transparent click-outside layer (no backdrop dim) — same feel as the day
  // quick-edit popover's own backdrop, per user request.
  return (
    <div
      className="fixed inset-0 z-[55]"
      onClick={requestClose}
      role="presentation"
    >
      <div
        ref={overlayRef}
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[56] flex justify-center pb-[2.5%]"
        style={{ top: chromeOffset }}
        role="presentation"
      >
      <div
        className="shell-solid-surface pointer-events-auto relative z-[1] flex h-full w-[77%] min-h-0 overflow-hidden rounded-xl shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="absolute right-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full text-gcal-muted transition-colors hover:bg-gcal-surface-2 hover:text-gcal-heading"
          onClick={requestClose}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="설정 닫기"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
            />
          </svg>
        </button>
        <aside
          className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-gcal-border-light py-4"
          style={{ backgroundColor: 'var(--gcal-page-solid)' }}
        >
          <nav className="settings-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pt-2">
            <button
              type="button"
              className={cn(
                'w-full rounded-lg px-4 py-2.5 text-left text-sm font-medium transition-colors',
                section === 'general' ? 'bg-gcal-blue-soft text-gcal-blue-dark' : 'text-gcal-heading hover:bg-gcal-surface',
              )}
              onClick={() => setSection('general')}
            >
              일반
            </button>
            <button
              type="button"
              className={cn(
                'w-full rounded-lg px-4 py-2.5 text-left text-sm font-medium transition-colors',
                section === 'add-calendar' ? 'bg-gcal-blue-soft text-gcal-blue-dark' : 'text-gcal-heading hover:bg-gcal-surface',
              )}
              onClick={() => setSection('add-calendar')}
            >
              새 캘린더 만들기
            </button>
            {isSuperAdmin ? (
              <button
                type="button"
                className={cn(
                  'w-full rounded-lg px-4 py-2.5 text-left text-sm font-medium transition-colors',
                  section === 'import-export' ? 'bg-gcal-blue-soft text-gcal-blue-dark' : 'text-gcal-heading hover:bg-gcal-surface',
                )}
                onClick={() => setSection('import-export')}
              >
                가져오기 / 내보내기
              </button>
            ) : null}
            <button
              type="button"
              className={cn(
                'w-full rounded-lg px-4 py-2.5 text-left text-sm font-medium transition-colors',
                section === 'tags' ? 'bg-gcal-blue-soft text-gcal-blue-dark' : 'text-gcal-heading hover:bg-gcal-surface',
              )}
              onClick={() => setSection('tags')}
            >
              태그 관리
            </button>
            {isSuperAdmin ? (
              <>
                <button
                  type="button"
                  className={cn(
                    'w-full rounded-lg px-4 py-2.5 text-left text-sm font-medium transition-colors',
                    section === 'security' ? 'bg-gcal-blue-soft text-gcal-blue-dark' : 'text-gcal-heading hover:bg-gcal-surface',
                  )}
                  onClick={() => setSection('security')}
                >
                  보안 관리
                </button>
                <button
                  type="button"
                  className={cn(
                    'w-full rounded-lg px-4 py-2.5 text-left text-sm font-medium transition-colors',
                    section === 'members' ? 'bg-gcal-blue-soft text-gcal-blue-dark' : 'text-gcal-heading hover:bg-gcal-surface',
                  )}
                  onClick={() => setSection('members')}
                >
                  회원 관리
                </button>
                <button
                  type="button"
                  className={cn(
                    'w-full rounded-lg px-4 py-2.5 text-left text-sm font-medium transition-colors',
                    section === 'member-calendars'
                      ? 'bg-gcal-blue-soft text-gcal-blue-dark'
                      : 'text-gcal-heading hover:bg-gcal-surface',
                  )}
                  onClick={() => setSection('member-calendars')}
                >
                  회원 캘린더 관리
                </button>
                <button
                  type="button"
                  className={cn(
                    'w-full rounded-lg px-4 py-2.5 text-left text-sm font-medium transition-colors',
                    section === 'holidays' ? 'bg-gcal-blue-soft text-gcal-blue-dark' : 'text-gcal-heading hover:bg-gcal-surface',
                  )}
                  onClick={() => setSection('holidays')}
                >
                  대한민국의 휴일(공공데이터 API)
                </button>
              </>
            ) : null}

            <div className="my-3" aria-hidden="true" />

            <p className="px-4 text-sm font-medium text-gcal-heading">내 캘린더</p>
            <MyCalendarsNavList
              calendars={calendars}
              currentLoginId={currentLoginId}
              activeCalendarId={selectedCalendarId}
              activeSection={section}
              onOpenCalendarSettings={handleOpenCalendarSettings}
              onToggleCalendarVisibility={handleToggleCalendarVisibility}
              onUpdateCalendar={onUpdateCalendar}
            />

            <p className="mt-4 px-4 text-sm font-medium text-gcal-heading">고정 캘린더</p>
            <SharedCalendarsNavList
              calendars={calendars}
              activeCalendarId={selectedCalendarId}
              activeSection={section}
              onOpenCalendarSettings={handleOpenCalendarSettings}
              onToggleCalendarVisibility={handleToggleCalendarVisibility}
            />
          </nav>
        </aside>

        <div className="settings-scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-8 py-8 pr-14 text-left md:px-10 md:pr-14">
          {section === 'general' && (
            <ViewOptionsPanel settings={settings} onSaveSettings={onSaveSettings} />
          )}
          {section === 'add-calendar' && (
            <CreateCalendarForm
              ownerName={ownerName}
              settings={settings}
              calendars={calendars}
              onCreateCalendar={onCreateCalendar}
              onDone={handleCalendarCreated}
            />
          )}
          {isSuperAdmin && section === 'import-export' && (
            <ImportExportPanel store={store} onImport={onImportStore} />
          )}
          {section === 'tags' && (
            <TagsPanel
              tags={store?.tags ?? []}
              onCreateTag={onCreateTag}
              onUpdateTag={onUpdateTag}
              onDeleteTag={onDeleteTag}
            />
          )}
          {isSuperAdmin && section === 'security' && (
            <SecurityPanel settings={settings} onSaveSettings={onSaveSettings} />
          )}
          {isSuperAdmin && section === 'members' && <MembersPanel />}
          {isSuperAdmin && section === 'holidays' && (
            <HolidaysSyncPanel
              settings={settings}
              onSyncHolidays={onSyncHolidays}
              onSaveSettings={onSaveSettings}
            />
          )}
          {isSuperAdmin && section === 'member-calendars' && (
            <MemberCalendarsPanel
              calendars={calendars}
              currentLoginId={currentLoginId}
              onOpenCalendarSettings={handleOpenCalendarSettings}
              onToggleCalendarVisibility={handleToggleCalendarVisibility}
            />
          )}
          {section === 'calendar-settings' && (
            <CalendarSettingsPanel
              calendarId={selectedCalendarId}
              calendars={calendars}
              store={store}
              onUpdateCalendar={onUpdateCalendar}
              onCreateCalendar={onCreateCalendar}
              onAddEvent={onAddEvent}
              onClearCalendarEvents={onClearCalendarEvents}
              onDeleteCalendar={onDeleteCalendar}
              onImportIntoCalendar={onImportIntoCalendar}
              onDeleted={handleCalendarDeleted}
              onDuplicated={handleCalendarCreated}
            />
          )}
        </div>
      </div>
    </div>
    </div>
  );
}
