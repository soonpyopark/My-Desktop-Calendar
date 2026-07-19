import { getWeekdayCellClass, getWeekdayTextClass } from '../lib/colors.js';
import { cn } from '../lib/cn.js';
import { getOrderedWeekdays, getWeekNumber, getYearMonthWeeks, isSameDay } from '../lib/calendarUtils.js';
import { DEFAULT_VIEW_OPTIONS } from '../../shared/constants.js';
import { shouldShowWeekNumbers, getWeekStartsOn } from '../lib/viewOptions.js';

function MiniMonth({ year, monthIndex, selectedDate, viewOptions, onSelectMonth, onSelectDate, onDayQuickEdit, interactive = true }) {
  const weekStartsOn = getWeekStartsOn(viewOptions);
  const showWeekNumbers = shouldShowWeekNumbers(viewOptions);
  const weekdays = getOrderedWeekdays(weekStartsOn);
  const weeks = getYearMonthWeeks(year, monthIndex, weekStartsOn);
  const today = new Date();

  return (
    <section className={cn('year-month', !showWeekNumbers && 'hide-week-numbers')}>
      <button
        type="button"
        className="year-month-title"
        onClick={() => onSelectMonth(monthIndex)}
      >
        {monthIndex + 1}월
      </button>

      <div className="year-month-body">
        <div className="year-month-weekdays">
          {showWeekNumbers && <div className="year-week-number-header" />}
          {weekdays.map((label, index) => (
            <div key={label} className={cn('year-weekday', getWeekdayTextClass((weekStartsOn + index) % 7))}>
              {label}
            </div>
          ))}
        </div>

        {showWeekNumbers && <div className="year-week-number-track" aria-hidden />}

        {weeks.map((week, weekIndex) => {
          const weekStart = week[0].date;
          return (
            <div
              key={weekStart.toISOString()}
              className="year-month-week"
              style={{ gridRow: weekIndex + 2 }}
            >
              {showWeekNumbers && <div className="year-week-number">{getWeekNumber(weekStart)}</div>}
              {week.map(({ date, inMonth }) => {
                const isToday = isSameDay(date, today);
                const isSelected = isSameDay(date, selectedDate);
                const weekdayClass = getWeekdayCellClass(date.getDay());

                return (
                  <button
                    key={date.toISOString()}
                    type="button"
                    disabled={!interactive}
                    className={cn(
                      'year-day',
                      weekdayClass,
                      !inMonth && 'other-month',
                      isToday && 'today',
                      isSelected && !isToday && 'selected',
                      !interactive && 'year-day-readonly',
                    )}
                    onClick={interactive ? () => onSelectDate?.(date) : undefined}
                    onDoubleClick={interactive ? () => onDayQuickEdit?.(date) : undefined}
                    aria-label={`${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일`}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function YearView({
  viewDate,
  selectedDate,
  viewOptions = DEFAULT_VIEW_OPTIONS,
  onSelectMonth,
  onSelectDate,
  onDayQuickEdit,
  interactive = true,
}) {
  const year = viewDate.getFullYear();

  return (
    <div className="year-view">
      <div className="year-grid">
        {Array.from({ length: 12 }, (_, monthIndex) => (
          <MiniMonth
            key={monthIndex}
            year={year}
            monthIndex={monthIndex}
            selectedDate={selectedDate}
            viewOptions={viewOptions}
            onSelectMonth={onSelectMonth}
            onSelectDate={onSelectDate}
            onDayQuickEdit={onDayQuickEdit}
            interactive={interactive}
          />
        ))}
      </div>
    </div>
  );
}
