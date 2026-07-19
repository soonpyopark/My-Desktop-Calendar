import { getSeriesId } from '../../shared/eventOccurrences.js';
import { openEventAttachment } from '../lib/api.js';
import { cn } from '../lib/cn.js';

/**
 * Small paperclip icon at the trailing edge of an event bar / quick-edit row when the event
 * has file attachments. Click is swallowed so the row does not select; double-click opens
 * the first attachment (desktop native host).
 */
export default function EventAttachIcon({ event, className, title }) {
  const attachments = Array.isArray(event?.attachments) ? event.attachments : [];
  if (attachments.length === 0) return null;

  const count = attachments.length;
  const first = attachments[0];
  const eventId = getSeriesId(event) || event?.id;
  const resolvedTitle = title
    ?? (count > 1
      ? `첨부파일 ${count}개 (더블클릭: 첫 파일 열기)`
      : '첨부파일 열기 (더블클릭)');

  return (
    <span
      className={cn('event-attach-icon', className)}
      role="button"
      tabIndex={-1}
      title={resolvedTitle}
      aria-label={resolvedTitle}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!eventId || !first?.id) return;
        void openEventAttachment(eventId, first.id);
      }}
    >
      <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
        <path
          fill="currentColor"
          d="M16.5 6.5v10.25a4.25 4.25 0 0 1-8.5 0V6.75a2.75 2.75 0 0 1 5.5 0v9.5a1.25 1.25 0 0 1-2.5 0V7.5H9.5v8.75a2.75 2.75 0 0 0 5.5 0V6.75a4.25 4.25 0 0 0-8.5 0v10a5.75 5.75 0 0 0 11.5 0V6.5h-1.5z"
        />
      </svg>
    </span>
  );
}
