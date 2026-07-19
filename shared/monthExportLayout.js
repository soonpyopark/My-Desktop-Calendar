import { toLunar } from 'kor-lunar';
import { DEFAULT_VIEW_OPTIONS } from './constants.js';
import { filterEventsForViewer } from './calendarVisibility.js';
import { formatExportEventLineText, compareEventsForDayDisplay } from './eventBarFormat.js';
import { buildWeekEventLayout } from './monthWeekLayout.js';
import { EXPORT_COLORS } from './exportColors.js';

export { EXPORT_COLORS };

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * @param {number} year
 * @param {number} month 0-11
 * @param {number} [weekStartsOn=0]
 */
export function getMonthWeeksForExport(year, month, weekStartsOn = 0) {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();
  // 4/5/6 week-rows (28/35/42 cells) depending on where day 1 falls — a hardcoded 35
  // silently dropped the 6th row for months like a 31-day month starting near the
  // end of the week (e.g. May 2026), so Excel/PDF exports missed its last week.
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  /** @type {{ date: Date, inMonth: boolean }[]} */
  const cells = [];

  for (let i = startOffset - 1; i >= 0; i -= 1) {
    cells.push({
      date: new Date(year, month - 1, prevMonthDays - i),
      inMonth: false,
    });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ date: new Date(year, month, day), inMonth: true });
  }

  while (cells.length < totalCells) {
    const nextDay = cells.length - startOffset - daysInMonth + 1;
    cells.push({
      date: new Date(year, month + 1, nextDay),
      inMonth: false,
    });
  }

  /** @type {{ date: Date, inMonth: boolean }[][]} */
  const weeks = [];
  for (let i = 0; i < totalCells; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}

/**
 * @param {Date} date
 */
export function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * @param {Date} date
 */
export function getWeekNumber(date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 */
export function getLunarInfo(year, month, day) {
  try {
    const lunar = toLunar(year, month, day);
    return {
      day: lunar.day,
      month: lunar.month,
      isLeapMonth: Boolean(lunar.isLeapMonth),
      secha: lunar.secha ?? '',
    };
  } catch {
    return { day: 0, month: 0, isLeapMonth: false, secha: '' };
  }
}

/**
 * @param {{ day: number, month: number, isLeapMonth?: boolean }} lunar
 */
export function formatLunarDayLabel(lunar) {
  if (!lunar?.day) return null;
  const month = lunar.isLeapMonth ? `윤${lunar.month}` : `${lunar.month}`;
  return `${month}. ${lunar.day}.`;
}

/**
 * @param {number} year
 * @param {number} month 1-12
 */
export function getLunarMonthLabel(year, month) {
  const start = getLunarInfo(year, month, 1);
  const lastDay = new Date(year, month, 0).getDate();
  const end = getLunarInfo(year, month, lastDay);

  const startMonth = start.isLeapMonth ? `윤${start.month}` : `${start.month}`;
  const endMonth = end.isLeapMonth ? `윤${end.month}` : `${end.month}`;
  const yearLabel = start.secha ? `${start.secha}년` : '';

  if (startMonth === endMonth) {
    return `${yearLabel} ${startMonth}월`.trim();
  }
  return `${yearLabel} ${startMonth}월 ~ ${endMonth}월`.trim();
}

/**
 * @param {Date} date
 * @param {boolean} inMonth
 * @param {boolean} isToday
 */
export function getSolarTextColor(date, inMonth, isToday) {
  if (isToday) return EXPORT_COLORS.todayCircle;
  if (!inMonth) return EXPORT_COLORS.otherMonth;
  if (date.getDay() === 0) return EXPORT_COLORS.sunday;
  if (date.getDay() === 6) return EXPORT_COLORS.saturday;
  return EXPORT_COLORS.heading;
}

/**
 * @param {object} store
 * @param {{ scope: 'month' | 'year', year: number, month?: number }} period
 * @param {{ asAdmin?: boolean }} [options]
 */
export function prepareMonthExportLayout(store, period, options = {}) {
  if (period.scope !== 'month') {
    return null;
  }

  const asAdmin = options.asAdmin === true;

  const year = period.year;
  const month = period.month ?? 1;
  const monthIndex = month - 1;
  const viewOptions = {
    ...DEFAULT_VIEW_OPTIONS,
    ...(store?.settings?.viewOptions ?? {}),
  };
  const weekStartsOn = viewOptions.weekStartsOnSunday === false ? 1 : 0;
  const showWeekNumbers = viewOptions.showWeekNumbers !== false;

  const calendars = store?.calendars ?? [];
  const calendarMap = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const visibleEvents = filterEventsForViewer(store?.events ?? [], calendars, asAdmin);

  const today = new Date();
  const todayKey = toDateKey(today);
  const weeks = getMonthWeeksForExport(year, monthIndex, weekStartsOn);
  const weekdayHeaders = [...WEEKDAY_LABELS.slice(weekStartsOn), ...WEEKDAY_LABELS.slice(0, weekStartsOn)];

  const weekRows = weeks.map((week) => {
    const weekStart = week[0].date;
    const weekLayout = buildWeekEventLayout(week, visibleEvents);

    const days = week.map(({ date, inMonth }) => {
      const dayKey = toDateKey(date);
      const lunar = getLunarInfo(date.getFullYear(), date.getMonth() + 1, date.getDate());
      const lunarLabel = formatLunarDayLabel(lunar);
      const daySegments = weekLayout[dayKey] ?? [];

      const dayEvents = [...daySegments]
        .sort((a, b) => compareEventsForDayDisplay(a.event, b.event, dayKey))
        .map(({ event, segment, lane }) => {
        const color = calendarMap.get(event.calendarId)?.color ?? '#f6bf26';
        return {
          id: `${event.id}-${dayKey}`,
          line: formatExportEventLineText(event, dayKey),
          color,
          segment,
          lane,
        };
        });

      return {
        date,
        dayKey,
        inMonth,
        solar: date.getDate(),
        lunarLabel,
        isToday: dayKey === todayKey,
        dayOfWeek: date.getDay(),
        solarColor: getSolarTextColor(date, inMonth, dayKey === todayKey),
        events: dayEvents,
      };
    });

    return {
      weekNumber: getWeekNumber(weekStart),
      days,
    };
  });

  return {
    year,
    month,
    title: `${year}년 ${month}월`,
    lunarMonthLabel: getLunarMonthLabel(year, month),
    showWeekNumbers,
    weekStartsOn,
    weekdayHeaders,
    weekRows,
  };
}
