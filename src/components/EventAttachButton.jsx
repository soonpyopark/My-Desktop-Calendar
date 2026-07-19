import { cn } from '../lib/cn.js';

function PaperclipGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16.5 6.5v10.25a4.25 4.25 0 0 1-8.5 0V6.75a2.75 2.75 0 0 1 5.5 0v9.5a1.25 1.25 0 0 1-2.5 0V7.5H9.5v8.75a2.75 2.75 0 0 0 5.5 0V6.75a4.25 4.25 0 0 0-8.5 0v10a5.75 5.75 0 0 0 11.5 0V6.5h-1.5z"
      />
    </svg>
  );
}

/**
 * Quick-edit footer trigger to attach files to the selected (saved) event.
 */
export default function EventAttachButton({
  count = 0,
  disabled = false,
  title = '파일 첨부',
  onClick,
  className,
  buttonClassName,
}) {
  const hasFiles = count > 0;
  return (
    <div className={cn('event-attach-picker-root', className)}>
      <button
        type="button"
        className={cn(
          'event-attach-picker-trigger',
          hasFiles && 'has-files',
          buttonClassName,
        )}
        title={hasFiles ? `${title} (${count})` : title}
        aria-label={hasFiles ? `${title} ${count}개` : title}
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (disabled) return;
          onClick?.(e);
        }}
      >
        <PaperclipGlyph />
        {hasFiles ? <span className="event-attach-picker-badge">{count > 9 ? '9+' : count}</span> : null}
      </button>
    </div>
  );
}
