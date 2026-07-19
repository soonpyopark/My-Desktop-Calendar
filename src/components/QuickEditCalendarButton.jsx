import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HOLIDAYS_KR_CALENDAR_ID } from '../../shared/constants.js';
import { sortCalendarsByOrder } from '../../shared/calendarOrder.js';
import { cn } from '../lib/cn.js';

const PANEL_PAD = 8;
const PANEL_FALLBACK_WIDTH = 200;
const PANEL_FALLBACK_HEIGHT = 160;

function CalendarGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z"
      />
    </svg>
  );
}

function resolveBounds(anchorEl) {
  const host = anchorEl?.closest('[role="dialog"]') ?? null;
  if (host) {
    const rect = host.getBoundingClientRect();
    return {
      left: rect.left + PANEL_PAD,
      top: rect.top + PANEL_PAD,
      right: rect.right - PANEL_PAD,
      bottom: rect.bottom - PANEL_PAD,
    };
  }
  return {
    left: PANEL_PAD,
    top: PANEL_PAD,
    right: window.innerWidth - PANEL_PAD,
    bottom: window.innerHeight - PANEL_PAD,
  };
}

/**
 * Quick-edit calendar picker — calendar icon + portaled list (same pattern as
 * EventMarkerShapeButton so overflow:hidden chrome does not clip the menu).
 */
export default function QuickEditCalendarButton({
  calendars = [],
  value,
  onChange,
  disabled = false,
  title = '캘린더 선택',
  className,
  buttonClassName,
}) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState(null);
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();

  const editableCalendars = useMemo(
    () => sortCalendarsByOrder(
      (calendars ?? []).filter(
        (calendar) => calendar.id !== HOLIDAYS_KR_CALENDAR_ID && calendar.visible !== false,
      ),
    ),
    [calendars],
  );

  const selected = editableCalendars.find((c) => c.id === value)
    ?? editableCalendars[0]
    ?? null;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelStyle(null);
      return undefined;
    }

    const place = () => {
      const anchor = rootRef.current?.querySelector('button');
      const panel = panelRef.current;
      if (!anchor) return;

      const bounds = resolveBounds(rootRef.current);
      const ar = anchor.getBoundingClientRect();
      const width = panel?.offsetWidth || PANEL_FALLBACK_WIDTH;
      const height = panel?.offsetHeight || PANEL_FALLBACK_HEIGHT;

      let left = ar.left;
      let top = ar.bottom + PANEL_PAD;

      const maxLeft = bounds.right - width;
      const minLeft = bounds.left;
      left = Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft));

      if (top + height > bounds.bottom) {
        top = ar.top - height - PANEL_PAD;
      }
      const maxTop = bounds.bottom - height;
      top = Math.min(Math.max(top, bounds.top), Math.max(bounds.top, maxTop));

      setPanelStyle({
        position: 'fixed',
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
        right: 'auto',
        bottom: 'auto',
        zIndex: 80,
      });
    };

    place();
    const raf = window.requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, editableCalendars.length]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      const target = event.target;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const panel = open ? (
    <div
      ref={panelRef}
      id={panelId}
      className="quick-edit-calendar-flyout"
      role="listbox"
      aria-label="캘린더 선택"
      style={panelStyle ?? { position: 'fixed', visibility: 'hidden', zIndex: 80 }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {editableCalendars.length === 0 && (
        <div className="quick-edit-calendar-empty">선택 가능한 캘린더가 없습니다</div>
      )}
      {editableCalendars.map((calendar) => {
        const isActive = calendar.id === (selected?.id ?? value);
        return (
          <button
            key={calendar.id}
            type="button"
            role="option"
            aria-selected={isActive}
            className={cn('quick-edit-calendar-option', isActive && 'is-active')}
            onClick={() => {
              onChange?.(calendar.id);
              setOpen(false);
            }}
          >
            <span
              className="quick-edit-calendar-swatch"
              style={{ backgroundColor: calendar.color ?? '#1a73e8' }}
              aria-hidden="true"
            />
            <span className="quick-edit-calendar-name">{calendar.name}</span>
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={cn('quick-edit-calendar-root', className)}>
      <button
        type="button"
        className={cn('quick-edit-calendar-trigger', buttonClassName)}
        title={selected ? `${title}: ${selected.name}` : title}
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled || editableCalendars.length === 0}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
      >
        <CalendarGlyph />
        {selected?.color && (
          <span
            className="quick-edit-calendar-trigger-dot"
            style={{ backgroundColor: selected.color }}
            aria-hidden="true"
          />
        )}
      </button>
      {panel && createPortal(panel, document.body)}
    </div>
  );
}
