import { useCallback, useEffect, useRef } from 'react';
import {
  getWeekDisplayMonth,
  getWeekStartContainingMonth,
  startOfWeek,
  toDateKey,
} from '../lib/calendarUtils.js';

export const WEEKS_IN_VIEWPORT = 5;

/**
 * @param {object} options
 * @param {React.RefObject<HTMLElement | null>} options.scrollRef
 * @param {{ date: Date }[][]} options.weeks
 * @param {number} [options.weeksInViewport=5] How many weeks to jump per scroll/swipe
 * @param {(year: number, month: number) => void} [options.onVisibleMonthChange]
 * @param {(weekStart: Date) => void} [options.onVisibleWeekChange]
 * @param {boolean} [options.wheelLocked] When true, ignore wheel (e.g. settings/search overlay open)
 */
export function useMonthWeekScroll({
  scrollRef,
  weeks,
  weeksInViewport = WEEKS_IN_VIEWPORT,
  onVisibleMonthChange,
  onVisibleWeekChange,
  wheelLocked = false,
}) {
  const weekRefs = useRef(new Map());
  const skipNextScrollRef = useRef(false);
  const aligningRef = useRef(false);
  /** Bumps on every programmatic align so a stale finishAlign cannot overwrite a newer nav. */
  const alignSeqRef = useRef(0);
  const rafRef = useRef(0);
  const wheelLockRef = useRef(false);
  const onVisibleMonthChangeRef = useRef(onVisibleMonthChange);
  const onVisibleWeekChangeRef = useRef(onVisibleWeekChange);
  const reportVisibleMonthRef = useRef(() => {});
  const step = Math.max(1, Number(weeksInViewport) || WEEKS_IN_VIEWPORT);

  useEffect(() => {
    onVisibleMonthChangeRef.current = onVisibleMonthChange;
  }, [onVisibleMonthChange]);

  useEffect(() => {
    onVisibleWeekChangeRef.current = onVisibleWeekChange;
  }, [onVisibleWeekChange]);

  const setWeekRef = useCallback((weekStartKey, node) => {
    if (node) {
      weekRefs.current.set(weekStartKey, node);
      return;
    }
    weekRefs.current.delete(weekStartKey);
  }, []);

  const findWeekIndexByStartKey = useCallback((weekStartKey) => {
    return weeks.findIndex((week) => toDateKey(week[0].date) === weekStartKey);
  }, [weeks]);

  const findWeekIndexContainingMonthDay = useCallback((year, monthIndex, day = 1) => {
    return weeks.findIndex((week) =>
      week.some(({ date }) =>
        date.getFullYear() === year
        && date.getMonth() === monthIndex
        && date.getDate() === day,
      ),
    );
  }, [weeks]);

  const restoreScrollSnapOnUserInput = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    const restoreSnap = () => {
      container.style.scrollSnapType = '';
      container.removeEventListener('pointerdown', restoreSnap, true);
    };

    if (container.style.scrollSnapType === 'none') {
      // Wheel is handled programmatically; restore snap on pointer or after timeout.
      container.addEventListener('pointerdown', restoreSnap, { once: true, capture: true });
      window.setTimeout(restoreSnap, 500);
    }
  }, [scrollRef]);

  const scrollToWeekIndex = useCallback((weekIndex, behavior = 'auto') => {
    const container = scrollRef.current;
    if (!container || weekIndex < 0 || weekIndex >= weeks.length) return false;

    const weekStartKey = toDateKey(weeks[weekIndex][0].date);
    const weekEl = weekRefs.current.get(weekStartKey);
    if (!weekEl) return false;

    const targetTop = container.scrollTop
      + weekEl.getBoundingClientRect().top
      - container.getBoundingClientRect().top;

    container.style.scrollSnapType = 'none';

    if (behavior === 'auto') {
      container.scrollTop = targetTop;
      restoreScrollSnapOnUserInput();
      return true;
    }

    // Block reportVisibleMonth for the whole smooth animation — intermediate months
    // were rebuilding the grid every frame and climbing WebView2 RAM past 1GB.
    aligningRef.current = true;
    container.scrollTo({ top: targetTop, behavior });

    let finished = false;
    const finishSmooth = () => {
      if (finished) return;
      finished = true;
      container.removeEventListener('scrollend', finishSmooth);
      restoreScrollSnapOnUserInput();
      aligningRef.current = false;
      reportVisibleMonthRef.current();
    };

    container.addEventListener('scrollend', finishSmooth, { once: true });
    window.setTimeout(finishSmooth, 480);
    return true;
  }, [restoreScrollSnapOnUserInput, scrollRef, weeks]);

  const scrollToWeekStart = useCallback((weekStartKey, behavior = 'auto') => {
    const weekIndex = findWeekIndexByStartKey(weekStartKey);
    if (weekIndex < 0) return;

    if (behavior === 'auto') {
      scrollToWeekIndex(weekIndex, behavior);
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToWeekIndex(weekIndex, behavior));
    });
  }, [findWeekIndexByStartKey, scrollToWeekIndex]);

  const getFirstVisibleWeekIndex = useCallback(() => {
    const container = scrollRef.current;
    // Hidden/Collapsed WebView (DesktopHost) often reports 0-height; do not treat week[0]
    // (~2 years before anchor → e.g. 2024-07) as the visible month.
    if (!container || container.clientHeight < 8 || container.clientWidth < 8) return -1;

    const containerTop = container.getBoundingClientRect().top;
    let bestIndex = -1;

    for (let index = 0; index < weeks.length; index += 1) {
      const weekEl = weekRefs.current.get(toDateKey(weeks[index][0].date));
      if (!weekEl) continue;

      const rect = weekEl.getBoundingClientRect();
      if (rect.height < 1) continue;

      if (bestIndex < 0) bestIndex = index;
      if (rect.top <= containerTop + 2) {
        bestIndex = index;
      }
    }

    return bestIndex;
  }, [scrollRef, weeks]);

  const reportVisibleMonth = useCallback(() => {
    const container = scrollRef.current;
    if (!container || aligningRef.current) return;
    if (container.clientHeight < 8 || container.clientWidth < 8) return;

    const weekIndex = getFirstVisibleWeekIndex();
    if (weekIndex < 0) return;

    const firstWeek = weeks[weekIndex];
    if (!firstWeek) return;

    const weekStart = firstWeek[0].date;
    const onWeekChange = onVisibleWeekChangeRef.current;
    if (onWeekChange) {
      skipNextScrollRef.current = true;
      onWeekChange(weekStart);
    }

    const onChange = onVisibleMonthChangeRef.current;
    if (!onChange) return;

    const { year, month } = getWeekDisplayMonth(firstWeek);
    skipNextScrollRef.current = true;
    onChange(year, month);
  }, [getFirstVisibleWeekIndex, weeks]);

  reportVisibleMonthRef.current = reportVisibleMonth;

  const scrollByWeek = useCallback((direction, behavior = 'smooth', weekStep = step) => {
    if (direction === 0) return;

    const delta = direction * Math.max(1, weekStep);
    const nextIndex = Math.max(
      0,
      Math.min(weeks.length - 1, getFirstVisibleWeekIndex() + delta),
    );
    scrollToWeekIndex(nextIndex, behavior);
  }, [getFirstVisibleWeekIndex, scrollToWeekIndex, step, weeks.length]);

  const scrollByMonth = useCallback((direction, behavior = 'smooth') => {
    if (direction === 0) return;

    const weekIndex = getFirstVisibleWeekIndex();
    const firstWeek = weeks[weekIndex];
    if (!firstWeek) return;

    const { year, month } = getWeekDisplayMonth(firstWeek);
    // month is 1-based from getWeekDisplayMonth
    const current = new Date(year, month - 1, 1);
    current.setMonth(current.getMonth() + direction);
    const targetYear = current.getFullYear();
    const targetMonthIndex = current.getMonth();

    let nextIndex = findWeekIndexContainingMonthDay(targetYear, targetMonthIndex, 1);
    if (nextIndex < 0) {
      nextIndex = Math.max(
        0,
        Math.min(weeks.length - 1, weekIndex + direction * step),
      );
    }
    scrollToWeekIndex(nextIndex, behavior);
  }, [
    findWeekIndexContainingMonthDay,
    getFirstVisibleWeekIndex,
    scrollToWeekIndex,
    step,
    weeks,
  ]);

  const scrollByViewport = useCallback((direction, behavior = 'smooth') => {
    if (step >= 5) {
      scrollByMonth(direction, behavior);
      return;
    }
    scrollByWeek(direction, behavior, step);
  }, [scrollByMonth, scrollByWeek, step]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const handleScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(reportVisibleMonth);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [reportVisibleMonth, scrollRef]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return undefined;

    const WHEEL_UNLOCK_MS = 420;

    const onWheel = (event) => {
      if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      if (event.deltaY === 0) return;

      // Always consume wheel so underlying month list cannot scroll under overlays.
      event.preventDefault();
      if (wheelLocked || wheelLockRef.current || aligningRef.current) return;

      wheelLockRef.current = true;
      const direction = event.deltaY > 0 ? 1 : -1;
      // Instant snap: avoids smooth-scroll intermediate month publishes / React churn.
      scrollByViewport(direction, 'auto');

      window.setTimeout(() => {
        wheelLockRef.current = false;
      }, WHEEL_UNLOCK_MS);
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', onWheel);
    };
  }, [scrollByViewport, scrollRef, wheelLocked]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const SWIPE_MIN_DISTANCE = 48;
    const SWIPE_MAX_DURATION = 700;

    /** @type {{ id: number, startX: number, startY: number, startTime: number, startWeekIndex: number } | null} */
    let activePointer = null;

    const finishSwipe = (clientX, clientY) => {
      if (!activePointer) return;

      const dx = clientX - activePointer.startX;
      const dy = clientY - activePointer.startY;
      const elapsed = Date.now() - activePointer.startTime;
      const startWeekIndex = activePointer.startWeekIndex;
      activePointer = null;

      if (elapsed > SWIPE_MAX_DURATION) return;
      if (Math.abs(dy) < SWIPE_MIN_DISTANCE) return;
      if (Math.abs(dx) > Math.abs(dy)) return;

      const direction = dy < 0 ? 1 : -1;
      const movedWeeks = getFirstVisibleWeekIndex() - startWeekIndex;
      const minMoved = step >= 5 ? 1 : step;
      if (direction === 1 && movedWeeks >= minMoved) return;
      if (direction === -1 && movedWeeks <= -minMoved) return;

      scrollByViewport(direction, 'smooth');
    };

    const onPointerDown = (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      activePointer = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTime: Date.now(),
        startWeekIndex: getFirstVisibleWeekIndex(),
      };
    };

    const onPointerUp = (event) => {
      if (!activePointer || event.pointerId !== activePointer.id) return;
      finishSwipe(event.clientX, event.clientY);
    };

    const onPointerCancel = (event) => {
      if (!activePointer || event.pointerId !== activePointer.id) return;
      activePointer = null;
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerCancel);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [getFirstVisibleWeekIndex, scrollByViewport, scrollRef, step]);

  const weekContainsMonthDay = useCallback((weekIndex, year, monthIndex, day = 1) => {
    const week = weeks[weekIndex];
    if (!week) return false;

    return week.some(({ date }) =>
      date.getFullYear() === year
      && date.getMonth() === monthIndex
      && date.getDate() === day,
    );
  }, [weeks]);

  const scrollToMonth = useCallback((year, monthIndex, weekStartsOn, behavior = 'auto') => {
    let weekIndex = findWeekIndexContainingMonthDay(year, monthIndex, 1);

    if (weekIndex < 0) {
      const weekStart = getWeekStartContainingMonth(year, monthIndex, weekStartsOn);
      weekIndex = findWeekIndexByStartKey(toDateKey(weekStart));
    }

    if (weekIndex < 0) {
      // Should be rare now that MonthView recenters the week buffer in the same render
      // as viewDate. Still publish the requested month so a missing row cannot leave the
      // header on a stale scroll-derived period.
      skipNextScrollRef.current = true;
      onVisibleMonthChangeRef.current?.(year, monthIndex + 1);
      return;
    }

    const seq = ++alignSeqRef.current;
    skipNextScrollRef.current = true;
    aligningRef.current = true;

    let attempts = 0;

    const finishAlign = () => {
      // A newer prev/next/year click started another align — drop this stale finish.
      if (seq !== alignSeqRef.current) return;

      const visibleIndex = getFirstVisibleWeekIndex();

      if (visibleIndex >= 0
        && !weekContainsMonthDay(visibleIndex, year, monthIndex, 1)
        && weekIndex >= 0) {
        scrollToWeekIndex(weekIndex, 'auto');
      }

      if (seq !== alignSeqRef.current) return;

      aligningRef.current = false;
      // Only publish month when layout is usable — avoids jumping to range start (week 0).
      // Prefer the align *target* when day-1 is in view so a mis-read first-visible week
      // (or a race with an older align) cannot overwrite chrome-nav viewDate.
      const landed = getFirstVisibleWeekIndex();
      if (landed < 0) return;
      if (weekContainsMonthDay(landed, year, monthIndex, 1)) {
        skipNextScrollRef.current = true;
        onVisibleMonthChangeRef.current?.(year, monthIndex + 1);
        return;
      }
      reportVisibleMonth();
    };

    const runScroll = () => {
      if (seq !== alignSeqRef.current) return;
      attempts += 1;
      const scrolled = scrollToWeekIndex(weekIndex, behavior);

      if (!scrolled && attempts < 8) {
        requestAnimationFrame(runScroll);
        return;
      }

      if (behavior === 'auto') {
        finishAlign();
        return;
      }

      requestAnimationFrame(finishAlign);
    };

    // Prefer a synchronous snap for `auto` (e.g. after `--weeks-in-viewport` resizes every
    // row mid-navigation). Callers in useLayoutEffect need scrollTop corrected before paint;
    // falling back to rAF only when week refs are not mounted yet.
    if (behavior === 'auto' && scrollToWeekIndex(weekIndex, 'auto')) {
      finishAlign();
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(runScroll);
    });
  }, [
    findWeekIndexByStartKey,
    findWeekIndexContainingMonthDay,
    getFirstVisibleWeekIndex,
    reportVisibleMonth,
    scrollToWeekIndex,
    weekContainsMonthDay,
  ]);

  const findWeekIndexContainingDate = useCallback((date) => {
    const targetKey = toDateKey(date);
    return weeks.findIndex((week) =>
      week.some(({ date: weekDate }) => toDateKey(weekDate) === targetKey),
    );
  }, [weeks]);

  const scrollToDateInViewport = useCallback((date, leadingWeeks = 0, behavior = 'auto') => {
    const weekIndex = findWeekIndexContainingDate(date);
    if (weekIndex < 0) return;

    const targetIndex = Math.max(0, Math.min(weeks.length - 1, weekIndex - leadingWeeks));
    const seq = ++alignSeqRef.current;

    // Guard like scrollToMonth: without this, a trailing native 'scroll' event from a
    // *previous* rapid nav click can fire reportVisibleMonth mid-align and briefly
    // publish a stale week — header and grid body would show different weeks for a
    // frame during fast repeated prev/next clicks.
    skipNextScrollRef.current = true;
    aligningRef.current = true;

    const finishAlign = () => {
      if (seq !== alignSeqRef.current) return;
      aligningRef.current = false;
      if (getFirstVisibleWeekIndex() >= 0) {
        reportVisibleMonth();
      }
    };

    if (behavior === 'auto' && scrollToWeekIndex(targetIndex, 'auto')) {
      finishAlign();
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (seq !== alignSeqRef.current) return;
        scrollToWeekIndex(targetIndex, behavior);
        requestAnimationFrame(finishAlign);
      });
    });
  }, [findWeekIndexContainingDate, getFirstVisibleWeekIndex, reportVisibleMonth, scrollToWeekIndex, weeks.length]);

  const scrollToDate = useCallback((date, weekStartsOn, behavior = 'smooth') => {
    scrollToWeekStart(toDateKey(startOfWeek(date, weekStartsOn)), behavior);
  }, [scrollToWeekStart]);

  const consumeSkipScroll = useCallback(() => {
    if (skipNextScrollRef.current) {
      skipNextScrollRef.current = false;
      return true;
    }
    return false;
  }, []);

  return {
    setWeekRef,
    scrollToMonth,
    scrollToDate,
    scrollToDateInViewport,
    scrollToWeekStart,
    scrollByWeek,
    consumeSkipScroll,
  };
}
