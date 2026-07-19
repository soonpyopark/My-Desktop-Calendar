import { useEffect, useRef, useState } from 'react';
import { CALENDAR_FILE_FORMATS } from '../../shared/calendarInterchange.js';
import { cn } from '../lib/cn.js';

/**
 * @param {{
 *   label: string,
 *   variant?: 'primary' | 'secondary',
 *   mode: 'import' | 'export',
 *   onSelectFormat: (format: 'json' | 'ics' | 'csv') => void,
 * }} props
 */
export default function CalendarFileFormatButton({
  label,
  variant = 'secondary',
  mode,
  onSelectFormat,
  className,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const buttonClassName =
    variant === 'primary'
      ? 'rounded-full bg-gcal-blue px-5 py-2 text-sm font-medium text-white hover:bg-[#1765cc]'
      : 'rounded-full border border-gcal-border bg-gcal-page px-5 py-2 text-sm font-medium hover:bg-gcal-surface-2';

  return (
    <div className="relative inline-block" ref={rootRef}>
      <button
        type="button"
        className={cn(buttonClassName, mode === 'import' && variant === 'primary' && 'text-white', className)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        {label}
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-20 mt-1 min-w-[10.5rem] overflow-hidden rounded-lg border border-gcal-border bg-gcal-page py-1 shadow-[0_8px_24px_rgba(60,64,67,0.18)]"
          role="menu"
        >
          {CALENDAR_FILE_FORMATS.map((format) => (
            <button
              key={format.value}
              type="button"
              role="menuitem"
              className="block w-full px-4 py-2 text-left text-sm text-gcal-heading hover:bg-gcal-surface-2"
              onClick={() => {
                setOpen(false);
                onSelectFormat(format.value);
              }}
            >
              {format.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * @param {'json' | 'ics' | 'csv'} format
 */
export function getImportAcceptAttribute(format) {
  switch (format) {
    case 'json':
      return 'application/json,.json';
    case 'ics':
      return 'text/calendar,.ics';
    case 'csv':
      return 'text/csv,.csv';
    default:
      return '';
  }
}

/** File picker filter for all supported import formats. */
export function getAllImportAcceptAttribute() {
  return '.json,.ics,.csv,application/json,text/calendar,text/csv';
}
