import { useEffect, useMemo, useRef, useState } from 'react';
import { getEventLinks } from '../../shared/eventLinks.js';
import { formatTime24, isTimedEvent } from '../lib/eventFormat.js';
import {
  SEARCH_PAGE_SIZE_OPTIONS,
  buildSearchPageItems,
  dateFromDateKey,
  formatSearchResultDate,
  getDefaultSearchRange,
  normalizeSearchRange,
  searchCalendarEvents,
  toDateKey,
} from '../lib/searchEvents.js';
import { cn } from '../lib/cn.js';
import EventAttachIcon from './EventAttachIcon.jsx';
import EventLinkIcon from './EventLinkIcon.jsx';

const PAGE_SIZE_OPTIONS = SEARCH_PAGE_SIZE_OPTIONS;

const pagerBtnClass =
  'inline-flex h-8 w-8 items-center justify-center rounded-full text-gcal-muted transition-colors hover:bg-gcal-surface-2 hover:text-gcal-heading disabled:pointer-events-none disabled:opacity-35';

const rangeBtnClass =
  'inline-flex h-8 w-8 items-center justify-center rounded-full text-gcal-muted transition-colors hover:bg-gcal-page hover:text-gcal-heading';

/** @param {string} dateKey @param {number} yearDelta */
function shiftDateKeyByYears(dateKey, yearDelta) {
  const date = dateFromDateKey(dateKey);
  if (Number.isNaN(date.getTime())) return dateKey;
  date.setFullYear(date.getFullYear() + yearDelta);
  return toDateKey(date);
}

function FirstPageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M18.41 16.59 13.82 12l4.59-4.59L17 6l-6 6 6 6 1.41-1.41zM6 6h2v12H6V6z" />
    </svg>
  );
}

function PrevPageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12l4.58-4.59z" />
    </svg>
  );
}

function NextPageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6-6-6z" />
    </svg>
  );
}

function LastPageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d="M5.59 7.41 10.18 12l-4.59 4.59L7 18l6-6-6-6-1.41 1.41zM16 6h2v12h-2V6z" />
    </svg>
  );
}

function PrevYearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M17.59 18 19 16.59 14.42 12 19 7.41 17.59 6l-6 6 6 6zM11.59 18 13 16.59 8.42 12 13 7.41 11.59 6l-6 6 6 6z"
      />
    </svg>
  );
}

function NextYearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6.41 6 5 7.41 9.58 12 5 16.59 6.41 18l6-6-6-6zM12.41 6 11 7.41 15.58 12 11 16.59 12.41 18l6-6-6-6z"
      />
    </svg>
  );
}

function DefaultRangeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"
      />
    </svg>
  );
}

/**
 * Google Calendar-style event search overlay.
 *
 * @param {{
 *   open: boolean,
 *   events: object[],
 *   calendars: object[],
 *   tags?: object[],
 *   onClose: () => void,
 *   onSelectResult: (payload: { event: object, date: Date, dayKey: string }) => void,
 * }} props
 */
