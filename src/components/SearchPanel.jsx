import { useEffect, useMemo, useRef, useState } from 'react';
import { getEventLinks } from '../../shared/eventLinks.js';
import { formatTime24, isTimedEvent } from '../lib/eventFormat.js';
import {
  dateFromDateKey,
  formatSearchResultDate,
  searchCalendarEvents,
} from '../lib/searchEvents.js';
import { cn } from '../lib/cn.js';
import EventAttachIcon from './EventAttachIcon.jsx';
import EventLinkIcon from './EventLinkIcon.jsx';

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
  const inputRef = useRef(null);
  const calendarById = useMemo(
    () => new Map((calendars ?? []).map((calendar) => [calendar.id, calendar])),
    [calendars],
  );

  useEffect(() => {
    if (!open) {
      setQuery('');
      return undefined;
    }
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

  const results = useMemo(() => {
    if (!open) return [];
    return searchCalendarEvents({
      query,
      events,
      calendars,
      tags,
    });
  }, [open, query, events, calendars, tags]);

  if (!open) return null;

  const trimmed = query.trim();

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
        aria-label="검색어 입력"
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
              onChange={(event) => setQuery(event.target.value)}
              placeholder="검색어 입력"
              className="min-w-0 flex-1 border-0 bg-transparent py-2 text-base text-gcal-heading outline-none placeholder:text-gcal-muted"
              aria-label="검색어 입력"
            />
            {trimmed && (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gcal-muted transition-colors hover:bg-gcal-surface-2 hover:text-gcal-heading"
                onClick={() => setQuery('')}
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

          <div className="settings-scroll max-h-[min(70vh,560px)] overflow-y-auto">
            {!trimmed && (
              <p className="px-5 py-8 text-center text-sm text-gcal-muted">
                제목, 설명, 위치, 캘린더, 태그, 바로가기, 첨부파일 이름으로 검색합니다.
              </p>
            )}

            {trimmed && results.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-gcal-muted">
                “{trimmed}”에 대한 결과가 없습니다.
              </p>
            )}

            {trimmed && results.length > 0 && (
              <ul className="py-2">
                {results.map((event) => {
                  const calendar = calendarById.get(event.calendarId);
                  const dayKey = event.occurrenceDate ?? event.startDate;
                  const color = calendar?.color ?? event.color ?? '#039be5';
                  const timeLabel = isTimedEvent(event) ? formatTime24(event.startTime) : '종일';
                  const hasLinkOrAttach = getEventLinks(event).length > 0
                    || (Array.isArray(event.attachments) && event.attachments.length > 0);

                  return (
                    <li key={event.id}>
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
