import { useCallback, useEffect, useMemo, useRef } from 'react';
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
  onClose,
  onEventClick,
  onEventHover,
  onEventDetail,
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

  const popoverOptions = useMemo(
    () => ({
      width: Math.min(280, window.innerWidth - 24),
      estimatedHeight: 48 + Math.min(events.length * 40, 280) + 12,
      padding: 12,
    }),
    [events.length],
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
          {events.map(({ event, label }) => {
            const cal = calendars.find((c) => c.id === event.calendarId);
            const completed = Boolean(event.completed);
            const color = completed ? '#9aa0a6' : (cal?.color ?? '#f6bf26');
            const hasLinkOrAttach = getEventLinks(event).length > 0
              || (Array.isArray(event.attachments) && event.attachments.length > 0);

            return (
              <li key={`${event.id}-${dayKey}`}>
                <button
                  type="button"
                  className={cn('day-events-popover-item', completed && 'is-completed')}
                  onMouseEnter={(e) => {
                    handleEventMouseEnter(event, dayKey, e.currentTarget, e.clientX, e.clientY);
                  }}
                  onMouseMove={(e) => {
                    handleEventMouseMove(e.clientX, e.clientY);
                  }}
                  onClick={(e) => {
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
