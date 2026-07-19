import { resolveEventTags } from '../../shared/eventTags.js';
import { cn } from '../lib/cn.js';

/**
 * Colored tag glyph(s) for event bars / list rows — replaces "[행정]" text prefix.
 */
export default function EventTagIcons({
  event,
  tags = [],
  className,
  max = 3,
}) {
  const resolved = resolveEventTags(event, tags);
  if (!resolved.length) return null;

  const visible = resolved.slice(0, Math.max(1, max));
  const extra = resolved.length - visible.length;
  const names = resolved.map((tag) => tag.name).join(', ');

  return (
    <span
      className={cn('event-tag-icons', className)}
      title={names}
      aria-label={`태그: ${names}`}
    >
      {visible.map((tag) => (
        <svg
          key={tag.id}
          viewBox="0 0 24 24"
          width="11"
          height="11"
          className="event-tag-icon"
          aria-hidden="true"
          style={{ color: tag.color || '#9aa0a6' }}
        >
          <path
            fill="currentColor"
            d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58s1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41s-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"
          />
        </svg>
      ))}
      {extra > 0 && (
        <span className="event-tag-icons-extra" aria-hidden="true">+{extra}</span>
      )}
    </span>
  );
}
