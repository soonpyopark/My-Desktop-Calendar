import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HOLIDAYS_KR_CALENDAR_ID } from '../../shared/constants.js';
import { getDefaultCalendarId } from '../../shared/calendarOrder.js';
import { expandEventsForRange, getSeriesId } from '../../shared/eventOccurrences.js';
import { toDateKey } from '../lib/calendarUtils.js';
import { clampRectToViewport } from '../lib/popoverPosition.js';
import { compareEventsForDayDisplay, formatEventBarLabel } from '../lib/eventFormat.js';
import { formatDayHeaderTitle } from '../lib/dayHeaderFormat.js';
import { insertTextAtCursor } from '../lib/insertAtCursor.js';
import {
  getEventLinks,
  getPrimaryEventLinkUrl,
  normalizeEventLinksArray,
} from '../../shared/eventLinks.js';
import { normalizeTagIds } from '../../shared/eventTags.js';
import { cn } from '../lib/cn.js';
import DayColorPalette from './DayColorPalette.jsx';
import EmojiPickerButton from './EmojiPickerButton.jsx';
import EventAccentGlyph from './EventAccentGlyph.jsx';
import EventAttachButton from './EventAttachButton.jsx';
import EventAttachIcon from './EventAttachIcon.jsx';
import EventLinkButton from './EventLinkButton.jsx';
import EventLinkIcon from './EventLinkIcon.jsx';
import EventMarkerShapeButton from './EventMarkerShapeButton.jsx';
import EventTagIcons from './EventTagIcons.jsx';
import QuickEditCalendarButton from './QuickEditCalendarButton.jsx';
import QuickEditTagButton from './QuickEditTagButton.jsx';

const COLOR_PANEL_PAD = 8;
const COLOR_PANEL_FALLBACK_WIDTH = 120;
const COLOR_PANEL_FALLBACK_HEIGHT = 240;

/** Header + footer chrome around the body (matches CSS padding/borders roughly). */
const QUICK_EDIT_CHROME_HEIGHT = 88;
/** Month view only: extra body height beyond the day-cell. */
const QUICK_EDIT_BODY_EXTRA_MONTH = 96;

function buildQuickEditStyle(anchorRect, { bodyExtra = 0 } = {}) {
  if (!anchorRect) return null;
  const padX = 12;
  const width = Math.max(anchorRect.width + padX * 2, 300);
  // Week/year: match cell height. Month: a bit taller so more events fit.
  const bodyHeight = Math.max(Math.round(anchorRect.height) + bodyExtra, bodyExtra > 0 ? 160 : 72);
  const height = bodyHeight + QUICK_EDIT_CHROME_HEIGHT;
  const left = anchorRect.left + anchorRect.width / 2 - width / 2;
  const top = anchorRect.top + anchorRect.height / 2 - height / 2;
  const clamped = clampRectToViewport({ top, left, width, height, padding: 8 });
  return {
    top: clamped.top,
    left: clamped.left,
    width: clamped.width,
    height: clamped.maxHeight,
    maxHeight: clamped.maxHeight,
    '--day-quick-edit-body-height': `${bodyHeight}px`,
  };
}

/**
 * 날짜 칸 퀵 편집 초안.
 */
