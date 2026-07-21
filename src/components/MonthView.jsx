import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getCalendarTheme, getWeekdayCellClass, getWeekdayTextClass } from '../lib/colors.js';
import EventAccentGlyph from './EventAccentGlyph.jsx';
import EventAttachIcon from './EventAttachIcon.jsx';
import EventLinkIcon from './EventLinkIcon.jsx';
import EventTagIcons from './EventTagIcons.jsx';
import { getDayParts } from '../lib/lunar.js';
import { cn } from '../lib/cn.js';
import DayNumber from './DayNumber.jsx';
import EventMoreButton from './EventMoreButton.jsx';
import DayEventsPopover, { buildDayDisplayEvents } from './DayEventsPopover.jsx';
import { useEventHoverPreview } from '../hooks/useEventHoverPreview.js';
import { useMaxVisibleEvents, resolveDayVisibleEventLimit, useEventLayoutCssVars } from '../hooks/useMaxVisibleEvents.js';
import { useMonthWeekScroll } from '../hooks/useMonthWeekScroll.js';
import { compareEventsForDayDisplay } from '../lib/eventFormat.js';
import {
  addDays,
  generateWeekRange,
  getOrderedWeekdays,
  getWeekNumber,
  getWeeksInMonth,
  isSameDay,
  startOfWeek,
  toDateKey,
} from '../lib/calendarUtils.js';
import { buildAllWeekEventLayouts } from '../lib/monthWeekLayout.js';
import { DEFAULT_VIEW_OPTIONS, HOLIDAYS_KR_CALENDAR_ID } from '../../shared/constants.js';
import { shouldShowWeekNumbers, getWeekStartsOn } from '../lib/viewOptions.js';
import { isDesktopSurfaceHost, isNeutralinoDesktopShell } from '../lib/isNeutralinoDesktopShell.js';
import { getEventLinks } from '../../shared/eventLinks.js';
import { getSeriesId } from '../../shared/eventOccurrences.js';

// ~5 months each side. Keep all rows mounted (no shell↔row remount) — remount churn
// was climbing WebView2 past 1GB. Far header jumps recenter only when month is missing.
const WEEKS_BEFORE = 22;
const WEEKS_AFTER = 22;

/** True when the 1st of (year, monthIndex) falls inside the scroll week buffer. */
function isMonthInWeekBuffer(anchor, weekStartsOn, weeksBefore, weeksAfter, year, monthIndex) {
  const anchorWeekStart = startOfWeek(anchor, weekStartsOn);
  const rangeStart = addDays(anchorWeekStart, -weeksBefore * 7);
  const rangeEnd = addDays(anchorWeekStart, weeksAfter * 7 + 6);
  const day1 = new Date(year, monthIndex, 1);
  return day1.getTime() >= rangeStart.getTime() && day1.getTime() <= rangeEnd.getTime();
}

/** Hovering "N개 더보기" this long opens the day-events list (window + desktop). */
const MORE_HOVER_DELAY_MS = 400;

/**
 * Month grid click model (native clicks reach WebView2 in both modes):
 *
 * | Target     | Window mode                 | Desktop (locked) mode              |
 * |------------|-----------------------------|------------------------------------|
 * | Day cell   | click → select; dbl → QE    | same                               |
 * | Event bar  | click → QE; dbl → editor    | click → no-op; dbl → editor        |
 * | 더보기     | click/dbl → QE; hover → list| click → no-op; dbl → QE; hover → list |
 *
 * QE = DayQuickEditPopover. Full EventEditor is bar / list-row double-click only.
 */

/**
 * Reorder non-holiday events within one day (same contract as DayQuickEditPopover).
 * @returns {{ event: object, sortOrder: number }[] | null}
 */
