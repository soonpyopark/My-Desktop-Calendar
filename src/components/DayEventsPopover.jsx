import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HOLIDAYS_KR_CALENDAR_ID } from '../../shared/constants.js';
import { getSeriesId } from '../../shared/eventOccurrences.js';
import { useEventHoverPreview } from '../hooks/useEventHoverPreview.js';
import { formatEventBarLabel } from '../lib/eventFormat.js';
import { formatDayHeaderTitle } from '../lib/dayHeaderFormat.js';
import {
  getAnchoredPopoverPosition,
  useAnchoredPopoverStyle,
} from '../lib/popoverPosition.js';
import { getEventLinks } from '../../shared/eventLinks.js';
import { cn } from '../lib/cn.js';
import EventAccentGlyph from './EventAccentGlyph.jsx';
import EventAttachIcon from './EventAttachIcon.jsx';
import EventLinkIcon from './EventLinkIcon.jsx';
import EventTagIcons from './EventTagIcons.jsx';

export default function DayEventsPopover({
  date,
  dayKey,
  events,
  calendars,
  tags = [],
  anchorRect,
  canEdit = false,
  onClose,
  onEventClick,
  onEventHover,
  onEventDetail,
  onReorderEvents,
}) {
  const {
    clearPreview: clearHoverPreview,
    handleEventMouseEnter,
    handleEventMouseMove,
  } = useEventHoverPreview({
    resetTimerOnMove: false,
    onOpen: ({ event, clientX, clientY }) => {
      // Same pointer anchor as single-click (not the list-row rect) so detail opens
      // in the same place for hover and click.
      (onEventHover ?? onEventDetail)?.(event, clientX, clientY, dayKey);
    },
  });

  const [orderOverride, setOrderOverride] = useState(null);
  const [dragSeriesId, setDragSeriesId] = useState(null);
  const [dropSeriesId, setDropSeriesId] = useState(null);
  const suppressClickRef = useRef(false);

  const displayEvents = useMemo(() => {
    if (!orderOverride?.length) return events ?? [];
    const byId = new Map(
      (events ?? []).map((row) => [getSeriesId(row.event) || row.event.id, row]),
    );
    const ordered = [];
    for (const id of orderOverride) {
      const row = byId.get(id);
      if (row) {
        ordered.push(row);
        byId.delete(id);
      }
    }
    for (const row of byId.values()) ordered.push(row);
    return ordered;
  }, [events, orderOverride]);

  useEffect(() => {
    setOrderOverride(null);
    setDragSeriesId(null);
    setDropSeriesId(null);
  }, [dayKey]);

  useEffect(() => {
    if (!orderOverride) return;
    const current = (events ?? []).map((row) => getSeriesId(row.event) || row.event.id);
    if (
      current.length === orderOverride.length
      && current.every((id, index) => id === orderOverride[index])
    ) {
      setOrderOverride(null);
    }
  }, [events, orderOverride]);

  const popoverOptions = useMemo(
    () => ({
      width: Math.min(280, window.innerWidth - 24),
      estimatedHeight: 48 + Math.min(displayEvents.length * 40, 280) + 12,
      padding: 12,
    }),
    [displayEvents.length],
  );
  const { ref, style: anchoredStyle } = useAnchoredPopoverStyle(anchorRect, popoverOptions);

  // Single click → detail; double click → editor. The single-click action is held back
  // briefly so a following second click (dblclick) can cancel it instead of both firing.
  const clickTimerRef = useRef(null);
  const clearClickTimer = useCallback(() => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  }, []);

  // Keep Escape handler on a ref so parent re-renders (new onClose identity) do not
  // tear down this effect — the old cleanup used to clearHoverPreview() and cancel the
  // 500ms list-row hover timer before detail could open.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => () => {
    clearHoverPreview();
    clearClickTimer();
  }, [clearClickTimer, clearHoverPreview]);

  const reorderMovable = (fromSeriesId, toSeriesId) => {
    if (!canEdit || !onReorderEvents || !fromSeriesId || !toSeriesId || fromSeriesId === toSeriesId) {
      return;
    }
    const movable = displayEvents.filter(
      (row) => row.event.calendarId !== HOLIDAYS_KR_CALENDAR_ID,
    );
    const fromIndex = movable.findIndex(
      (row) => (getSeriesId(row.event) || row.event.id) === fromSeriesId,
    );
    const toIndex = movable.findIndex(
      (row) => (getSeriesId(row.event) || row.event.id) === toSeriesId,
    );
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const next = [...movable];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);

    // Keep holidays in their relative slots among the full list after reorder.
    const holidays = displayEvents.filter(
      (row) => row.event.calendarId === HOLIDAYS_KR_CALENDAR_ID,
    );
    const merged = [...holidays, ...next];
    setOrderOverride(merged.map((row) => getSeriesId(row.event) || row.event.id));
    void onReorderEvents(next.map((row, index) => ({ event: row.event, sortOrder: index })));
  };

  if (!date || !anchorRect) return null;

  const style = anchoredStyle ?? getAnchoredPopoverPosition(anchorRect, popoverOptions);

  return (
    <>
      {/* List stays below EventPopover (z-50/51) so detail paints on top when both open. */}
      <div className="fixed inset-0 z-[24]" onClick={onClose} role="presentation" />
      <div
        ref={ref}
        className="day-events-popover fixed z-[46] flex w-[min(280px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl bg-gcal-surface shadow-g-lg"
        style={style}
        role="dialog"
        aria-label={`${date.getMonth() + 1}월 ${date.getDate()}일 일정`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="day-quick-edit-header">
          <h2 className="day-quick-edit-title">{formatDayHeaderTitle(date)}</h2>
          <button type="button" className="day-quick-edit-close" onClick={onClose} aria-label="닫기">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <ul className="settings-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3" onMouseLeave={clearHoverPreview}>
          {displayEvents.map(({ event, label }) => {
            const cal = calendars.find((c) => c.id === event.calendarId);
            const completed = Boolean(event.completed);
            const color = completed ? '#9aa0a6' : (cal?.color ?? '#f6bf26');
            const hasLinkOrAttach = getEventLinks(event).length > 0
              || (Array.isArray(event.attachments) && event.attachments.length > 0);
            const seriesId = getSeriesId(event) || event.id;
            const isHoliday = event.calendarId === HOLIDAYS_KR_CALENDAR_ID;
            const canDrag = canEdit && Boolean(onReorderEvents) && !isHoliday;
            const isDragging = dragSeriesId === seriesId;
            const isDropTarget = Boolean(
              canDrag && dropSeriesId === seriesId && dragSeriesId && dragSeriesId !== seriesId,
            );

            return (
              <li
                key={`${seriesId}-${dayKey}`}
                className={cn(
                  isDragging && 'is-dragging',
                  isDropTarget && 'is-drop-target',
                )}
              >
                <button
                  type="button"
                  draggable={canDrag}
                  className={cn(
                    'day-events-popover-item',
                    completed && 'is-completed',
                    canDrag && 'is-draggable',
                  )}
                  onMouseEnter={(e) => {
                    if (dragSeriesId) return;
                    handleEventMouseEnter(event, dayKey, e.currentTarget, e.clientX, e.clientY);
                  }}
                  onMouseMove={(e) => {
                    if (dragSeriesId) return;
                    handleEventMouseMove(e.clientX, e.clientY);
                  }}
                  onDragStart={(e) => {
                    if (!canDrag) return;
                    clearClickTimer();
                    clearHoverPreview();
                    suppressClickRef.current = false;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', seriesId);
                    setDragSeriesId(seriesId);
                    setDropSeriesId(null);
                  }}
                  onDragEnd={() => {
                    suppressClickRef.current = true;
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
                  onClick={(e) => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    const { clientX, clientY } = e;
                    clearClickTimer();
                    clickTimerRef.current = window.setTimeout(() => {
                      clickTimerRef.current = null;
                      clearHoverPreview();
                      (onEventDetail ?? onEventHover)?.(event, clientX, clientY, dayKey);
                    }, 250);
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    clearClickTimer();
                    clearHoverPreview();
                    onEventClick?.(event, e.clientX, e.clientY, dayKey);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    clearHoverPreview();
                    (onEventDetail ?? onEventHover)?.(event, e.clientX, e.clientY, dayKey);
                  }}
                >
                  <EventAccentGlyph shapeId={event.markerShape} color={color} variant="dot" className="shrink-0" />
                  {label.time && <span className="shrink-0 text-gcal-muted">{label.time}</span>}
                  <EventTagIcons event={event} tags={tags} />
                  <span className={cn('min-w-0 flex-1 truncate text-gcal-heading', completed && 'line-through opacity-70')}>
                    {label.title}
                  </span>
                  {hasLinkOrAttach && (
                    <span className="event-bar-trailing">
                      <EventLinkIcon event={event} />
                      <EventAttachIcon event={event} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

/**
 * @param {object[]} dayEvents sorted events for the day
 * @param {string} dayKey
 * @param {object[]} [tags]
 */
export function buildDayDisplayEvents(dayEvents, dayKey, tags) {
  return dayEvents
    .map((event) => {
      const label = formatEventBarLabel(event, true, tags);
      if (!label) return null;
      return { event, label };
    })
    .filter(Boolean);
}
