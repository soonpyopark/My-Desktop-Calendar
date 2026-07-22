import { useEffect } from 'react';
import { useAppDialog } from './AppDialogProvider.jsx';
import EventDetailContent from './EventDetailContent.jsx';
import {
  getAnchoredPopoverPosition,
  getCenteredPanelStyle,
  resolvePopoverAnchor,
  useAnchoredPopoverStyle,
} from '../lib/popoverPosition.js';

const toolbarBtnClass =
  'inline-flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-gcal-muted transition-colors hover:bg-gcal-surface-2 hover:text-gcal-heading';

export default function EventPopover({
  event,
  calendar,
  tags = [],
  dayKey,
  anchorRect,
  canEdit = false,
  onClose,
  onEdit,
  onDelete,
  onToggleCompleted,
}) {
  const { confirm } = useAppDialog();
  const popoverOptions = { width: 418, estimatedHeight: 360, padding: 12 };
  const resolvedAnchor = resolvePopoverAnchor(anchorRect);
  const { ref, style: anchoredStyle } = useAnchoredPopoverStyle(anchorRect, popoverOptions);

  // Backdrop stays click-through so clicking a different event bar underneath can swap this
  // popover. Outside clicks still close it via this document-level listener (capture phase).
  useEffect(() => {
    if (!event) return undefined;
    const handlePointerDown = (e) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target)) return;
      // Keep detail open while interacting with the day "더보기" list — row click swaps event.
      if (target instanceof Element && target.closest('.day-events-popover')) return;
      onClose();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    return () => document.removeEventListener('mousedown', handlePointerDown, true);
  }, [event, onClose, ref]);

  if (!event) return null;

  const completed = Boolean(event.completed);

  const handleDeleteClick = async () => {
    const ok = await confirm('이 일정을 정말 삭제하시겠습니까?', {
      variant: 'danger',
      confirmLabel: '삭제',
    });
    if (ok) onDelete(event);
  };

  const panelStyle = resolvedAnchor
    ? (anchoredStyle
      ?? getAnchoredPopoverPosition(resolvedAnchor.rect, {
        ...popoverOptions,
        anchorMode: resolvedAnchor.mode,
      }))
    : getCenteredPanelStyle({ padding: 16, maxWidth: 418 });

  // Above DayEventsPopover (z-46) so detail paints over the day list when both are open.
  // No dim backdrop — panel only (same feel as DayQuickEditPopover / Settings).
  return (
    <div
      className={
        anchorRect
          ? 'pointer-events-none fixed inset-0 z-[50]'
          : 'pointer-events-none fixed inset-0 z-[50] flex items-center justify-center overflow-y-auto p-4'
      }
      role="presentation"
    >
      <div
        ref={ref}
        className={`${resolvedAnchor ? 'fixed' : 'relative'} pointer-events-auto z-[51] flex w-[418px] max-w-full flex-col overflow-hidden rounded-xl bg-gcal-surface shadow-g-lg`}
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 pl-5 pr-3 pt-2">
          <label
            className="inline-flex h-[34px] cursor-pointer items-center"
            title={completed ? '완료 해제' : '완료로 표시'}
          >
            <input
              type="checkbox"
              className="event-popover-check"
              checked={completed}
              disabled={!canEdit}
              aria-label={completed ? '완료 해제' : '완료로 표시'}
              onChange={(e) => {
                if (!canEdit) return;
                void onToggleCompleted?.(event, e.target.checked);
              }}
            />
          </label>
          <div className="flex items-center gap-0.5">
            {canEdit && (
              <>
                <button type="button" className={toolbarBtnClass} onClick={() => onEdit(event)} aria-label="수정">
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"
                    />
                  </svg>
                </button>
                <button type="button" className={toolbarBtnClass} onClick={() => void handleDeleteClick()} aria-label="삭제">
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
                    />
                  </svg>
                </button>
              </>
            )}
            <button type="button" className={toolbarBtnClass} onClick={onClose} aria-label="닫기">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          </div>
        </div>

        <div className="settings-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-1">
          <EventDetailContent
            event={event}
            calendar={calendar}
            dayKey={dayKey}
            tags={tags}
            onTitleDoubleClick={canEdit && onEdit ? () => onEdit(event) : undefined}
          />
        </div>
      </div>
    </div>
  );
}
