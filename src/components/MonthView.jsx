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
  generateWeekRange,
  getOrderedWeekdays,
  getWeekNumber,
  getWeeksInMonth,
  isSameDay,
  toDateKey,
} from '../lib/calendarUtils.js';
import { buildWeekEventLayout } from '../lib/monthWeekLayout.js';
import { DEFAULT_VIEW_OPTIONS, HOLIDAYS_KR_CALENDAR_ID } from '../../shared/constants.js';
import { shouldShowWeekNumbers, getWeekStartsOn } from '../lib/viewOptions.js';
import { isDesktopSurfaceHost, isNeutralinoDesktopShell } from '../lib/isNeutralinoDesktopShell.js';
import { getSeriesId } from '../../shared/eventOccurrences.js';

const WEEKS_BEFORE = 104;
const WEEKS_AFTER = 104;

/** Window mode — hovering "N개 더보기" this long opens the day-events list. */
const MORE_HOVER_DELAY_MS = 400;

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
  dayColors,
  interactive = true,
}) {
  const weekStart = week[0].date;
  const moreHoverTimerRef = useRef(null);
  const hostSurface = isDesktopSurfaceHost();

  const clearMoreHoverTimer = useCallback(() => {
    if (moreHoverTimerRef.current) {
      window.clearTimeout(moreHoverTimerRef.current);
      moreHoverTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearMoreHoverTimer(), [clearMoreHoverTimer]);

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
        const { solar, lunar, lunarDay } = getDayParts(
          date.getFullYear(),
          date.getMonth() + 1,
          date.getDate(),
        );
        const daySegments = weekLayout[dayKey] ?? [];
        const { visibleCount, hiddenEventCount } = resolveDayVisibleEventLimit(daySegments, eventCapacity);
        const sortedSegments = daySegments
          .slice()
          .sort((a, b) => compareEventsForDayDisplay(a.event, b.event, dayKey));
        const visibleSegments = sortedSegments.slice(0, visibleCount);
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
              event.preventDefault();
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
            <DayNumber solar={solar} lunarLabel={lunar} lunarDay={lunarDay} />
            <div className="day-events">
              {visibleSegments.map(({ event, segment, label, continuation }, displayLane) => {
                const cal = calendarById.get(event.calendarId);
                const color = cal?.color ?? '#f6bf26';
                const theme = getCalendarTheme(color);
                const accent = event.completed ? '#9aa0a6' : (theme.accent ?? theme.base);

                return (
                  <button
                    key={`${event.id}-${dayKey}`}
                    type="button"
                    data-event-id={getSeriesId(event) || event.id}
                    data-day-key={dayKey}
                    data-editable={event.calendarId === HOLIDAYS_KR_CALENDAR_ID ? '0' : '1'}
                    className={cn(
                      'event-bar',
                      `event-bar--${segment}`,
                      continuation && 'event-bar--continuation',
                      event.completed && 'is-completed',
                    )}
                    style={{
                      '--event-lane': displayLane,
                      '--event-accent': accent,
                      backgroundColor: event.completed ? 'transparent' : theme.bg,
                      color: event.completed ? '#80868b' : theme.text,
                    }}
                    onMouseEnter={(e) => {
                      if (hostSurface) return;
                      onEventMouseEnter?.(event, dayKey, e.currentTarget, e.clientX, e.clientY);
                    }}
                    onMouseMove={(e) => {
                      if (hostSurface) return;
                      onEventMouseMove?.(e.clientX, e.clientY);
                    }}
                    onMouseLeave={() => {
                      if (hostSurface) return;
                      onEventMouseLeave?.();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      // Desktop wallpaper: single-click does nothing (dblclick → quick-edit via native zones).
                      if (hostSurface) return;
                      onEventSelect(event, e.clientX, e.clientY, dayKey);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      (onEventDetail ?? onEventSelect)(event, e.clientX, e.clientY, dayKey);
                    }}
                  >
                    <EventAccentGlyph
                      shapeId={event.markerShape}
                      color={accent}
                      variant="bar"
                    />
                    {label && (
                      <span className="event-bar-label">
                        {label.time && (
                          <span className="event-time">{label.time}</span>
                        )}
                        {label.dayIndex != null && (
                          <span className="event-day-index">({label.dayIndex})</span>
                        )}
                        <EventTagIcons event={event} tags={tags} />
                        <span className={cn('event-title', event.completed && 'line-through opacity-70')}>
                          {label.title}
                        </span>
                      </span>
                    )}
                    <EventLinkIcon event={event} />
                    <EventAttachIcon event={event} />
                  </button>
                );
              })}
              {hiddenEventCount > 0 && (
                <EventMoreButton
                  count={hiddenEventCount}
                  lane={visibleSegments.length}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Desktop: click does nothing. Window: click → quick-edit.
                    if (!interactive || hostSurface) return;
                    clearMoreHoverTimer();
                    // Anchor to the day cell (not the small "더보기" button) so the quick-edit
                    // dialog opens at the same size as the event-bar-triggered one.
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
                    // Window: hover opens the day-events list. Desktop: no overlay on Host.
                    if (!interactive || hostSurface) return;
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
  onEventEdit,
  onVisibleMonthChange,
  onVisibleWeekChange,
  monthAlign = { token: 0, target: 'month' },
  weeksInViewport = 5,
  wheelLocked = false,
  dayColors = {},
  interactive = true,
}) {
  const weekStartsOn = getWeekStartsOn(viewOptions);
  const showWeekNumbers = shouldShowWeekNumbers(viewOptions);
  const weekdays = getOrderedWeekdays(weekStartsOn);
  const scrollRef = useRef(null);
  const scrollAnchorRef = useRef(viewDate);
  const viewDateRef = useRef(viewDate);
  const [scrollAnchorVersion, setScrollAnchorVersion] = useState(0);
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
    /** @type {Map<string, Record<string, object[]>>} */
    const layouts = new Map();
    for (const week of weeks) {
      const weekStartKey = toDateKey(week[0].date);
      layouts.set(weekStartKey, buildWeekEventLayout(week, events, tags));
    }
    return layouts;
  }, [weeks, events, tags]);

  const {
    clearPreview: clearHoverPreview,
    handleEventMouseEnter,
    handleEventMouseMove,
    handleEventMouseLeave,
  } = useEventHoverPreview({
    onOpen: ({ event, dayKey, clientX, clientY }) => {
      // Window: bar/list-row hover → detail. Click paths use onEventClick / onEventEdit.
      (onEventHover ?? onEventDetail)?.(event, clientX, clientY, dayKey);
    },
  });
  const [expandedDay, setExpandedDay] = useState(null);

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
    onSelectDate?.(date);
    if (anchorRect) {
      onDayQuickEdit?.(date, anchorRect);
      return;
    }
    (onCreateDate ?? onSelectDate)?.(date);
  }, [clearHoverPreview, interactive, onCreateDate, onDayQuickEdit, onSelectDate]);

  const handleEventSelect = useCallback((event, clientX, clientY, dayKey) => {
    // Window: single-click → quick-edit. DesktopHost skips click earlier.
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

  const handleMoreOpen = useCallback((date, dayKey, daySegments) => {
    if (!interactive || isDesktopSurfaceHost()) return;
    clearHoverPreview();
    const dayEvents = daySegments
      .slice()
      .sort((a, b) => compareEventsForDayDisplay(a.event, b.event, dayKey))
      .map((segment) => segment.event);
    const cell = document.querySelector(`.day-cell[data-date-key="${dayKey}"]`);
    // "N개 더보기" hover opens the day-events list; click opens quick-edit instead.
    setExpandedDay({
      date,
      dayKey,
      events: buildDayDisplayEvents(dayEvents, dayKey, tags),
      anchorRect: cell?.getBoundingClientRect?.() ?? null,
    });
  }, [clearHoverPreview, interactive, tags]);

  const reportInteractionZones = useCallback(() => {
    if (!interactive || !isNeutralinoDesktopShell() || !window.myCalendar?.setCreateEventZones) {
      void window.myCalendar?.clearCreateEventZones?.();
      void window.myCalendar?.clearEditEventZones?.();
      return;
    }
    const body = scrollRef.current;
    if (!body) {
      return;
    }

    // Shell chrome (title bar / header / footer) must never count as day-create / edit targets.
    // Scrolled day cells can still report client rects that overlap chrome even when clipped by CSS.
    let clipTop = 0;
    let clipBottom = window.innerHeight;
    for (const el of document.querySelectorAll('[data-shell-chrome]')) {
      const role = el.getAttribute('data-shell-chrome');
      const rect = el.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) continue;
      if (role === 'footer') {
        clipBottom = Math.min(clipBottom, rect.top);
      } else {
        clipTop = Math.max(clipTop, rect.bottom);
      }
    }
    const weekdays = body.parentElement?.querySelector?.('.month-weekdays');
    const weekdaysBottom = weekdays?.getBoundingClientRect?.().bottom;
    if (Number.isFinite(weekdaysBottom) && weekdaysBottom > clipTop) {
      clipTop = weekdaysBottom;
    }

    /** @type {Array<{ left: number, top: number, width: number, height: number, dateKey: string }>} */
    const createRects = [];
    for (const el of body.querySelectorAll('.day-cell[data-date-key]')) {
      const dateKey = el.getAttribute('data-date-key');
      if (!dateKey) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom <= clipTop || rect.top >= clipBottom) continue;
      const top = Math.max(Math.round(rect.top), Math.round(clipTop));
      const bottom = Math.min(Math.round(rect.bottom), Math.round(clipBottom));
      const height = bottom - top;
      if (height <= 0) continue;
      createRects.push({
        left: Math.round(rect.left),
        top,
        width: Math.round(rect.width),
        height,
        dateKey,
      });
    }
    void window.myCalendar.setCreateEventZones(
      createRects.length ? { clientRects: createRects } : null,
    );

    if (!window.myCalendar?.setEditEventZones) {
      return;
    }
    // Native hit-testing picks whichever zone rect contains the click, in DOM order — an event
    // bar's own rect must never extend past its own day cell (e.g. the 1px connector overlap on
    // --start/--middle segments, or a rect captured mid-reflow) or a click that looks like it's
    // on the next day's bar could resolve to the previous day's event instead.
    const dayCellRectByKey = new Map(createRects.map((r) => [r.dateKey, r]));
    /** @type {Array<{ left: number, top: number, width: number, height: number, eventId: string, dayKey: string }>} */
    const editRects = [];
    for (const el of body.querySelectorAll('.event-bar[data-event-id][data-day-key][data-editable="1"]')) {
      const eventId = el.getAttribute('data-event-id');
      const dayKey = el.getAttribute('data-day-key');
      if (!eventId || !dayKey) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom <= clipTop || rect.top >= clipBottom) continue;
      const cell = dayCellRectByKey.get(dayKey);
      const left = cell ? Math.max(Math.round(rect.left), cell.left) : Math.round(rect.left);
      const right = cell
        ? Math.min(Math.round(rect.left + rect.width), cell.left + cell.width)
        : Math.round(rect.left + rect.width);
      const width = right - left;
      if (width <= 0) continue;
      const top = Math.max(Math.round(rect.top), Math.round(clipTop), cell?.top ?? -Infinity);
      const bottom = Math.min(
        Math.round(rect.bottom),
        Math.round(clipBottom),
        cell ? cell.top + cell.height : Infinity,
      );
      const height = bottom - top;
      if (height <= 0) continue;
      editRects.push({
        left,
        top,
        width,
        height,
        eventId,
        dayKey,
      });
    }
    void window.myCalendar.setEditEventZones(
      editRects.length ? { clientRects: editRects } : null,
    );
  }, [interactive]);

  useEffect(() => {
    if (!interactive || !isNeutralinoDesktopShell() || !window.myCalendar?.setCreateEventZones) {
      void window.myCalendar?.clearCreateEventZones?.();
      void window.myCalendar?.clearEditEventZones?.();
      return undefined;
    }

    let cancelled = false;
    let embedded = false;
    /** @type {number[]} */
    const burstTimers = [];

    const reportNow = () => {
      if (cancelled || !embedded) return;
      reportInteractionZones();
    };

    const syncIfEmbedded = async () => {
      try {
        const status = await window.myCalendar.getWidgetStatus?.();
        // Keep zones while temporarily unlocked so the next day double-click still works.
        embedded = Boolean(status?.embedded || status?.embedSuspended)
          && !status?.editMode;
        // App WebView must not overwrite DesktopHost create/edit zones while wallpaper is active.
        try {
          const surface = new URLSearchParams(window.location.search).get('surface');
          if (surface !== 'desktop' && status?.embedded && !status?.embedSuspended) {
            embedded = false;
            return;
          }
        } catch {
          /* ignore */
        }
      } catch {
        embedded = false;
      }
      if (cancelled) return;
      if (!embedded) {
        // Only clear when this surface owns reporting (desktop host, or unlocked app).
        try {
          const surface = new URLSearchParams(window.location.search).get('surface');
          if (surface !== 'desktop') {
            const status = await window.myCalendar.getWidgetStatus?.();
            if (status?.embedded && !status?.embedSuspended) {
              return;
            }
          }
        } catch {
          /* ignore */
        }
        void window.myCalendar.clearCreateEventZones?.();
        void window.myCalendar.clearEditEventZones?.();
        return;
      }
      // Re-embed 직후 존이 비어 있으면 두 번째 더블클릭이 무시되므로 짧게 연속 동기화.
      requestAnimationFrame(reportNow);
      for (const delay of [50, 150, 400, 800]) {
        burstTimers.push(window.setTimeout(reportNow, delay));
      }
    };

    void syncIfEmbedded();
    const onScroll = () => {
      if (embedded) reportInteractionZones();
    };
    const body = scrollRef.current;
    body?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', syncIfEmbedded);
    window.addEventListener('mycalendar:widgetStatusChanged', syncIfEmbedded);
    const intervalId = window.setInterval(syncIfEmbedded, 800);

    return () => {
      cancelled = true;
      body?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', syncIfEmbedded);
      window.removeEventListener('mycalendar:widgetStatusChanged', syncIfEmbedded);
      window.clearInterval(intervalId);
      for (const id of burstTimers) {
        window.clearTimeout(id);
      }
      void window.myCalendar?.clearCreateEventZones?.();
      void window.myCalendar?.clearEditEventZones?.();
    };
  }, [interactive, reportInteractionZones, viewDate, weeksInViewport, displayMonth, displayYear, events]);

  return (
    <div
      className={cn('month-view', !showWeekNumbers && 'hide-week-numbers')}
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
              onEventDetail={(onEventDetail || onEventHover) ? handleEventDetail : undefined}
              onEventEdit={handleEventEdit}
              onEventMouseEnter={handleEventMouseEnter}
              onEventMouseMove={handleEventMouseMove}
              onEventMouseLeave={handleEventMouseLeave}
              onMoreOpen={handleMoreOpen}
              dayColors={dayColors}
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
          onClose={() => setExpandedDay(null)}
          onEventHover={(event, clientX, clientY) => {
            // List-row hover → read-only detail (same as schedule-bar hover).
            (onEventHover ?? onEventDetail)?.(event, clientX, clientY, expandedDay.dayKey);
          }}
          onEventClick={(event) => {
            // List-row double-click → quick-edit focused on that event (closes the list —
            // we're navigating away from it into the editor).
            setExpandedDay(null);
            clearHoverPreview();
            if (onEventEdit) {
              onEventEdit(event, expandedDay.dayKey);
              return;
            }
            onEventClick?.(event, 0, 0, expandedDay.dayKey);
          }}
          onEventDetail={onEventDetail ? (event, clientX, clientY) => {
            // List-row single-click → read-only detail popover. Keep the list open behind
            // it (same click-through-to-swap pattern as the main grid's EventPopover).
            handleEventDetail(event, clientX, clientY, expandedDay.dayKey);
          } : undefined}
        />
      )}
    </div>
  );
}
