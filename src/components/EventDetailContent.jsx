import { getEventLinks } from '../../shared/eventLinks.js';
import { resolveEventTags } from '../../shared/eventTags.js';
import { formatEventPopoverSchedule, formatRepeatLabel } from '../lib/eventFormat.js';
import { openExternalUrl } from '../lib/openExternal.js';
import { cn } from '../lib/cn.js';
import EventTagIcons from './EventTagIcons.jsx';

export default function EventDetailContent({ event, calendar, dayKey, tags = [] }) {
  const calendarColor = calendar?.color ?? event.color ?? '#039be5';
  const scheduleLine = formatEventPopoverSchedule(event, dayKey);
  const repeatLine = formatRepeatLabel(event);
  const description = event.description?.trim() ?? '';
  const links = getEventLinks(event);
  const completed = Boolean(event.completed);
  const title = event.title ?? '';
  const eventTags = resolveEventTags(event, tags);

  return (
    <>
      <div className="flex items-start gap-3">
        <span
          className="mt-1 h-3.5 w-3.5 shrink-0 rounded-sm"
          style={{ background: calendarColor }}
        />
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              'm-0 flex flex-wrap items-center gap-1.5 text-xl font-normal leading-snug text-gcal-heading',
              completed && 'line-through opacity-70',
            )}
          >
            {eventTags.length > 0 && (
              <EventTagIcons event={event} tags={tags} className="event-tag-icons--detail" />
            )}
            <span>{title}</span>
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-gcal-body">{scheduleLine}</p>
          {links.length > 0 && (
            <ul className="mt-1.5 m-0 list-none space-y-1 p-0">
              {links.map((item) => (
                <li key={item.id} className="flex items-start gap-1.5 text-sm leading-relaxed">
                  <svg viewBox="0 0 24 24" width="14" height="14" className="mt-0.5 shrink-0 text-gcal-muted" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"
                    />
                  </svg>
                  <a
                    href={item.url}
                    className="min-w-0 break-all text-gcal-blue hover:underline"
                    onClick={(e) => {
                      e.preventDefault();
                      void openExternalUrl(item.url);
                    }}
                  >
                    {item.title || item.url}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {description && (
            <p
              className="mt-3 w-full max-w-full overflow-x-hidden whitespace-pre-wrap break-all text-sm leading-relaxed text-gcal-body"
            >
              {description}
            </p>
          )}
          {repeatLine && (
            <p className="mt-2.5 text-sm text-gcal-body">{repeatLine}</p>
          )}
        </div>
      </div>

      <div className="mt-5 flex items-center gap-2 border-t border-gcal-border-light pt-4 text-sm text-gcal-muted">
        <svg viewBox="0 0 24 24" width="16" height="16" className="shrink-0" aria-hidden="true">
          <path fill="currentColor" d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z" />
        </svg>
        <span>{calendar?.name ?? '기본 캘린더'}</span>
      </div>
    </>
  );
}
