import { useEffect, useMemo, useRef, useState } from 'react';
import { HOLIDAYS_KR_CALENDAR_ID } from '../../shared/constants.js';
import { toDateKey } from '../lib/calendarUtils.js';
import { getCalendarTheme } from '../lib/colors.js';
import { insertTextAtCursor } from '../lib/insertAtCursor.js';
import {
  appendEventLink,
  getEventLinks,
  getPrimaryEventLinkUrl,
  normalizeEventLinkUrl,
  normalizeEventLinksArray,
} from '../../shared/eventLinks.js';
import { normalizeTagIds } from '../../shared/eventTags.js';
import { formatFileSize } from '../lib/formatFileSize.js';
import {
  addEventAttachments,
  openEventAttachment,
  removeEventAttachment,
} from '../lib/api.js';
import { isNativeHost } from '../lib/nativeHost.js';
import { openExternalUrl } from '../lib/openExternal.js';
import { useAppDialog } from './AppDialogProvider.jsx';
import EmojiPickerButton from './EmojiPickerButton.jsx';
import EventMarkerShapeButton from './EventMarkerShapeButton.jsx';
import QuickEditCalendarButton from './QuickEditCalendarButton.jsx';
import QuickEditTagButton from './QuickEditTagButton.jsx';

const fieldClass =
  'rounded border border-gcal-border bg-gcal-page px-2.5 py-2 text-gcal-heading placeholder:text-gcal-muted focus:border-gcal-blue focus:outline-none focus:ring-2 focus:ring-gcal-blue/15';

const timeFieldClass =
  'h-9 rounded border-0 bg-gcal-input px-2.5 text-gcal-heading focus:bg-gcal-surface-2 focus:outline-none focus:ring-2 focus:ring-gcal-blue/15';

/** Same width for 바로가기 [추가] and 첨부파일 [파일 선택]. */
const sideActionBtnClass =
  'inline-flex h-9 w-[5.25rem] shrink-0 items-center justify-center rounded border border-gcal-border bg-gcal-page px-2 text-sm font-medium text-gcal-heading hover:bg-gcal-surface-2 disabled:cursor-not-allowed disabled:opacity-40';

const DEFAULT_START_TIME = '09:00';
const DEFAULT_END_TIME = '10:00';

const REPEAT_OPTIONS = [
  { value: 'none', label: '반복 안함' },
  { value: 'daily', label: '매일' },
  { value: 'weekly', label: '매주' },
  { value: 'monthly', label: '매월' },
  { value: 'yearly', label: '매년' },
  { value: 'lunar-monthly', label: '음력 매월' },
  { value: 'lunar-yearly', label: '음력 매년' },
  { value: 'weekdays', label: '주중(월~금)' },
];

const REPEAT_END_OPTIONS = [
  { value: 'never', label: '계속 반복' },
  { value: 'until', label: '종료일' },
  { value: 'count', label: '횟수' },
];

function getEditableCalendars(calendars) {
  return (calendars ?? []).filter((calendar) => calendar.id !== HOLIDAYS_KR_CALENDAR_ID);
}

function getDefaultCalendarId(calendars) {
  const editable = getEditableCalendars(calendars);
  if (!editable.length) return 'primary';
  return editable.find((calendar) => calendar.visible !== false)?.id ?? editable[0].id;
}

function resolveRepeatEndMode(event) {
  if (!event || (event.repeat ?? 'none') === 'none') return 'never';
  if (event.repeatUntil) return 'until';
  if (event.repeatCount) return 'count';
  return 'never';
}