export default function SearchPanel({ open, events, calendars, tags = [], onClose, onSelectResult }) {
  const [query, setQuery] = useState('');
  const [rangeStart, setRangeStart] = useState(() => getDefaultSearchRange().start);
  const [rangeEnd, setRangeEnd] = useState(() => getDefaultSearchRange().end);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const inputRef = useRef(null);
  const calendarById = useMemo(
    () => new Map((calendars ?? []).map((calendar) => [calendar.id, calendar])),
    [calendars],
  );

  useEffect(() => {
    if (!open) {
      setQuery('');
      setPage(1);
      return undefined;
    }
    const defaults = getDefaultSearchRange();
    setRangeStart(defaults.start);
    setRangeEnd(defaults.end);
    setPage(1);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const range = useMemo(
    () => normalizeSearchRange(rangeStart, rangeEnd),
    [rangeStart, rangeEnd],
  );

  const allResults = useMemo(() => {
    if (!open) return [];
    return searchCalendarEvents({
      query,
      events,
      calendars,
      tags,
      rangeStart: range.start,
      rangeEnd: range.end,
    });
  }, [open, query, events, calendars, tags, range.start, range.end]);

  const total = allResults.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const pageItems = useMemo(
    () => buildSearchPageItems(safePage, totalPages),
    [safePage, totalPages],
  );

  const pageResults = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return allResults.slice(start, start + pageSize);
  }, [allResults, safePage, pageSize]);

  if (!open) return null;

  const trimmed = query.trim();

  const resetRange = () => {
    const defaults = getDefaultSearchRange();
    setRangeStart(defaults.start);
    setRangeEnd(defaults.end);
    setPage(1);
  };

  const shiftRangeByYears = (yearDelta) => {
    const next = normalizeSearchRange(
      shiftDateKeyByYears(rangeStart, yearDelta),
      shiftDateKeyByYears(rangeEnd, yearDelta),
    );
    setRangeStart(next.start);
    setRangeEnd(next.end);
    setPage(1);
  };

  return (
    <div
      className="fixed inset-0 z-[55] flex flex-col"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="mx-auto mt-3 w-full max-w-[720px] px-3 sm:mt-6 sm:px-4"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="일정 검색"
      >
        <div className="shell-solid-surface overflow-hidden rounded-2xl shadow-[0_8px_28px_rgba(0,0,0,0.18)]">
          <div className="flex items-center gap-2 border-b border-gcal-border-light px-3 py-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center text-gcal-muted" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22">
                <path
                  fill="currentColor"
                  d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C8.01 14 6 11.99 6 9.5S8.01 5 10.5 5 15 7.01 15 9.5 12.99 14 10.5 14z"
                />
              </svg>
            </span>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="검색어 입력"
              className="min-w-0 flex-1 border-0 bg-transparent py-2 text-base text-gcal-heading outline-none placeholder:text-gcal-muted"
              aria-label="검색어 입력"
            />
            {trimmed && (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gcal-muted transition-colors hover:bg-gcal-surface-2 hover:text-gcal-heading"
                onClick={() => {
                  setQuery('');
                  setPage(1);
                }}
                aria-label="검색어 지우기"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"
                  />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="rounded-full px-3 py-1.5 text-sm font-medium text-gcal-blue transition-colors hover:bg-gcal-blue-soft"
              onClick={onClose}
            >
              닫기
            </button>
          </div>

          <div className="flex items-center gap-2 border-b border-gcal-border-light bg-gcal-surface-2 px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 pl-[10px]">
              <label className="flex min-w-0 items-center gap-1.5 text-xs text-gcal-muted">
                <span className="shrink-0">기간</span>
                <input
                  type="date"
                  value={rangeStart}
                  onChange={(event) => {
                    setRangeStart(event.target.value);
                    setPage(1);
                  }}
                  className="h-8 rounded-lg border border-gcal-border bg-gcal-input px-2 text-sm text-gcal-heading outline-none focus:border-gcal-blue"
                  aria-label="검색 시작일"
                />
                <span aria-hidden="true">~</span>
                <input
                  type="date"
                  value={rangeEnd}
                  onChange={(event) => {
                    setRangeEnd(event.target.value);
                    setPage(1);
                  }}
                  className="h-8 rounded-lg border border-gcal-border bg-gcal-input px-2 text-sm text-gcal-heading outline-none focus:border-gcal-blue"
                  aria-label="검색 종료일"
                />
              </label>
              <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="검색 기간 이동">
                <button
                  type="button"
                  className={rangeBtnClass}
                  onClick={() => shiftRangeByYears(-1)}
                  aria-label="1년 이전"
                  title="1년 이전"
                >
                  <PrevYearIcon />
                </button>
                <button
                  type="button"
                  className={rangeBtnClass}
                  onClick={resetRange}
                  aria-label="기본 기간 (±1년)"
                  title="기본 기간 (±1년)"
                >
                  <DefaultRangeIcon />
                </button>
                <button
                  type="button"
                  className={rangeBtnClass}
                  onClick={() => shiftRangeByYears(1)}
                  aria-label="1년 이후"
                  title="1년 이후"
                >
                  <NextYearIcon />
                </button>
              </div>
            </div>
            <label className="flex shrink-0 items-center gap-1.5 px-3 text-xs text-gcal-muted">
              <span className="shrink-0">페이지당</span>
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value) || 20);
                  setPage(1);
                }}
                className="h-8 rounded-lg border border-gcal-border bg-gcal-input px-2 text-sm text-gcal-heading outline-none focus:border-gcal-blue"
                aria-label="페이지당 결과 수"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="settings-scroll max-h-[min(70vh,560px)] overflow-y-auto">
            {!trimmed && (
              <p className="px-5 py-8 text-center text-sm text-gcal-muted">
                제목, 설명, 위치, 캘린더, 태그, 바로가기, 첨부파일 이름으로 검색합니다.
                <br />
                기본 기간은 오늘 기준 앞뒤 1년이며, 위에서 바꿀 수 있습니다.
              </p>
            )}

            {trimmed && total === 0 && (
              <p className="px-5 py-8 text-center text-sm text-gcal-muted">
                “{trimmed}”에 대한 결과가 없습니다.
              </p>
            )}

            {trimmed && total > 0 && (
              <>
                <p className="border-b border-gcal-border-light px-4 py-2 text-xs text-gcal-muted">
                  전체 {total.toLocaleString('ko-KR')}건
                  {totalPages > 1 ? ` · ${safePage} / ${totalPages}페이지` : ''}
                </p>
                <ul className="py-2">
                  {pageResults.map((event) => {
                    const calendar = calendarById.get(event.calendarId);
                    const dayKey = event.occurrenceDate ?? event.startDate;
                    const color = calendar?.color ?? event.color ?? '#039be5';
                    const timeLabel = isTimedEvent(event) ? formatTime24(event.startTime) : '종일';
                    const hasLinkOrAttach = getEventLinks(event).length > 0
                      || (Array.isArray(event.attachments) && event.attachments.length > 0);
                    const rowKey = `${event.id}-${dayKey}`;

                    return (
                      <li key={rowKey}>
                        <button
                          type="button"
                          className={cn(
                            'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                            'hover:bg-gcal-surface focus:bg-gcal-surface focus:outline-none',
                          )}
                          onClick={() => {
                            onSelectResult({
                              event,
                              date: dateFromDateKey(dayKey),
                              dayKey,
                            });
                          }}
                        >
                          <span
                            className="mt-1.5 h-3 w-3 shrink-0 rounded-sm"
                            style={{ background: color }}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="min-w-0 flex-1 truncate text-sm font-medium text-gcal-heading">
                                {event.title || '(제목 없음)'}
                              </span>
                              {hasLinkOrAttach && (
                                <span className="event-bar-trailing shrink-0">
                                  <EventLinkIcon event={event} />
                                  <EventAttachIcon event={event} />
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 block text-xs text-gcal-muted">
                              {formatSearchResultDate(dayKey)}
                              {' · '}
                              {timeLabel}
                              {calendar?.name ? ` · ${calendar.name}` : ''}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {totalPages > 1 && (
                  <nav
                    className="flex flex-wrap items-center justify-center gap-0.5 border-t border-gcal-border-light px-2 py-2.5"
                    aria-label="검색 결과 페이지"
                  >
                    <button
                      type="button"
                      className={pagerBtnClass}
                      disabled={safePage <= 1}
                      onClick={() => setPage(1)}
                      aria-label="맨 처음"
                      title="맨 처음"
                    >
                      <FirstPageIcon />
                    </button>
                    <button
                      type="button"
                      className={pagerBtnClass}
                      disabled={safePage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      aria-label="이전"
                      title="이전"
                    >
                      <PrevPageIcon />
                    </button>

                    {pageItems.map((item, index) => (
                      item === 'ellipsis' ? (
                        <span
                          key={`e-${index}`}
                          className="inline-flex h-8 min-w-[1.5rem] items-center justify-center px-1 text-sm text-gcal-muted"
                          aria-hidden="true"
                        >
                          …
                        </span>
                      ) : (
                        <button
                          key={item}
                          type="button"
                          className={cn(
                            'inline-flex h-8 min-w-[2rem] items-center justify-center rounded-full px-2 text-sm font-medium transition-colors',
                            item === safePage
                              ? 'bg-gcal-blue text-white'
                              : 'text-gcal-heading hover:bg-gcal-surface-2',
                          )}
                          aria-label={`${item}페이지`}
                          aria-current={item === safePage ? 'page' : undefined}
                          onClick={() => setPage(item)}
                        >
                          {item}
                        </button>
                      )
                    ))}

                    <button
                      type="button"
                      className={pagerBtnClass}
                      disabled={safePage >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      aria-label="다음"
                      title="다음"
                    >
                      <NextPageIcon />
                    </button>
                    <button
                      type="button"
                      className={pagerBtnClass}
                      disabled={safePage >= totalPages}
                      onClick={() => setPage(totalPages)}
                      aria-label="맨 끝"
                      title="맨 끝"
                    >
                      <LastPageIcon />
                    </button>
                  </nav>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
