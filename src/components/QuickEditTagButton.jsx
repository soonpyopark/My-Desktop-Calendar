import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeTagIds, sortTags } from '../../shared/eventTags.js';
import { cn } from '../lib/cn.js';

const PANEL_PAD = 8;
const PANEL_FALLBACK_WIDTH = 200;
const PANEL_FALLBACK_HEIGHT = 160;

function TagGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58s1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41s-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"
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
 * Quick-edit tag picker — multi-select, same portal pattern as QuickEditCalendarButton.
 */
export default function QuickEditTagButton({
  tags = [],
  value = [],
  onChange,
  disabled = false,
  title = '태그 선택',
  className,
  buttonClassName,
}) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState(null);
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();

  const sortedTags = useMemo(() => sortTags(tags), [tags]);
  const selectedIds = useMemo(() => normalizeTagIds(value), [value]);
  const selectedCount = selectedIds.length;
  const primaryColor = sortedTags.find((tag) => selectedIds.includes(tag.id))?.color ?? null;

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
  }, [open, sortedTags.length, selectedCount]);

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

  const noneSelected = selectedCount === 0;

  const clearTags = () => {
    onChange?.([]);
  };

  const toggleTag = (tagId) => {
    const next = selectedIds.includes(tagId)
      ? selectedIds.filter((id) => id !== tagId)
      : [...selectedIds, tagId];
    onChange?.(normalizeTagIds(next));
  };

  const panel = open ? (
    <div
      ref={panelRef}
      id={panelId}
      className="quick-edit-calendar-flyout"
      role="listbox"
      aria-label="태그 선택"
      aria-multiselectable="true"
      style={panelStyle ?? { position: 'fixed', visibility: 'hidden', zIndex: 80 }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="option"
        aria-selected={noneSelected}
        className={cn('quick-edit-calendar-option', noneSelected && 'is-active')}
        onClick={() => {
          clearTags();
          setOpen(false);
        }}
      >
        <span
          className="quick-edit-calendar-swatch"
          style={{
            backgroundColor: 'transparent',
            borderRadius: '0.2rem',
            boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.18)',
          }}
          aria-hidden="true"
        />
        <span className="quick-edit-calendar-name">없음</span>
        {noneSelected && (
          <svg viewBox="0 0 24 24" width="16" height="16" className="shrink-0 text-gcal-blue" aria-hidden="true">
            <path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
          </svg>
        )}
      </button>
      {sortedTags.length === 0 && (
        <div className="quick-edit-calendar-empty">등록된 태그가 없습니다</div>
      )}
      {sortedTags.map((tag) => {
        const isActive = selectedIds.includes(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            role="option"
            aria-selected={isActive}
            className={cn('quick-edit-calendar-option', isActive && 'is-active')}
            onClick={() => toggleTag(tag.id)}
          >
            <span
              className="quick-edit-calendar-swatch"
              style={{
                backgroundColor: tag.color || '#9aa0a6',
                borderRadius: '0.2rem',
              }}
              aria-hidden="true"
            />
            <span className="quick-edit-calendar-name">{tag.name}</span>
            {isActive && (
              <svg viewBox="0 0 24 24" width="16" height="16" className="shrink-0 text-gcal-blue" aria-hidden="true">
                <path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={cn('quick-edit-calendar-root quick-edit-tag-root', className)}>
      <button
        type="button"
        className={cn(
          'quick-edit-calendar-trigger',
          selectedCount > 0 && 'has-tags',
          buttonClassName,
        )}
        title={
          selectedCount > 0
            ? `${title}: ${sortedTags.filter((t) => selectedIds.includes(t.id)).map((t) => t.name).join(', ')}`
            : `${title}: 없음`
        }
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
      >
        <TagGlyph />
        {primaryColor && (
          <span
            className="quick-edit-calendar-trigger-dot"
            style={{ backgroundColor: primaryColor }}
            aria-hidden="true"
          />
        )}
        {selectedCount > 1 && (
          <span className="quick-edit-tag-count" aria-hidden="true">{selectedCount}</span>
        )}
      </button>
      {panel && createPortal(panel, document.body)}
    </div>
  );
}
