import EventDetailContent from './EventDetailContent.jsx';
import { cn } from '../lib/cn.js';
import {
  getAnchoredPopoverPosition,
  useAnchoredPopoverStyle,
} from '../lib/popoverPosition.js';

export default function EventHoverPreview({ event, calendar, tags = [], dayKey, anchorRect, elevated = false }) {
  const popoverOptions = { width: 418, estimatedHeight: 320, padding: 12 };
  const { ref, style: anchoredStyle } = useAnchoredPopoverStyle(anchorRect, popoverOptions);

  if (!event || !anchorRect) return null;

  const style = anchoredStyle ?? getAnchoredPopoverPosition(anchorRect, popoverOptions);

  return (
    <div
      ref={ref}
      className={cn(
        'pointer-events-none fixed flex w-[418px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl bg-gcal-surface shadow-g-lg',
        elevated ? 'z-[26]' : 'z-[25]',
      )}
      style={style}
      role="tooltip"
    >
      <div className="settings-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
        <EventDetailContent event={event} calendar={calendar} dayKey={dayKey} tags={tags} />
      </div>
    </div>
  );
}
