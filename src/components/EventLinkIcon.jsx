import { getEventLinks, getPrimaryEventLinkUrl, normalizeEventLinkUrl } from '../../shared/eventLinks.js';
import { openExternalUrl } from '../lib/openExternal.js';
import { cn } from '../lib/cn.js';

/**
 * Small link-icon shown at the trailing edge of an event bar (month/week grid) or quick-edit
 * list row when the event has one or more shortcut URLs. A single click is swallowed
 * (stopPropagation) so it doesn't trigger the row/bar's own select behavior; double-click
 * opens the primary (first) link in the user's default OS browser.
 */
export default function EventLinkIcon({
  event,
  url,
  className,
  title,
}) {
  const links = event
    ? getEventLinks(event)
    : (normalizeEventLinkUrl(url) ? [{ url: normalizeEventLinkUrl(url) }] : []);
  const href = links[0]?.url || getPrimaryEventLinkUrl(event) || normalizeEventLinkUrl(url);
  if (!href) return null;

  const count = links.length;
  const resolvedTitle = title
    ?? (count > 1
      ? `바로가기 ${count}개 (더블클릭: 첫 링크 열기)`
      : '바로가기 열기 (더블클릭)');

  return (
    <span
      className={cn('event-link-icon', className)}
      role="button"
      tabIndex={-1}
      title={resolvedTitle}
      aria-label={resolvedTitle}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void openExternalUrl(href);
      }}
    >
      <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
        <path
          fill="currentColor"
          d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"
        />
      </svg>
    </span>
  );
}