export default function EventEditor({
  open,
  event,
  calendars,
  tags = [],
  defaultDate,
  onClose,
  onSave,
  onDelete,
  onEventRefresh,
}) {
  const { alert, confirm } = useAppDialog();
  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [allDay, setAllDay] = useState(true);
  const [startTime, setStartTime] = useState(DEFAULT_START_TIME);
  const [endTime, setEndTime] = useState(DEFAULT_END_TIME);
  const [repeat, setRepeat] = useState('none');
  const [repeatEndMode, setRepeatEndMode] = useState('never');
  const [repeatUntil, setRepeatUntil] = useState('');
  const [repeatCount, setRepeatCount] = useState('10');
  const [description, setDescription] = useState('');
  const [links, setLinks] = useState([]);
  const [linkDraft, setLinkDraft] = useState('');
  const [calendarId, setCalendarId] = useState(() => getDefaultCalendarId(calendars));
  const [markerShape, setMarkerShape] = useState(null);
  const [tagIds, setTagIds] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const titleInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;

    if (event) {
      setTitle(event.title ?? '');
      setStartDate(event.startDate ?? toDateKey(defaultDate ?? new Date()));
      setEndDate(event.endDate ?? event.startDate ?? toDateKey(defaultDate ?? new Date()));
      setAllDay(event.allDay ?? true);
      setStartTime(event.startTime ?? DEFAULT_START_TIME);
      setEndTime(event.endTime ?? DEFAULT_END_TIME);
      setRepeat(event.repeat ?? 'none');
      setRepeatEndMode(resolveRepeatEndMode(event));
      setRepeatUntil(event.repeatUntil ?? event.startDate ?? '');
      setRepeatCount(String(event.repeatCount ?? 10));
      setDescription(event.description ?? '');
      setLinks(getEventLinks(event));
      setLinkDraft('');
      setCalendarId(
        event.calendarId && event.calendarId !== HOLIDAYS_KR_CALENDAR_ID
          ? event.calendarId
          : getDefaultCalendarId(calendars),
      );
      setMarkerShape(event.markerShape ?? null);
      setTagIds(normalizeTagIds(event.tagIds));
      setAttachments(Array.isArray(event.attachments) ? event.attachments : []);
      return;
    }

    setTitle('');
    setDescription('');
    setTagIds([]);
    setLinks([]);
    setLinkDraft('');
    setAllDay(true);
    setStartTime(DEFAULT_START_TIME);
    setEndTime(DEFAULT_END_TIME);
    setRepeat('none');
    setRepeatEndMode('never');
    setRepeatUntil('');
    setRepeatCount('10');
    setCalendarId(getDefaultCalendarId(calendars));
    setMarkerShape(null);
    setAttachments([]);
  }, [open, event, calendars, defaultDate]);

  useEffect(() => {
    if (!open || !event?.id) return;
    setAttachments(Array.isArray(event.attachments) ? event.attachments : []);
  }, [open, event?.id, event?.attachments]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const input = titleInputRef.current;
      if (!input) return;
      input.focus();
      // Edit: select title text block (same as previous desktop project).
      // Create: focus empty field ready to type.
      if (event) {
        input.select();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, event]);

  useEffect(() => {
    if (!open || event) return;
    const base = defaultDate ? toDateKey(defaultDate) : toDateKey(new Date());
    setStartDate(base);
    setEndDate(base);
    setRepeatUntil(base);
  }, [open, event, defaultDate]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const editableCalendars = useMemo(() => getEditableCalendars(calendars), [calendars]);
  const selectedCalendar = editableCalendars.find((c) => c.id === calendarId)
    ?? calendars?.find((c) => c.id === calendarId);
  const calendarTheme = useMemo(
    () => getCalendarTheme(selectedCalendar?.color ?? '#039be5'),
    [selectedCalendar?.color],
  );
  const showRepeatEnd = repeat !== 'none';
  const canAttach = Boolean(event?.id) && isNativeHost();
  const attachmentNames = attachments.map((item) => item.name).filter(Boolean).join(', ');

  if (!open) return null;

  const applyAttachmentResult = (updated) => {
    const next = Array.isArray(updated?.attachments) ? updated.attachments : [];
    setAttachments(next);
    onEventRefresh?.(updated);
  };

  const handleAddAttachments = async () => {
    if (!event?.id || attachBusy) return;
    if (!isNativeHost()) {
      await alert('파일 첨부는 데스크톱 앱에서만 사용할 수 있습니다.');
      return;
    }
    setAttachBusy(true);
    try {
      const updated = await addEventAttachments(event.id);
      applyAttachmentResult(updated);
    } catch (err) {
      await alert(err instanceof Error ? err.message : '파일을 첨부하지 못했습니다.');
    } finally {
      setAttachBusy(false);
    }
  };

  const handleRemoveAttachment = async (attachmentId) => {
    if (!event?.id || !attachmentId || attachBusy) return;
    const ok = await confirm('이 첨부 파일을 삭제할까요?', {
      variant: 'danger',
      confirmLabel: '삭제',
    });
    if (!ok) return;
    setAttachBusy(true);
    try {
      const updated = await removeEventAttachment(event.id, attachmentId);
      applyAttachmentResult(updated);
    } catch (err) {
      await alert(err instanceof Error ? err.message : '첨부 파일을 삭제하지 못했습니다.');
    } finally {
      setAttachBusy(false);
    }
  };

  const handleOpenAttachment = async (attachmentId) => {
    if (!event?.id || !attachmentId) return;
    try {
      await openEventAttachment(event.id, attachmentId);
    } catch (err) {
      await alert(err instanceof Error ? err.message : '첨부 파일을 열지 못했습니다.');
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const normalizedEndDate = endDate < startDate ? startDate : endDate;
    let normalizedEndTime = endTime;
    if (!allDay && startDate === normalizedEndDate && endTime < startTime) {
      normalizedEndTime = startTime;
    }

    const parsedCount = Math.max(1, Number.parseInt(repeatCount, 10) || 1);
    const normalizedUntil = repeatUntil && repeatUntil < startDate ? startDate : repeatUntil;

    const payload = {
      id: event?.id,
      title,
      startDate,
      endDate: normalizedEndDate,
      allDay,
      startTime: allDay ? null : startTime,
      endTime: allDay ? null : normalizedEndTime,
      repeat,
      repeatUntil: showRepeatEnd && repeatEndMode === 'until' ? normalizedUntil : null,
      repeatCount: showRepeatEnd && repeatEndMode === 'count' ? parsedCount : null,
      exdates: Array.isArray(event?.exdates) ? event.exdates : [],
      description,
      links: normalizeEventLinksArray(links),
      link: getPrimaryEventLinkUrl({ links }),
      location: event?.location ?? '',
      calendarId,
      guests: event?.guests ?? [],
      color: event?.color ?? null,
      completed: Boolean(event?.completed),
      markerShape,
      tagIds: normalizeTagIds(tagIds),
      sortOrder: typeof event?.sortOrder === 'number' && Number.isFinite(event.sortOrder)
        ? event.sortOrder
        : null,
    };

    onSave(payload);
  };

  const handleDelete = async () => {
    if (!event?.id || !onDelete) return;
    const ok = await confirm('이 일정을 정말 삭제하시겠습니까?', {
      variant: 'danger',
      confirmLabel: '삭제',
    });
    if (ok) onDelete(event);
  };

  const insertTitleEmoji = (emoji) => {
    const el = titleInputRef.current;
    const { nextValue, nextPos } = insertTextAtCursor(el, title, emoji);
    setTitle(nextValue);
    // Restore caret after React commits the new value to the input.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(nextPos, nextPos);
    });
  };

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center overflow-y-auto bg-[rgba(32,33,36,0.28)] p-4"
      role="presentation"
      onClick={onClose}
    >
      <form
        className="settings-scroll shell-solid-surface relative z-30 my-auto w-[min(720px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-auto rounded-lg shadow-g-lg"
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        aria-modal="true"
        role="dialog"
      >
        <div className="h-1" style={{ background: calendarTheme.base }} />

        <div className="flex items-center gap-3 border-b border-gcal-border-light px-[18px] py-3.5">
          <div className="flex shrink-0 items-center gap-1">
            <EmojiPickerButton
              title="이모지 추가"
              buttonClassName="event-editor-toolbar-trigger event-editor-emoji-trigger"
              onSelect={insertTitleEmoji}
            />
            <EventMarkerShapeButton
              buttonClassName="event-editor-toolbar-trigger event-editor-shape-trigger"
              value={markerShape}
              color={selectedCalendar?.color ?? calendarTheme.base}
              onChange={setMarkerShape}
            />
            <QuickEditCalendarButton
              calendars={calendars}
              value={calendarId}
              buttonClassName="event-editor-toolbar-trigger"
              onChange={setCalendarId}
            />
            <QuickEditTagButton
              tags={tags}
              value={tagIds}
              buttonClassName="event-editor-toolbar-trigger"
              onChange={setTagIds}
            />
          </div>
          <input
            ref={titleInputRef}
            className="min-w-0 flex-1 border-0 bg-transparent text-[22px] text-gcal-heading outline-none placeholder:text-gcal-muted"
            placeholder="일정 추가 및 시간 설정"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="submit"
              className="event-editor-action-btn"
              aria-label="저장"
              title="저장"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"
                />
              </svg>
            </button>
            {event?.id && onDelete && (
              <button
                type="button"
                className="event-editor-action-btn"
                onClick={() => void handleDelete()}
                aria-label="삭제"
                title="삭제"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
                  />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="event-editor-action-btn"
              onClick={onClose}
              aria-label="닫기"
              title="닫기"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 border-b border-gcal-border-light bg-gcal-surface px-[18px] py-4">
          <div className="flex flex-nowrap items-center justify-start gap-2.5">
            {allDay ? (
              <>
                <input type="date" className={fieldClass} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                <span>~</span>
                <input type="date" className={fieldClass} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </>
            ) : (
              <>
                <input type="date" className={fieldClass} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                <input
                  type="time"
                  className={timeFieldClass}
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  aria-label="시작 시간"
                />
                <span className="text-gcal-muted">-</span>
                <input
                  type="time"
                  className={timeFieldClass}
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  aria-label="종료 시간"
                />
                <input type="date" className={fieldClass} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <label className="inline-flex items-center gap-1.5 text-gcal-body">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
              />
              종일
            </label>
            <select
              className={fieldClass}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              aria-label="반복"
            >
              {REPEAT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {showRepeatEnd && (
              <>
                <select
                  className={fieldClass}
                  value={repeatEndMode}
                  onChange={(e) => setRepeatEndMode(e.target.value)}
                  aria-label="반복 종료"
                >
                  {REPEAT_END_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {repeatEndMode === 'until' && (
                  <input
                    type="date"
                    className={fieldClass}
                    value={repeatUntil || startDate}
                    min={startDate}
                    onChange={(e) => setRepeatUntil(e.target.value)}
                    aria-label="반복 종료일"
                  />
                )}
                {repeatEndMode === 'count' && (
                  <label className="inline-flex items-center gap-1.5 text-sm text-gcal-body">
                    <input
                      type="number"
                      min={1}
                      max={999}
                      className={`${fieldClass} w-20`}
                      value={repeatCount}
                      onChange={(e) => setRepeatCount(e.target.value)}
                      aria-label="반복 횟수"
                    />
                    회
                  </label>
                )}
              </>
            )}
          </div>
        </div>

        <div className="px-[18px] py-4">
          <div className="mb-3.5 flex items-start gap-2 text-sm text-gcal-muted">
            <span className="w-16 shrink-0 pt-2">바로가기</span>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="url"
                  className={cnField(fieldClass, 'min-w-0 flex-1')}
                  value={linkDraft}
                  onChange={(e) => setLinkDraft(e.target.value)}
                  placeholder="https://example.com"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const url = normalizeEventLinkUrl(linkDraft);
                    if (!url) return;
                    setLinks((prev) => appendEventLink(prev, url));
                    setLinkDraft('');
                  }}
                />
                <button
                  type="button"
                  className={sideActionBtnClass}
                  disabled={!normalizeEventLinkUrl(linkDraft)}
                  onClick={() => {
                    const url = normalizeEventLinkUrl(linkDraft);
                    if (!url) return;
                    setLinks((prev) => appendEventLink(prev, url));
                    setLinkDraft('');
                  }}
                >
                  추가
                </button>
              </div>
              {links.length > 0 && (
                <ul className="m-0 list-none space-y-1 p-0">
                  {links.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center gap-2 rounded border border-gcal-border-light bg-gcal-page px-2 py-1.5"
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-gcal-heading hover:underline"
                        title="바로가기 열기"
                        onClick={() => void openExternalUrl(item.url)}
                      >
                        {item.title || item.url}
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-[#c5221f] hover:bg-[#fce8e6]"
                        onClick={() => setLinks((prev) => prev.filter((row) => row.id !== item.id))}
                      >
                        삭제
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="mb-3.5 flex items-start gap-2 text-sm text-gcal-muted">
            <span className="w-16 shrink-0 pt-2">첨부파일</span>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className={cnField(fieldClass, 'min-w-0 flex-1')}
                  value={attachmentNames}
                  readOnly
                  placeholder={
                    event?.id
                      ? (canAttach ? '첨부된 파일이 없습니다' : '데스크톱 앱에서 첨부할 수 있습니다')
                      : '일정을 저장한 뒤 파일을 첨부할 수 있습니다'
                  }
                  onClick={() => {
                    if (canAttach && !attachBusy) void handleAddAttachments();
                  }}
                />
                <button
                  type="button"
                  className={sideActionBtnClass}
                  disabled={!canAttach || attachBusy}
                  onClick={() => void handleAddAttachments()}
                >
                  파일 선택
                </button>
              </div>
              {attachments.length > 0 && (
                <ul className="m-0 list-none space-y-1 p-0">
                  {attachments.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center gap-2 rounded border border-gcal-border-light bg-gcal-page px-2 py-1.5"
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-gcal-heading hover:underline"
                        title="첨부 파일 열기"
                        onClick={() => void handleOpenAttachment(item.id)}
                      >
                        {item.name || '(파일)'}
                        {item.size != null ? (
                          <span className="ml-1.5 text-xs text-gcal-muted">{formatFileSize(item.size)}</span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-[#c5221f] hover:bg-[#fce8e6] disabled:opacity-40"
                        disabled={attachBusy}
                        onClick={() => void handleRemoveAttachment(item.id)}
                      >
                        삭제
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <label className="mb-1 flex flex-col gap-1.5 text-sm text-gcal-muted">
            설명
            <textarea
              className={fieldClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="설명 추가"
              rows={5}
            />
          </label>
        </div>
      </form>
    </div>
  );
}

function cnField(...parts) {
  return parts.filter(Boolean).join(' ');
}
