/**
 * Per-event indicator shown at the leading edge of the event bar (month/week grid) and in the
 * day-events list popover, in place of the plain calendar-colored vertical bar. Selected via
 * EventMarkerShapePicker (quick-edit footer / event editor) and persisted as `event.markerShape`.
 * `glyph: null` entries render as a colored bar/dot (CSS-driven); the rest render the character
 * itself, tinted with the event's calendar color.
 */
export const EVENT_MARKER_SHAPES = [
  { id: 'bar', label: '기본 세로선', glyph: null },
  { id: 'bar-round', label: '둥근 세로선', glyph: null },
  { id: 'square-filled', label: '채운 사각형', glyph: '■' },
  { id: 'square-outline', label: '빈 사각형', glyph: '□' },
  { id: 'circle-outline', label: '원', glyph: '○' },
  { id: 'dot', label: '작은 동그라미', glyph: '•' },
  { id: 'star-filled', label: '채운 별', glyph: '★' },
  { id: 'star-outline', label: '빈 별', glyph: '☆' },
  { id: 'reference-mark', label: '참조 표시', glyph: '※' },
];

export const DEFAULT_EVENT_MARKER_SHAPE = 'bar';

/** @param {string} value @returns {string} */
export function normalizeMarkerShape(value) {
  return EVENT_MARKER_SHAPES.some((shape) => shape.id === value) ? value : DEFAULT_EVENT_MARKER_SHAPE;
}

/** @param {string} shapeId @returns {string | null} */
export function getMarkerShapeGlyph(shapeId) {
  return EVENT_MARKER_SHAPES.find((shape) => shape.id === shapeId)?.glyph ?? null;
}
