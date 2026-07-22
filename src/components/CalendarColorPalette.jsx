import { memo } from 'react';
import { CALENDAR_COLOR_PALETTE } from '../../shared/calendarColorPalette.js';
import { getCalendarTheme } from '../lib/colors.js';
import { cn } from '../lib/cn.js';
import CustomColorPicker from './CustomColorPicker.jsx';

function CalendarColorSwatch({
  color,
  isActive = false,
  className,
  title,
  'aria-label': ariaLabel,
  onClick,
  onDoubleClick,
  children,
  as: Component = 'button',
  role,
  'aria-selected': ariaSelected,
}) {
  const theme = getCalendarTheme(color);

  return (
    <Component
      type={Component === 'button' ? 'button' : undefined}
      role={role}
      aria-selected={ariaSelected}
      className={cn('calendar-color-swatch', isActive && 'active', className)}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span
        className="calendar-color-swatch-half calendar-color-swatch-half--solid"
        style={{ backgroundColor: theme.base }}
        aria-hidden="true"
      />
      <span
        className="calendar-color-swatch-half calendar-color-swatch-half--tint"
        style={{ backgroundColor: theme.bg }}
        aria-hidden="true"
      />
      {children}
    </Component>
  );
}

/**
 * @param {{
 *   value: string;
 *   onChange: (color: string) => void;
 *   onRequestClose?: () => void;
 *   className?: string;
 * }} props
 */
function CalendarColorPalette({ value, onChange, onRequestClose, className }) {
  const selected = (value ?? '').toLowerCase();
  const isCustomSelected = Boolean(
    value && !CALENDAR_COLOR_PALETTE.some((c) => c.toLowerCase() === selected),
  );

  return (
    <div className={cn('calendar-color-palette-wrap', className)}>
      <div className="calendar-color-palette" role="listbox" aria-label="일정 색상">
        {CALENDAR_COLOR_PALETTE.map((color) => {
          const isActive = selected === color.toLowerCase();
          return (
            <CalendarColorSwatch
              key={color}
              color={color}
              isActive={isActive}
              role="option"
              aria-selected={isActive}
              title={color}
              aria-label={`색상 ${color}`}
              onClick={(e) => {
                if (e.detail > 1) return;
                onChange(color);
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                onChange(color);
                onRequestClose?.();
              }}
              as="button"
            />
          );
        })}
        <CustomColorPicker
          value={value}
          isActive={isCustomSelected}
          defaultDraft={CALENDAR_COLOR_PALETTE[0]}
          onApply={(color) => onChange(color)}
          onRequestClose={onRequestClose}
          swatchClassName="calendar-color-swatch calendar-color-swatch--picker"
        />
      </div>
    </div>
  );
}

// Name-draft typing in TagsPanel / CreateCalendarForm used to re-render all swatches
// (theme calc + CustomColorPicker) on every keystroke; skip when color props are unchanged.
export default memo(CalendarColorPalette);
