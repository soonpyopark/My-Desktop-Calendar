/**
 * @param {Date} date
 * @param {number} [weekStartsOn=0]
 */
export function startOfWeek(date, weekStartsOn = 0) {
  const aligned = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (aligned.getDay() - weekStartsOn + 7) % 7;
  aligned.setDate(aligned.getDate() - offset);
  return aligned;
}

/**
 * @param {Date} date
 * @param {number} days
 */
export function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * @param {Date} weekStart
 */
export function buildWeekFromStart(weekStart) {
  return Array.from({ length: 7 }, (_, index) => ({
    date: addDays(weekStart, index),
    inMonth: true,
  }));
}

/**
 * @param {Date} anchorDate
 * @param {number} weekStartsOn
 * @param {number} weeksBefore
 * @param {number} weeksAfter
 */
export function generateWeekRange(anchorDate, weekStartsOn, weeksBefore, weeksAfter) {
  const anchorWeekStart = startOfWeek(anchorDate, weekStartsOn);
  const rangeStart = addDays(anchorWeekStart, -weeksBefore * 7);
  const totalWeeks = weeksBefore + weeksAfter + 1;

  return Array.from({ length: totalWeeks }, (_, index) => {
    const weekStart = addDays(rangeStart, index * 7);
    return buildWeekFromStart(weekStart);
  });
}

/**
 * @param {{ date: Date }[]} week
 */
export function getWeekDisplayMonth(week) {
  for (const { date } of week) {
    if (date.getDate() === 1) {
      return { year: date.getFullYear(), month: date.getMonth() + 1 };
    }
  }

  const counts = new Map();

  for (const { date } of week) {
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let bestKey = `${week[0].date.getFullYear()}-${week[0].date.getMonth()}`;
  let bestCount = -1;

  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }

  const [year, month] = bestKey.split('-').map(Number);
  return { year, month: month + 1 };
}

/**
 * @param {number} year
 * @param {number} month 0-11
 * @param {number} [weekStartsOn=0]
 */
export function getWeekStartContainingMonth(year, month, weekStartsOn = 0) {
  return startOfWeek(new Date(year, month, 1), weekStartsOn);
}

/**
 * @param {number} year
 * @param {number} month 0-11
 * @param {number} [weekStartsOn=0]
 */
export function getMonthFirstWeekStart(year, month, weekStartsOn = 0) {
  return getWeekStartContainingMonth(year, month, weekStartsOn);
}

/**
 * Number of calendar-grid week-rows a month spans (4, 5, or 6) given where its 1st
 * day falls relative to the week-start weekday — used to size month rows so a
 * 6-week month still fits without scrolling/resizing the window.
 * @param {number} year
 * @param {number} month 0-11
 * @param {number} [weekStartsOn=0]
 */
export function getWeeksInMonth(year, month, weekStartsOn = 0) {
  const firstWeekdayOffset = (new Date(year, month, 1).getDay() - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return Math.ceil((firstWeekdayOffset + daysInMonth) / 7);
}

/**
 * @param {Date} date
 * @param {number} [weekStartsOn=0]
 */
export function getWeekStartKey(date, weekStartsOn = 0) {
  return toDateKey(startOfWeek(date, weekStartsOn));
}

export function getOrderedWeekdays(weekStartsOn = 0) {
  const labels = ['일', '월', '화', '수', '목', '금', '토'];
  return [...labels.slice(weekStartsOn), ...labels.slice(0, weekStartsOn)];
}

/**
 * @param {number} year
 * @param {number} month 0-11
 * @param {number} [weekStartsOn=0] 0=Sun, 1=Mon, ...
 */
export function getMonthMatrix(year, month, weekStartsOn = 0) {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

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

  while (cells.length % 7 !== 0 || cells.length < 42) {
    const nextDay = cells.length - startOffset - daysInMonth + 1;
    cells.push({
      date: new Date(year, month + 1, nextDay),
      inMonth: false,
    });
  }

  /** @type {{ date: Date, inMonth: boolean }[][]} */
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}

/**
 * Year view: always 5 week rows per month.
 * @param {number} year
 * @param {number} month 0-11
 * @param {number} [weekStartsOn=0]
 */
export function getYearMonthWeeks(year, month, weekStartsOn = 0) {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

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

  while (cells.length < 35) {
    const nextDay = cells.length - startOffset - daysInMonth + 1;
    cells.push({
      date: new Date(year, month + 1, nextDay),
      inMonth: false,
    });
  }

  /** @type {{ date: Date, inMonth: boolean }[][]} */
  const weeks = [];
  for (let i = 0; i < 35; i += 7) {
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
 * @param {string} key
 */
export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
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
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @param {string} dayKey YYYY-MM-DD
 */
export function isDateInRange(startDate, endDate, dayKey) {
  return dayKey >= startDate && dayKey <= endDate;
}

/**
 * @param {object} event
 * @param {string} dayKey
 */
export function eventOnDay(event, dayKey) {
  return isDateInRange(event.startDate, event.endDate, dayKey);
}

/**
 * @param {Date} date
 */
export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * @param {string} startDate
 * @param {string} endDate
 */
export function formatEventRange(startDate, endDate) {
  const start = parseDateKey(startDate);
  const end = parseDateKey(endDate);
  const fmt = (d) =>
    `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;

  if (startDate === endDate) return fmt(start);
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${start.getFullYear()}년 ${start.getMonth() + 1}월 ${start.getDate()}일 - ${end.getDate()}일`;
  }
  return `${fmt(start)} - ${fmt(end)}`;
}

/**
 * @param {object} event
 * @param {string} dayKey
 */
export function getEventSegmentType(event, dayKey) {
  if (!eventOnDay(event, dayKey)) return null;
  const isStart = dayKey === event.startDate;
  const isEnd = dayKey === event.endDate;
  if (isStart && isEnd) return 'single';
  if (isStart) return 'start';
  if (isEnd) return 'end';
  return 'middle';
}
