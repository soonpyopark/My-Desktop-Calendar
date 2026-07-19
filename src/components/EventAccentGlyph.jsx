import { getMarkerShapeGlyph } from '../lib/eventMarkerShapes.js';
import { cn } from '../lib/cn.js';

/**
 * Leading indicator for an event bar (month/week grid) or day-events list row: the classic
 * calendar-colored vertical bar/dot by default, or a glyph (■ □ ○ ★ ☆ ※ •) when the event has
 * a custom `markerShape` (set via EventMarkerShapePicker).
 *
 * `variant="bar"` (default) sizes for the tall month-view event bar and relies on the ancestor
 * button's `--event-accent` CSS var for color. `variant="dot"` sizes for the small day-events
 * popover row and needs an explicit `color` prop instead.
 */
export default function EventAccentGlyph({ shapeId, color, variant = 'bar', className }) {
  const glyph = getMarkerShapeGlyph(shapeId);

  if (!glyph) {
    if (variant === 'dot') {
      return <span className={cn('event-dot', className)} style={{ background: color }} aria-hidden="true" />;
    }
    return (
      <span
        className={cn('event-bar-accent', shapeId === 'bar-round' && 'event-bar-accent--round', className)}
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      className={cn(variant === 'dot' ? 'event-dot-glyph' : 'event-bar-glyph', className)}
      style={{ color }}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}