function buildDayReorderPayload(daySegments, fromSeriesId, toSeriesId) {
  if (!fromSeriesId || !toSeriesId || fromSeriesId === toSeriesId) return null;
  const ordered = (daySegments ?? []).map((segment) => segment.event).filter(Boolean);
  const movable = ordered.filter((event) => event.calendarId !== HOLIDAYS_KR_CALENDAR_ID);
  const fromIndex = movable.findIndex((event) => (getSeriesId(event) || event.id) === fromSeriesId);
  const toIndex = movable.findIndex((event) => (getSeriesId(event) || event.id) === toSeriesId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;
  const next = [...movable];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next.map((event, index) => ({ event, sortOrder: index }));
}

const MonthWeekRow = memo(function MonthWeekRow({
  week,
  weekLayout,
  weekStartKey,
  showWeekNumbers,
  displayYear,
  displayMonth,
  isFullMonthView,
  selectedDate,
  today,
  eventCapacity,
  calendarById,
  tags = [],
  setWeekRef,
  onDaySelect,
  onDayCreate,
  onEventSelect,
  onEventDetail,
  onEventEdit,
  onEventMouseEnter,
  onEventMouseMove,
  onEventMouseLeave,
  onMoreOpen,
  onMoreHoverStart,
  onReorderEvents,
  dayColors,
  interactive = true,
  completedHidden = false,
  /** Desktop locked mode — suppress event-bar / 더보기 single-click (dblclick still works). */
  desktopLocked = false,
}) {
  const weekStart = week[0].date;
  const moreHoverTimerRef = useRef(null);
  const eventClickTimerRef = useRef(null);
  const suppressEventClickRef = useRef(false);
  const [dragSeriesId, setDragSeriesId] = useState(null);
  const [dragDayKey, setDragDayKey] = useState(null);
  const [dropSeriesId, setDropSeriesId] = useState(null);

  const clearMoreHoverTimer = useCallback(() => {
    if (moreHoverTimerRef.current) {
      window.clearTimeout(moreHoverTimerRef.current);
      moreHoverTimerRef.current = null;
    }
  }, []);

  const clearEventClickTimer = useCallback(() => {
    if (eventClickTimerRef.current) {
      window.clearTimeout(eventClickTimerRef.current);
      eventClickTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    clearMoreHoverTimer();
    clearEventClickTimer();
  }, [clearEventClickTimer, clearMoreHoverTimer]);

  return (
    <div
      ref={(node) => setWeekRef(weekStartKey, node)}
      className="month-week"
    >
      {showWeekNumbers && <div className="week-number">{getWeekNumber(weekStart)}</div>}
      {week.map(({ date }) => {
        const dayKey = toDateKey(date);
        const inCurrentMonth = isFullMonthView
          ? (date.getMonth() === displayMonth && date.getFullYear() === displayYear)
          : true;
        const selected = isSameDay(date, selectedDate);
        const isToday = isSameDay(date, today);
        const weekdayClass = getWeekdayCellClass(date.getDay());
        const { solar, lunar, lunarDay, solarTerm } = getDayParts(
          date.getFullYear(),
          date.getMonth() + 1,
          date.getDate(),
        );
        const daySegments = weekLayout[dayKey] ?? [];
        const sortedSegments = daySegments
          .slice()
          .sort((a, b) => (a.lane - b.lane) || compareEventsForDayDisplay(a.event, b.event, dayKey));
        // weekLayout already excludes completed events entirely when completedHidden is
        // true (see MonthView's weekLayouts memo), so lanes are compact with no gap.
        // This filter is just a defensive no-op guard against stale segments.
        const uiSegments = completedHidden
          ? sortedSegments.filter((segment) => !segment.event?.completed)
          : sortedSegments;
        const { visibleCount, hiddenEventCount } = resolveDayVisibleEventLimit(uiSegments, eventCapacity);
        const visibleSegments = uiSegments.slice(0, visibleCount);
        const dayBg = dayColors?.[dayKey] || null;

        return (
          <div
            key={dayKey}
            data-date-key={dayKey}
            className={[
              'day-cell',
              weekdayClass,
              !inCurrentMonth && 'other-month',
              selected && 'selected',
              isToday && 'today',
              dayBg && 'has-day-color',
              !interactive && 'day-cell-readonly',
            ].filter(Boolean).join(' ')}
            style={dayBg ? { '--day-cell-bg': dayBg } : undefined}
            onClick={interactive ? () => {
              onDaySelect(date);
            } : undefined}
            onDoubleClick={interactive ? (event) => {
              // Empty day cell (not an event bar) → quick-edit.
              event.preventDefault();
              event.stopPropagation();
              onDayCreate?.(date, event.currentTarget.getBoundingClientRect());
            } : undefined}
            onKeyDown={interactive ? (e) => {
              if (e.key === 'Enter') {
                onDayCreate?.(date, e.currentTarget.getBoundingClientRect());
              }
            } : undefined}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-disabled={!interactive || undefined}
          >
            <DayNumber solar={solar} lunarLabel={lunar} lunarDay={lunarDay} solarTerm={solarTerm} />
            <div className="day-events">
              {visibleSegments.map(({ event, segment, label, continuation, lane }) => {
                const cal = calendarById.get(event.calendarId);
                const color = cal?.color ?? '#f6bf26';
                const theme = getCalendarTheme(color);
                const accent = event.completed ? '#9aa0a6' : (theme.accent ?? theme.base);
                const hasLinkOrAttach = getEventLinks(event).length > 0
                  || (Array.isArray(event.attachments) && event.attachments.length > 0);
                const seriesId = getSeriesId(event) || event.id;
                const canDrag = Boolean(
                  interactive
                  && onReorderEvents
                  && event.calendarId !== HOLIDAYS_KR_CALENDAR_ID,
                );
                const isDragging = dragSeriesId === seriesId && dragDayKey === dayKey;
                const isDropTarget = Boolean(
                  canDrag
                  && dropSeriesId === seriesId
                  && dragDayKey === dayKey
                  && dragSeriesId
                  && dragSeriesId !== seriesId,
                );

                return (
                  <button
                    key={`${event.id}-${dayKey}`}
                    type="button"
                    data-event-id={seriesId}
                    data-day-key={dayKey}
                    data-editable={event.calendarId === HOLIDAYS_KR_CALENDAR_ID ? '0' : '1'}
                    draggable={canDrag}
                    className={cn(
                      'event-bar',
                      segment === 'single' && 'event-bar--single',
                      segment === 'start' && 'event-bar--start',
                      segment === 'middle' && 'event-bar--middle',
                      segment === 'end' && 'event-bar--end',
                      continuation && 'event-bar--continuation',
                      event.completed && 'is-completed',
                      canDrag && 'is-draggable',
                      isDragging && 'is-dragging',
                      isDropTarget && 'is-drop-target',
                    )}
                    style={{
                      // Prefer layout lane (stable across completed-hide) over list index.
                      '--event-lane': Number.isFinite(lane) ? lane : 0,
                      '--event-accent': accent,
                      backgroundColor: event.completed ? 'transparent' : theme.bg,
                      color: event.completed ? '#80868b' : theme.text,
                    }}
                    onMouseEnter={(e) => {
                      if (dragSeriesId) return;
                      // Read-only hover preview (window + desktop).
                      onEventMouseEnter?.(event, dayKey, e.currentTarget, e.clientX, e.clientY);
                    }}
                    onMouseMove={(e) => {
                      if (dragSeriesId) return;
                      onEventMouseMove?.(e.clientX, e.clientY);
                    }}
                    onMouseLeave={() => {
                      onEventMouseLeave?.();
                    }}
                    onDragStart={(e) => {
                      if (!canDrag) return;
                      clearEventClickTimer();
                      onEventMouseLeave?.();
                      suppressEventClickRef.current = false;
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', seriesId);
                      e.dataTransfer.setData('application/x-day-key', dayKey);
                      setDragSeriesId(seriesId);
                      setDragDayKey(dayKey);
                      setDropSeriesId(null);
                    }}
                    onDragEnd={() => {
                      // Native dragend is followed by a click — swallow that one.
                      suppressEventClickRef.current = true;
                      setDragSeriesId(null);
                      setDragDayKey(null);
                      setDropSeriesId(null);
                    }}
                    onDragOver={(e) => {
                      if (!canDrag || dragDayKey !== dayKey || !dragSeriesId || dragSeriesId === seriesId) {
                        return;
                      }
                      e.preventDefault();
                      e.stopPropagation();
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
                      const fromDay = e.dataTransfer.getData('application/x-day-key') || dragDayKey;
                      setDragSeriesId(null);
                      setDragDayKey(null);
                      setDropSeriesId(null);
                      if (fromDay !== dayKey) return;
                      const payload = buildDayReorderPayload(uiSegments, fromId, seriesId);
                      if (payload) void onReorderEvents?.(payload);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (suppressEventClickRef.current) {
                        suppressEventClickRef.current = false;
                        return;
                      }
                      // Desktop locked: click no-op (dblclick → full editor).
                      if (desktopLocked) return;
                      // Window: defer so a following dblclick can cancel quick-edit.
                      const { clientX, clientY } = e;
                      clearEventClickTimer();
                      eventClickTimerRef.current = window.setTimeout(() => {
                        eventClickTimerRef.current = null;
                        onEventSelect(event, clientX, clientY, dayKey);
                      }, 250);
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!interactive) return;
                      clearEventClickTimer();
                      clearMoreHoverTimer();
                      if (event.calendarId === HOLIDAYS_KR_CALENDAR_ID) return;
                      // Window + desktop: bar double-click → full EventEditor.
                      onEventEdit?.(event, dayKey);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      clearEventClickTimer();
                      (onEventDetail ?? onEventSelect)(event, e.clientX, e.clientY, dayKey);
                    }}
                  >
                    <EventAccentGlyph
                      shapeId={event.markerShape}
                      color={accent}
                      variant="bar"
                    />
                    {label?.time && (
                      <span className="event-time">{label.time}</span>
                    )}
                    {label?.dayIndex != null && (
                      <span className="event-day-index">({label.dayIndex})</span>
                    )}
                    <EventTagIcons event={event} tags={tags} />
                    {label && (
                      <span className={cn('event-title', event.completed && 'line-through opacity-70')}>
                        {label.title}
                      </span>
                    )}
                    {hasLinkOrAttach && (
                      <span className="event-bar-trailing">
                        <EventLinkIcon event={event} />
                        <EventAttachIcon event={event} />
                      </span>
                    )}
                  </button>
                );
              })}
              {hiddenEventCount > 0 && (
                <EventMoreButton
                  count={hiddenEventCount}
                  lane={visibleSegments.length}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Desktop locked: click no-op. Window: click → quick-edit.
                    if (!interactive || desktopLocked) return;
                    clearMoreHoverTimer();
                    // Anchor to the day cell so QE matches day-cell / bar sizing.
                    onDayCreate?.(date, e.currentTarget.closest('.day-cell')?.getBoundingClientRect() ?? e.currentTarget.getBoundingClientRect());
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!interactive) return;
                    clearMoreHoverTimer();
                    // Window + desktop: 더보기 double-click → quick-edit.
                    onDayCreate?.(date, e.currentTarget.closest('.day-cell')?.getBoundingClientRect() ?? e.currentTarget.getBoundingClientRect());
                  }}
                  onMouseEnter={(e) => {
                    // Hover → day-events list (window + desktop).
                    if (!interactive) return;
                    // Drop any open event-bar detail immediately so "더보기" isn't covered
                    // and the list can take over on the first hover.
                    onMoreHoverStart?.();
                    const rect = e.currentTarget.getBoundingClientRect();
                    clearMoreHoverTimer();
                    moreHoverTimerRef.current = window.setTimeout(() => {
                      onMoreOpen?.(date, dayKey, daySegments, rect);
                    }, MORE_HOVER_DELAY_MS);
                  }}
                  onMouseLeave={clearMoreHoverTimer}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});

export default function MonthView({
  viewDate,
  selectedDate,
  events,
  calendars,
  tags = [],
  viewOptions = DEFAULT_VIEW_OPTIONS,
  onSelectDate,
  onDayQuickEdit,
  onCreateDate,
  onEventClick,
  onEventDetail,
  onEventHover,
  onCloseEventDetail,
  onEventEdit,
  onReorderEvents,
  onVisibleMonthChange,
  onVisibleWeekChange,
  monthAlign = { token: 0, target: 'month' },
  weeksInViewport = 5,
  wheelLocked = false,
  dayColors = {},
  interactive = true,
  editorOpen = false,
  eventsHidden = false,
  completedHidden = false,
}) {
  const weekStartsOn = getWeekStartsOn(viewOptions);
  const showWeekNumbers = shouldShowWeekNumbers(viewOptions);
  const weekdays = getOrderedWeekdays(weekStartsOn);
  const scrollRef = useRef(null);
  const scrollAnchorRef = useRef(viewDate);
  const viewDateRef = useRef(viewDate);
  const [scrollAnchorVersion, setScrollAnchorVersion] = useState(0);
  const [desktopLocked, setDesktopLocked] = useState(() => isDesktopSurfaceHost());

  useEffect(() => {
    if (!isNeutralinoDesktopShell()) {
      setDesktopLocked(false);
      return undefined;
    }
    let cancelled = false;
    const sync = async () => {
      try {
        const status = await window.myCalendar?.getWidgetStatus?.();
        if (!cancelled) {
          setDesktopLocked(Boolean(status?.embedded));
        }
      } catch {
        if (!cancelled) setDesktopLocked(isDesktopSurfaceHost());
      }
    };
    void sync();
    const onStatus = (event) => {
      const embedded = event?.detail?.embedded;
      if (typeof embedded === 'boolean') {
        setDesktopLocked(embedded);
        return;
      }
      void sync();
    };
    window.addEventListener('mycalendar:widgetStatusChanged', onStatus);
    return () => {
      cancelled = true;
      window.removeEventListener('mycalendar:widgetStatusChanged', onStatus);
    };
  }, []);
  viewDateRef.current = viewDate;
  const hasInitialScrollRef = useRef(false);
  const prevViewMonthRef = useRef('');
  const lastAlignTokenRef = useRef(0);
  const isFullMonthView = weeksInViewport >= 5;
  const displayYear = viewDate.getFullYear();
  const displayMonth = viewDate.getMonth();
  // Fit the displayed month's own week-row count (4/5/6) into the viewport so a 6-week
  // month doesn't need scrolling. Row heights are uniform via `--weeks-in-viewport` on
  // `.month-view` — when that count changes on month navigation, the align effect below
  // must re-snap (see weeksCountChanged), otherwise scrollTop still points at the
  // pre-resize week and wheel / reportVisibleMonth go haywire.
  const monthWeeksCount = isFullMonthView
    ? getWeeksInMonth(displayYear, displayMonth, weekStartsOn)
    : weeksInViewport;
  const effectiveWeeksInViewport = monthWeeksCount;
  const prevWeeksInViewportRef = useRef(effectiveWeeksInViewport);

  // useLayoutEffect (not useEffect) — this must land before the browser paints the
  // first frame of the new mode. useEffect ran after paint, so the grid painted once
  // with the *old* week range / wrong scrollTop (visible as a blank flash), then
  // repainted a moment later once the effect fired and regenerated the range.
  useLayoutEffect(() => {
    if (!isFullMonthView) {
      const anchor = viewDateRef.current;
      scrollAnchorRef.current = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      setScrollAnchorVersion((version) => version + 1);
    }
  }, [isFullMonthView, weeksInViewport]);

  // Recenter ONLY when the displayed month is completely outside the buffer.
  // Do not recenter on scroll "near edge" — that remount loop leaked multi-GB RAM.
  useLayoutEffect(() => {
    if (isMonthInWeekBuffer(
      scrollAnchorRef.current,
      weekStartsOn,
      WEEKS_BEFORE,
      WEEKS_AFTER,
      displayYear,
      displayMonth,
    )) {
      return;
    }
    scrollAnchorRef.current = new Date(displayYear, displayMonth, 1);
    setScrollAnchorVersion((version) => version + 1);
  }, [displayYear, displayMonth, weekStartsOn]);

  const weeks = useMemo(
    () => generateWeekRange(scrollAnchorRef.current, weekStartsOn, WEEKS_BEFORE, WEEKS_AFTER),
    [weekStartsOn, scrollAnchorVersion],
  );

  const eventCapacity = useMaxVisibleEvents(scrollRef, effectiveWeeksInViewport);
  const eventLayoutCssVars = useEventLayoutCssVars();
  const today = useMemo(() => new Date(), []);
  const calendarById = useMemo(
    () => new Map((calendars ?? []).map((calendar) => [calendar.id, calendar])),
    [calendars],
  );

  const weekLayouts = useMemo(() => {
    // Exclude completed events from layout entirely (not just visually) when hidden,
    // so remaining bars are re-assigned compact lanes instead of leaving a blank gap
    // where the hidden completed bar used to sit.
    const laidOutEvents = completedHidden
      ? events.filter((event) => !event?.completed)
      : events;
    return buildAllWeekEventLayouts(weeks, laidOutEvents, tags);
  }, [weeks, events, tags, completedHidden]);

  const {
    clearPreview: clearHoverPreview,
    handleEventMouseEnter,
    handleEventMouseMove,
    handleEventMouseLeave,
  } = useEventHoverPreview({
    onOpen: ({ event, dayKey, clientX, clientY }) => {
      // Event-bar hover preview is opt-in via onEventHover only (not click/detail fallback).
      onEventHover?.(event, clientX, clientY, dayKey);
    },
  });
  const [expandedDay, setExpandedDay] = useState(null);

  // Full EventEditor takes over — dismiss the day "더보기" list underneath.
  useEffect(() => {
    if (editorOpen) setExpandedDay(null);
  }, [editorOpen]);

  // Hide toggles — drop the day list so it cannot show stale completed/all events.
  useEffect(() => {
    if (eventsHidden || completedHidden) setExpandedDay(null);
  }, [completedHidden, eventsHidden]);

  // Keep the "더보기" day list in sync with the live store (delete/edit/reorder).
  // expandedDay used to snapshot events at open — after delete the row stayed visible
  // and a second delete showed "일정을 찾을 수 없습니다."
  useEffect(() => {
    setExpandedDay((current) => {
      if (!current) return null;
      const { dayKey, date, anchorRect } = current;
      let daySegments = null;
      for (const layout of weekLayouts.values()) {
        if (Object.prototype.hasOwnProperty.call(layout, dayKey)) {
          daySegments = layout[dayKey] ?? [];
          break;
        }
      }
      if (daySegments == null) {
        return null;
      }
      const dayEvents = daySegments
        .slice()
        .sort((a, b) => compareEventsForDayDisplay(a.event, b.event, dayKey))
        .map((segment) => segment.event)
        .filter((event) => !(completedHidden && event?.completed));
      const nextEvents = buildDayDisplayEvents(dayEvents, dayKey, tags);
      const signature = (rows) => (rows ?? [])
        .map((row) => {
          const event = row.event;
          const id = getSeriesId(event) || event.id;
          return `${id}:${event.completed ? 1 : 0}:${row.label?.title ?? ''}`;
        })
        .join('\n');
      if (signature(current.events) === signature(nextEvents)) {
        return current;
      }
      return {
        date,
        dayKey,
        events: nextEvents,
        anchorRect,
      };
    });
  }, [weekLayouts, tags, completedHidden]);

  const {
    setWeekRef,
    scrollToMonth,
    scrollToDateInViewport,
    consumeSkipScroll,
  } = useMonthWeekScroll({
    scrollRef,
    weeks,
    weeksInViewport,
    onVisibleMonthChange,
    onVisibleWeekChange,
    wheelLocked,
  });

  const scrollToMonthRef = useRef(scrollToMonth);
  scrollToMonthRef.current = scrollToMonth;
  const scrollToDateInViewportRef = useRef(scrollToDateInViewport);
  scrollToDateInViewportRef.current = scrollToDateInViewport;

  const runViewportAlign = (target, behavior = 'auto') => {
    if (isFullMonthView) {
      scrollToMonthRef.current(displayYear, displayMonth, weekStartsOn, behavior);
      return;
    }

    if (target === 'today') {
      scrollToDateInViewportRef.current(today, 0, behavior);
      return;
    }

    const anchor = selectedDate ?? viewDate;
    scrollToDateInViewportRef.current(anchor, 0, behavior);
  };

  useLayoutEffect(() => {
    const monthKey = `${displayYear}-${displayMonth}`;
    const weeksCountChanged = prevWeeksInViewportRef.current !== effectiveWeeksInViewport;
    prevWeeksInViewportRef.current = effectiveWeeksInViewport;

    if (!hasInitialScrollRef.current) {
      hasInitialScrollRef.current = true;
      runViewportAlign(monthAlign.target === 'today' && !isFullMonthView ? 'today' : 'month', 'auto');
      prevViewMonthRef.current = monthKey;
      return;
    }

    if (monthAlign.token > lastAlignTokenRef.current) {
      lastAlignTokenRef.current = monthAlign.token;
      prevViewMonthRef.current = monthKey;
      runViewportAlign(monthAlign.target, 'auto');
      return;
    }

    // Wheel/swipe already scrolled to the next month's day-1 week and published viewDate
    // via reportVisibleMonth (consumeSkipScroll). But when the new month has a different
    // week-row count, `--weeks-in-viewport` resizes every `.month-week` and scrollTop no
    // longer lands on that day-1 week — re-snap after the resize, don't skip.
    if (weeksCountChanged) {
      consumeSkipScroll();
      prevViewMonthRef.current = monthKey;
      runViewportAlign('month', 'auto');
      return;
    }

    if (consumeSkipScroll()) {
      prevViewMonthRef.current = monthKey;
      return;
    }

    if (prevViewMonthRef.current === monthKey) return;

    prevViewMonthRef.current = monthKey;
    runViewportAlign('month', 'auto');
  }, [
    consumeSkipScroll,
    displayMonth,
    displayYear,
    effectiveWeeksInViewport,
    isFullMonthView,
    monthAlign.target,
    monthAlign.token,
    scrollAnchorVersion,
    weekStartsOn,
    weeksInViewport,
    selectedDate,
    viewDate,
  ]);

  // DesktopHost is Collapsed while in window mode — scroll often sits at 0. When the
  // surface becomes visible again, realign to viewDate so we don't land on week 0 (~2024).
  useEffect(() => {
    const body = scrollRef.current;
    if (!body) return undefined;

    let wasCollapsed = body.clientHeight < 8;
    const realignIfRestored = () => {
      const collapsed = body.clientHeight < 8;
      if (wasCollapsed && !collapsed) {
        runViewportAlign(
          monthAlign.target === 'today' && !isFullMonthView ? 'today' : 'month',
          'auto',
        );
      }
      wasCollapsed = collapsed;
    };

    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          realignIfRestored();
        })
      : null;
    ro?.observe(body);

    const onWidgetStatus = () => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(realignIfRestored);
      });
    };
    window.addEventListener('mycalendar:widgetStatusChanged', onWidgetStatus);

    return () => {
      ro?.disconnect();
      window.removeEventListener('mycalendar:widgetStatusChanged', onWidgetStatus);
    };
  }, [isFullMonthView, monthAlign.target, weeksInViewport, displayMonth, displayYear]);

  const handleDaySelect = useCallback((date) => {
    if (!interactive) return;
    clearHoverPreview();
    onSelectDate?.(date);
  }, [clearHoverPreview, interactive, onSelectDate]);

  const handleDayCreate = useCallback((date, anchorRect) => {
    if (!interactive) return;
    clearHoverPreview();
    setExpandedDay(null);
    onCloseEventDetail?.();
    onSelectDate?.(date);
    // Always quick-edit for day-cell / 더보기 double-click (full editor is event-bar dblclick).
    if (onDayQuickEdit) {
      onDayQuickEdit(date, anchorRect);
      return;
    }
    onCreateDate?.(date);
  }, [
    clearHoverPreview,
    interactive,
    onCloseEventDetail,
    onCreateDate,
    onDayQuickEdit,
    onSelectDate,
  ]);

  const handleEventSelect = useCallback((event, clientX, clientY, dayKey) => {
    // Window: single-click → quick-edit (desktopLocked skips earlier in the bar handler).
    clearHoverPreview();
    onEventClick?.(event, clientX, clientY, dayKey);
  }, [clearHoverPreview, onEventClick]);

  const handleEventDetail = useCallback((event, clientX, clientY, dayKey) => {
    clearHoverPreview();
    (onEventDetail ?? onEventHover)?.(event, clientX, clientY, dayKey);
  }, [clearHoverPreview, onEventDetail, onEventHover]);

  const handleEventEdit = useCallback((event, dayKey) => {
    if (!interactive) return;
    if (event?.calendarId === HOLIDAYS_KR_CALENDAR_ID) return;
    clearHoverPreview();
    setExpandedDay(null);
    onEventEdit?.(event, dayKey);
  }, [clearHoverPreview, interactive, onEventEdit]);

  const handleMoreHoverStart = useCallback(() => {
    clearHoverPreview();
    onCloseEventDetail?.();
  }, [clearHoverPreview, onCloseEventDetail]);

  const closeExpandedDay = useCallback(() => {
    setExpandedDay(null);
  }, []);

  const handleMoreOpen = useCallback((date, dayKey, daySegments) => {
    if (!interactive) return;
    clearHoverPreview();
    onCloseEventDetail?.();
    const dayEvents = daySegments
      .slice()
      .sort((a, b) => compareEventsForDayDisplay(a.event, b.event, dayKey))
      .map((segment) => segment.event)
      .filter((event) => !(completedHidden && event?.completed));
    const cell = document.querySelector(`.day-cell[data-date-key="${dayKey}"]`);
    const cellRect = cell?.getBoundingClientRect?.() ?? null;
    // "N개 더보기" hover → day-events list (click → QE only in window mode).
    setExpandedDay({
      date,
      dayKey,
      events: buildDayDisplayEvents(dayEvents, dayKey, tags),
      anchorRect: cellRect
        ? {
            top: cellRect.top,
            left: cellRect.left,
            right: cellRect.right,
            bottom: cellRect.bottom,
            width: cellRect.width,
            height: cellRect.height,
            x: cellRect.x,
            y: cellRect.y,
          }
        : null,
    });
  }, [clearHoverPreview, completedHidden, interactive, onCloseEventDetail, tags]);

  return (
    <div
      className={cn(
        'month-view',
        !showWeekNumbers && 'hide-week-numbers',
        eventsHidden && 'is-events-hidden',
        completedHidden && 'is-completed-hidden',
      )}
      style={{ '--weeks-in-viewport': effectiveWeeksInViewport, ...eventLayoutCssVars }}
    >
      <div className="month-weekdays">
        {showWeekNumbers && <div className="week-number-header" />}
        {weekdays.map((d, i) => (
          <div key={d} className={cn(getWeekdayTextClass((weekStartsOn + i) % 7) || 'text-gcal-muted')}>{d}</div>
        ))}
      </div>

      <div className="month-body" ref={scrollRef}>
        {weeks.map((week) => {
          const weekStartKey = toDateKey(week[0].date);
          return (
            <MonthWeekRow
              key={weekStartKey}
              week={week}
              weekLayout={weekLayouts.get(weekStartKey) ?? {}}
              weekStartKey={weekStartKey}
              showWeekNumbers={showWeekNumbers}
              displayYear={displayYear}
              displayMonth={displayMonth}
              isFullMonthView={isFullMonthView}
              selectedDate={selectedDate}
              today={today}
              eventCapacity={eventCapacity}
              calendarById={calendarById}
              tags={tags}
              setWeekRef={setWeekRef}
              onDaySelect={handleDaySelect}
              onDayCreate={handleDayCreate}
              interactive={interactive}
              onEventSelect={handleEventSelect}
              onEventDetail={onEventDetail ? handleEventDetail : undefined}
              onEventEdit={handleEventEdit}
              onEventMouseEnter={onEventHover ? handleEventMouseEnter : undefined}
              onEventMouseMove={onEventHover ? handleEventMouseMove : undefined}
              onEventMouseLeave={onEventHover ? handleEventMouseLeave : undefined}
              onMoreOpen={handleMoreOpen}
              onMoreHoverStart={handleMoreHoverStart}
              onReorderEvents={onReorderEvents}
              dayColors={dayColors}
              completedHidden={completedHidden}
              desktopLocked={desktopLocked}
            />
          );
        })}
      </div>

      {expandedDay && (
        <DayEventsPopover
          date={expandedDay.date}
          dayKey={expandedDay.dayKey}
          events={expandedDay.events}
          calendars={calendars}
          tags={tags}
          anchorRect={expandedDay.anchorRect}
          canEdit={interactive && Boolean(onReorderEvents)}
          onReorderEvents={onReorderEvents}
          onClose={closeExpandedDay}
          onEventHover={(event, clientX, clientY, _dayKey, anchorRect) => {
            // List-row hover → read-only detail (list stays open; detail paints above).
            (onEventHover ?? onEventDetail)?.(
              event,
              clientX,
              clientY,
              expandedDay.dayKey,
              anchorRect,
            );
          }}
          onEventClick={(event) => {
            // List-row double-click → full EventEditor (closes the list).
            closeExpandedDay();
            clearHoverPreview();
            if (onEventEdit) {
              onEventEdit(event, expandedDay.dayKey);
              return;
            }
            onEventClick?.(event, 0, 0, expandedDay.dayKey);
          }}
          onEventDetail={onEventDetail ? (event, clientX, clientY, _dayKey, anchorRect) => {
            // List-row single-click → read-only detail popover. Keep the list open behind
            // it (same click-through-to-swap pattern as the main grid's EventPopover).
            if (anchorRect) {
              onEventDetail(event, clientX, clientY, expandedDay.dayKey, anchorRect);
              return;
            }
            handleEventDetail(event, clientX, clientY, expandedDay.dayKey);
          } : undefined}
        />
      )}
    </div>
  );
}
