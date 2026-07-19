import { EVENT_MARKER_SHAPES } from '../lib/eventMarkerShapes.js';
import { cn } from '../lib/cn.js';

/**
 * Grid of selectable per-event indicator shapes, previewed in the event's calendar color.
 * Mirrors DayColorPalette's plain swatch-grid pattern — no portal; callers anchor the flyout
 * with their own positioned wrapper (see DayQuickEditPopover / EventEditor).
 */
export default function EventMarkerShapePicker({ value, color = '#1a73e8', onChange, compact = false, className }) {
  const selected = value ?? 'bar';
  return (
    <div
      className={cn('marker-shape-palette', compact && 'marker-shape-palette--compact', className)}
      role="listbox"
      aria-label="일정 표시 도형"
    >
      {EVENT_MARKER_SHAPES.map((shape) => (
        <button
          key={shape.id}
          type="button"
          role="option"
          aria-selected={selected === shape.id}
          className={cn('marker-shape-swatch', selected === shape.id && 'active')}
          title={shape.label}
          aria-label={shape.label}
          style={{ color }}
          onClick={() => onChange?.(shape.id)}
        >
          {shape.glyph ? (
            <span className="marker-shape-glyph-preview" aria-hidden="true">{shape.glyph}</span>
          ) : (
            <span
              className={cn('marker-shape-bar-preview', shape.id === 'bar-round' && 'marker-shape-bar-preview--round')}
              style={{ background: color }}
              aria-hidden="true"
            />
          )}
        </button>
      ))}
    </div>
  );
}
