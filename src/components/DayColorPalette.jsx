import { DAY_COLOR_PALETTE } from '../../shared/dayColorPalette.js';
import { cn } from '../lib/cn.js';
import CustomColorPicker from './CustomColorPicker.jsx';

function swatchStyle(color) {
  return { backgroundColor: color };
}

/** Circle with red slash — “no fill / default”. */
function ClearColorIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.45" />
      <line x1="6.2" y1="17.8" x2="17.8" y2="6.2" stroke="#e53935" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * whiteboard4share 스타일 원형 팔레트 (날짜 칸 배경색).
 * 첫 칸: 무색(기본) — 선택 시 dayColor 제거.
 * 마지막: 기타 색상 — 패널에서 고른 뒤 「적용」시에만 반영.
 */
export default function DayColorPalette({
  value,
  onChange,
  onRequestClose,
  className,
  compact = false,
}) {
  const selected = (value ?? '').toLowerCase();
  const isClearSelected = !value;
  const isCustomSelected = Boolean(
    value && !DAY_COLOR_PALETTE.some((c) => c.toLowerCase() === selected),
  );

  const applyClear = () => {
    onChange(null);
  };

  return (
    <div className={cn('day-color-palette', compact && 'day-color-palette--compact', className)} role="listbox" aria-label="날짜 배경 색상">
      <button
        type="button"
        role="option"
        aria-selected={isClearSelected}
        className={cn('day-color-swatch day-color-swatch--clear', isClearSelected && 'active')}
        title="기본(색 없음)"
        aria-label="기본 색상 (색 없음)"
        onClick={(e) => {
          if (e.detail > 1) return;
          applyClear();
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          applyClear();
          onRequestClose?.();
        }}
      >
        <ClearColorIcon className="day-color-clear-icon" />
      </button>
      {DAY_COLOR_PALETTE.map((color) => {
        const isActive = selected === color.toLowerCase();
        return (
          <button
            key={color}
            type="button"
            role="option"
            aria-selected={isActive}
            className={cn('day-color-swatch', isActive && 'active')}
            style={swatchStyle(color)}
            title={color}
            aria-label={`색상 ${color}`}
            onClick={(e) => {
              if (e.detail > 1) return;
              onChange(isActive ? null : color);
            }}
            onDoubleClick={(e) => {
              e.preventDefault();
              onChange(color);
              onRequestClose?.();
            }}
          />
        );
      })}
      <CustomColorPicker
        compact={compact}
        value={value}
        isActive={isCustomSelected}
        defaultDraft="#1976d2"
        onApply={(color) => onChange(color)}
        onRequestClose={onRequestClose}
        swatchClassName="day-color-swatch day-color-swatch--picker"
      />
    </div>
  );
}