export default function DayQuickEditPopover({
  date,
  dayKey,
  events = [],
  calendars,
  tags = [],
  dayColor,
  anchorRect,
  focusEvent = null,
  canEdit = true,
  /** When true (month view), grow taller than the day cell. */
  expandBody = false,
  onClose,
  onCreate,
  onToggleCompleted,
  onDayColorChange,
  onEventMarkerShapeChange,
  onEventLinkChange,
  onEventCalendarChange,
  onEventTagChange,
  onOpenMore,
  onReorderEvents,
  onAttachFiles,
}) {
  const [title, setTitle] = useState('');
  const [draftLinks, setDraftLinks] = useState([]);
  const [draftCalendarId, setDraftCalendarId] = useState(
    () => getDefaultCalendarId(calendars, HOLIDAYS_KR_CALENDAR_ID),
  );
  const [draftTagIds, setDraftTagIds] = useState([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteStyle, setPaletteStyle] = useState(null);
  const [saving, setSaving] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(focusEvent);
  /** @type {string[] | null} optimistic series-id order for non-holiday rows */
  const [orderOverride, setOrderOverride] = useState(null);
  const [dragSeriesId, setDragSeriesId] = useState(null);
  const [dropSeriesId, setDropSeriesId] = useState(null);
  const inputRef = useRef(null);
  const colorTriggerRef = useRef(null);
  const colorPanelRef = useRef(null);
  const resolvedDayKey = dayKey || (date ? toDateKey(date) : '');

  const storeDayEvents = useMemo(() => {
    if (!resolvedDayKey) return [];
    return expandEventsForRange(events, resolvedDayKey, resolvedDayKey)
      .slice()
      .sort((a, b) => compareEventsForDayDisplay(a, b, resolvedDayKey));
  }, [events, resolvedDayKey]);

  const dayEvents = useMemo(() => {
    if (!orderOverride?.length) return storeDayEvents;

    const holidays = storeDayEvents.filter((event) => event.calendarId === HOLIDAYS_KR_CALENDAR_ID);
    const movable = storeDayEvents.filter((event) => event.calendarId !== HOLIDAYS_KR_CALENDAR_ID);
    const byId = new Map(movable.map((event) => [getSeriesId(event) || event.id, event]));
    const ordered = [];
    for (const id of orderOverride) {
      const event = byId.get(id);
      if (event) {
        ordered.push(event);
        byId.delete(id);
      }
    }
    for (const event of byId.values()) ordered.push(event);
    return [...holidays, ...ordered];
  }, [storeDayEvents, orderOverride]);

  const style = useMemo(
    () => buildQuickEditStyle(anchorRect, {
      bodyExtra: expandBody ? QUICK_EDIT_BODY_EXTRA_MONTH : 0,
    }),
    [anchorRect, expandBody],
  );

  useEffect(() => {
    setTitle('');
    setDraftLinks([]);
    setDraftCalendarId(getDefaultCalendarId(calendars, HOLIDAYS_KR_CALENDAR_ID));
    setDraftTagIds([]);
    setPaletteOpen(false);
    setSelectedEvent(focusEvent);
    setOrderOverride(null);
    setDragSeriesId(null);
    setDropSeriesId(null);
    const id = window.setTimeout(() => {
      if (!focusEvent) inputRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(id);
    // calendars: only used to seed draft calendar when the day/focus changes
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [resolvedDayKey, focusEvent]);

  useEffect(() => {
    if (!orderOverride) return;
    const movable = storeDayEvents.filter((event) => event.calendarId !== HOLIDAYS_KR_CALENDAR_ID);
    const current = movable.map((event) => getSeriesId(event) || event.id);
    if (
      current.length === orderOverride.length
      && current.every((id, index) => id === orderOverride[index])
    ) {
      setOrderOverride(null);
    }
  }, [storeDayEvents, orderOverride]);

  useEffect(() => {
    if (!selectedEvent) return;
    const sid = getSeriesId(selectedEvent) || selectedEvent.id;
    const live = dayEvents.find((event) => (getSeriesId(event) || event.id) === sid);
    if (!live) return;
    const prevCount = Array.isArray(selectedEvent.attachments) ? selectedEvent.attachments.length : 0;
    const nextCount = Array.isArray(live.attachments) ? live.attachments.length : 0;
    const prevTags = normalizeTagIds(selectedEvent.tagIds).join('\0');
    const nextTags = normalizeTagIds(live.tagIds).join('\0');
    if (
      prevCount !== nextCount
      || selectedEvent.completed !== live.completed
      || selectedEvent.calendarId !== live.calendarId
      || prevTags !== nextTags
    ) {
      setSelectedEvent(live);
    }
  }, [dayEvents, selectedEvent]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, paletteOpen]);

  // Portaled palette (overflow:hidden on the dialog clips the old absolute flyout).
  useLayoutEffect(() => {
    if (!paletteOpen || !canEdit) {
      setPaletteStyle(null);
      return undefined;
    }

    const place = () => {
      const anchor = colorTriggerRef.current;
      const panel = colorPanelRef.current;
      if (!anchor) return;

      const dialog = anchor.closest('[role="dialog"]');
      const dialogRect = dialog?.getBoundingClientRect();
      const bounds = dialogRect
        ? {
          left: dialogRect.left + COLOR_PANEL_PAD,
          top: dialogRect.top + COLOR_PANEL_PAD,
          right: dialogRect.right - COLOR_PANEL_PAD,
          bottom: dialogRect.bottom - COLOR_PANEL_PAD,
        }
        : {
          left: COLOR_PANEL_PAD,
          top: COLOR_PANEL_PAD,
          right: window.innerWidth - COLOR_PANEL_PAD,
          bottom: window.innerHeight - COLOR_PANEL_PAD,
        };

      const ar = anchor.getBoundingClientRect();
      const width = panel?.offsetWidth || COLOR_PANEL_FALLBACK_WIDTH;
      const height = panel?.offsetHeight || COLOR_PANEL_FALLBACK_HEIGHT;

      // Prefer above the trigger (under the title chrome), matching the old footer flyout.
      let left = ar.left;
      let top = ar.top - height - COLOR_PANEL_PAD;
      if (top < bounds.top) {
        top = ar.bottom + COLOR_PANEL_PAD;
      }

      const maxLeft = bounds.right - width;
      const minLeft = bounds.left;
      left = Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft));
      const maxTop = bounds.bottom - height;
      top = Math.min(Math.max(top, bounds.top), Math.max(bounds.top, maxTop));

      setPaletteStyle({
        position: 'fixed',
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
        right: 'auto',
        bottom: 'auto',
        zIndex: 80,
      });
    };

    place();
    const raf = window.requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [paletteOpen, canEdit, dayColor]);

  useEffect(() => {
    if (!paletteOpen) return undefined;
    const onPointerDown = (event) => {
      const target = event.target;
      if (colorTriggerRef.current?.contains(target) || colorPanelRef.current?.contains(target)) {
        return;
      }
      setPaletteOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [paletteOpen]);

  if (!date || !anchorRect || !style) return null;

  const activeCalendarId = selectedEvent
    && selectedEvent.calendarId !== HOLIDAYS_KR_CALENDAR_ID
    ? selectedEvent.calendarId
    : draftCalendarId;

  const handleCalendarChange = (calendarId) => {
    if (selectedEvent && selectedEvent.calendarId !== HOLIDAYS_KR_CALENDAR_ID) {
      void onEventCalendarChange?.(selectedEvent, calendarId);
      return;
    }
    setDraftCalendarId(calendarId);
  };

  const activeTagIds = selectedEvent
    && selectedEvent.calendarId !== HOLIDAYS_KR_CALENDAR_ID
    ? normalizeTagIds(selectedEvent.tagIds)
    : draftTagIds;

  const handleTagChange = (tagIds) => {
    const next = normalizeTagIds(tagIds);
    if (selectedEvent && selectedEvent.calendarId !== HOLIDAYS_KR_CALENDAR_ID) {
      void onEventTagChange?.(selectedEvent, next);
      return;
    }
    setDraftTagIds(next);
  };

  const submitTitle = async () => {
    const nextTitle = title.trim();
    if (!nextTitle || !canEdit || saving) return;
    setSaving(true);
    try {
      const movable = dayEvents.filter((event) => event.calendarId !== HOLIDAYS_KR_CALENDAR_ID);
      const maxOrder = movable.reduce((max, event) => {
        const order = typeof event.sortOrder === 'number' && Number.isFinite(event.sortOrder)
          ? event.sortOrder
          : -1;
        return Math.max(max, order);
      }, -1);
      await onCreate?.({
        title: nextTitle,
        startDate: resolvedDayKey,
        endDate: resolvedDayKey,
        allDay: true,
        startTime: null,
        endTime: null,
        repeat: 'none',
        description: '',
        location: '',
        calendarId: draftCalendarId || getDefaultCalendarId(calendars, HOLIDAYS_KR_CALENDAR_ID),
        tagIds: normalizeTagIds(draftTagIds),
        completed: false,
        color: null,
        guests: [],
        links: normalizeEventLinksArray(draftLinks),
        link: getPrimaryEventLinkUrl({ links: draftLinks }),
        sortOrder: maxOrder + 1,
      });
      setTitle('');
      setDraftLinks([]);
      setDraftTagIds([]);
    } finally {
      setSaving(false);
      // Input is disabled while `saving` — focus only works after React re-enables it.
      window.setTimeout(() => {
        inputRef.current?.focus({ preventScroll: true });
      }, 0);
    }
  };

  const insertEmoji = (emoji) => {
    const el = inputRef.current;
    const { nextValue, nextPos } = insertTextAtCursor(el, title, emoji);
    setTitle(nextValue);
    // Restore caret after React commits the new value to the input.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(nextPos, nextPos);
    });
  };

  // The link button targets whichever event is selected in the list; with nothing selected it
  // edits the in-progress "new event" draft row, applied once the title is submitted.
  const linkList = selectedEvent ? getEventLinks(selectedEvent) : draftLinks;
  const handleLinksChange = (nextLinks) => {
    const normalized = normalizeEventLinksArray(nextLinks);
    if (selectedEvent) {
      void onEventLinkChange?.(selectedEvent, normalized);
    } else {
      setDraftLinks(normalized);
    }
  };

  const reorderMovable = (fromSeriesId, toSeriesId) => {
    if (!canEdit || !fromSeriesId || !toSeriesId || fromSeriesId === toSeriesId) return;
    const movable = dayEvents.filter((event) => event.calendarId !== HOLIDAYS_KR_CALENDAR_ID);
    const fromIndex = movable.findIndex((event) => (getSeriesId(event) || event.id) === fromSeriesId);
    const toIndex = movable.findIndex((event) => (getSeriesId(event) || event.id) === toSeriesId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const next = [...movable];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setOrderOverride(next.map((event) => getSeriesId(event) || event.id));
    setSelectedEvent(moved);
    void onReorderEvents?.(next.map((event, index) => ({ event, sortOrder: index })));
  };

  return (
    <>
      <div className="fixed inset-0 z-[34]" onClick={onClose} role="presentation" />
      <div
        className="day-quick-edit fixed z-[35] flex flex-col overflow-hidden rounded-xl bg-gcal-surface shadow-g-lg"
        style={style}
        role="dialog"
        aria-label={`${formatDayHeaderTitle(date)} 빠른 편집`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="day-quick-edit-header">
          <h2 className="day-quick-edit-title">{formatDayHeaderTitle(date)}</h2>
          <button type="button" className="day-quick-edit-close" onClick={onClose} aria-label="닫기">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </header>

        <div className="day-quick-edit-body">
          <form
            className="day-quick-edit-create flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void submitTitle();
            }}
            onMouseDown={(e) => {
              if (!canEdit || saving) return;
              // Emoji/calendar/shape triggers & panels manage their own focus — don't steal it mid-click.
              if (e.target.closest?.('.emoji-picker-root')) return;
              if (e.target.closest?.('.quick-edit-calendar-root')) return;
              if (e.target.closest?.('.quick-edit-tag-root')) return;
              if (e.target.closest?.('.marker-shape-picker-root')) return;
              // Clicking the create row (not only the caret) should move focus to the input.
              if (e.target === inputRef.current) return;
              e.preventDefault();
              inputRef.current?.focus({ preventScroll: true });
            }}
          >
            <EmojiPickerButton
              title="이모지 추가"
              disabled={!canEdit || saving}
              flyoutAnchor="quick-edit-input-row"
              onSelect={insertEmoji}
            />
            <QuickEditCalendarButton
              calendars={calendars}
              value={activeCalendarId}
              disabled={
                !canEdit
                || saving
                || (selectedEvent && selectedEvent.calendarId === HOLIDAYS_KR_CALENDAR_ID)
              }
              onChange={handleCalendarChange}
            />
            <QuickEditTagButton
              tags={tags}
              value={activeTagIds}
              disabled={
                !canEdit
                || saving
                || (selectedEvent && selectedEvent.calendarId === HOLIDAYS_KR_CALENDAR_ID)
              }
              onChange={handleTagChange}
            />
            <input
              ref={inputRef}
              type="text"
              className="day-quick-edit-input flex-1"
              placeholder={canEdit ? '일정 추가 (종일)' : '로그인 후 추가할 수 있습니다'}
              value={title}
              disabled={!canEdit || saving}
              onChange={(e) => setTitle(e.target.value)}
              onMouseDown={(e) => {
                if (!canEdit || saving) return;
                // WebView2: ensure caret focus lands with the click (list/selection can steal it).
                const el = e.currentTarget;
                queueMicrotask(() => {
                  if (document.activeElement !== el) {
                    el.focus({ preventScroll: true });
                  }
                });
              }}
              onFocus={() => {
                // Typing a new title — drop event selection so "edit" targets create, not a bar.
                setSelectedEvent(null);
              }}
            />
          </form>

          <ul className="day-quick-edit-list settings-scroll">
            {dayEvents.length === 0 && (
              <li className="day-quick-edit-empty">등록된 일정이 없습니다</li>
            )}
            {dayEvents.map((event) => {
              const isHoliday = event.calendarId === HOLIDAYS_KR_CALENDAR_ID;
              const canDrag = canEdit && !isHoliday;
              const label = formatEventBarLabel(event, true, tags);
              const completed = Boolean(event.completed);
              const cal = calendars?.find((c) => c.id === event.calendarId);
              const accentColor = completed ? '#9aa0a6' : (cal?.color ?? '#f6bf26');
              const seriesId = getSeriesId(event) || event.id;
              const selectedId = selectedEvent
                ? (getSeriesId(selectedEvent) || selectedEvent.id)
                : null;
              const isSelected = selectedId && seriesId === selectedId;
              const isDragging = dragSeriesId === seriesId;
              const isDropTarget = dropSeriesId === seriesId && dragSeriesId && dragSeriesId !== seriesId;
              const displayTitle = label?.title || event.title || '';
              const hasLinkOrAttach = getEventLinks(event).length > 0
                || (Array.isArray(event.attachments) && event.attachments.length > 0);
              return (
                <li
                  key={`${seriesId}-${resolvedDayKey}`}
                  className={cn(
                    'day-quick-edit-item',
                    isDragging && 'is-dragging',
                    isDropTarget && 'is-drop-target',
                  )}
                >
                  <div
                    className={cn(
                      'day-quick-edit-row',
                      completed && 'is-completed',
                      isSelected && 'is-selected',
                      canDrag && 'is-draggable',
                    )}
                    draggable={canDrag}
                    onDragStart={(e) => {
                      if (!canDrag) return;
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', seriesId);
                      setDragSeriesId(seriesId);
                      setSelectedEvent(event);
                    }}
                    onDragEnd={() => {
                      setDragSeriesId(null);
                      setDropSeriesId(null);
                    }}
                    onDragOver={(e) => {
                      if (!canDrag || !dragSeriesId || dragSeriesId === seriesId) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (dropSeriesId !== seriesId) setDropSeriesId(seriesId);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget)) {
                        setDropSeriesId((current) => (current === seriesId ? null : current));
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const fromId = e.dataTransfer.getData('text/plain') || dragSeriesId;
                      setDragSeriesId(null);
                      setDropSeriesId(null);
                      reorderMovable(fromId, seriesId);
                    }}
                    onClick={() => {
                      setSelectedEvent(event);
                    }}
                  >
                    <input
                      type="checkbox"
                      className="day-quick-edit-check"
                      checked={completed}
                      disabled={!canEdit || isHoliday}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        if (isHoliday) return;
                        setSelectedEvent(event);
                        void onToggleCompleted?.(event, e.target.checked);
                      }}
                    />
                    <EventAccentGlyph
                      shapeId={event.markerShape}
                      color={accentColor}
                      variant="dot"
                      className="shrink-0"
                    />
                    <EventTagIcons event={event} tags={tags} />
                    <span
                      className="day-quick-edit-item-title"
                      role={isHoliday ? undefined : 'button'}
                      tabIndex={isHoliday ? undefined : 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedEvent(event);
                      }}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedEvent(event);
                        if (isHoliday) return;
                        onOpenMore?.(date, event);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedEvent(event);
                        if (isHoliday) return;
                        if (e.key === 'Enter') {
                          onOpenMore?.(date, event);
                        }
                      }}
                    >
                      {displayTitle}
                    </span>
                    {hasLinkOrAttach && (
                      <span className="event-bar-trailing">
                        <EventLinkIcon event={event} />
                        <EventAttachIcon event={event} />
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="day-quick-edit-footer">
          <div className="day-quick-edit-footer-left">
            <button
              ref={colorTriggerRef}
              type="button"
              className={cn('day-quick-edit-color-trigger', dayColor && 'has-color')}
              style={dayColor ? { backgroundColor: dayColor } : undefined}
              title="날짜 배경 색상"
              aria-label="날짜 배경 색상"
              aria-expanded={paletteOpen}
              disabled={!canEdit}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setPaletteOpen((open) => !open);
              }}
            >
              {!dayColor && (
                <svg className="day-quick-edit-color-palette-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.04 10 9c0 3.31-2.69 6-6 6h-1.77c-.28 0-.5.22-.5.5 0 .12.05.23.13.33.41.47.64 1.06.64 1.67A2.5 2.5 0 0 1 12 22zm0-16c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3zm-5 3.5c-.83 0-1.5-.67-1.5-1.5S6.17 6.5 7 6.5s1.5.67 1.5 1.5S7.83 9.5 7 9.5zm10 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM7 15.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3-8c-.83 0-1.5-.67-1.5-1.5S9.17 4.5 10 4.5s1.5.67 1.5 1.5S10.83 7.5 10 7.5z"
                  />
                </svg>
              )}
            </button>
            <EventMarkerShapeButton
              value={selectedEvent?.markerShape}
              color={calendars?.find((c) => c.id === selectedEvent?.calendarId)?.color ?? '#1a73e8'}
              disabled={
                !canEdit
                || !selectedEvent
                || selectedEvent.calendarId === HOLIDAYS_KR_CALENDAR_ID
              }
              onChange={(shapeId) => {
                void onEventMarkerShapeChange?.(selectedEvent, shapeId);
              }}
            />
            <EventLinkButton
              links={linkList}
              onChange={handleLinksChange}
              disabled={
                !canEdit
                || (selectedEvent && selectedEvent.calendarId === HOLIDAYS_KR_CALENDAR_ID)
              }
              title="바로가기 추가"
            />
            <EventAttachButton
              count={Array.isArray(selectedEvent?.attachments) ? selectedEvent.attachments.length : 0}
              disabled={
                !canEdit
                || !selectedEvent
                || selectedEvent.calendarId === HOLIDAYS_KR_CALENDAR_ID
              }
              title="파일 첨부"
              onClick={() => void onAttachFiles?.(selectedEvent)}
            />
            <button
              type="button"
              className="day-quick-edit-edit"
              title="전체 일정 편집"
              aria-label="전체 일정 편집"
              onClick={() => {
                onOpenMore?.(date, selectedEvent);
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"
                />
              </svg>
            </button>
          </div>
        </footer>
      </div>
      {paletteOpen && canEdit && createPortal(
        <div
          ref={colorPanelRef}
          className="day-quick-edit-palette-flyout"
          style={paletteStyle ?? { position: 'fixed', visibility: 'hidden', zIndex: 80 }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <DayColorPalette
            compact
            value={dayColor}
            onChange={(color) => {
              void onDayColorChange?.(color);
            }}
            onRequestClose={() => setPaletteOpen(false)}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
