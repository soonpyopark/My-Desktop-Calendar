import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn.js';
import { EMOJI_CATEGORIES } from '../lib/emojiData.js';
import { addRecentEmoji, getRecentEmojis } from '../lib/recentEmojis.js';

const PANEL_PAD = 8;
const PANEL_FALLBACK_WIDTH = 280;
const PANEL_FALLBACK_HEIGHT = 300;

/** Clamp the flyout to the nearest dialog/popover, else the viewport. */
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
 * Self-contained emoji picker: a trigger button + portaled flyout panel (position
 * clamped to the nearest dialog, same pattern as CustomColorPicker). Selecting an
 * emoji keeps the panel open so multiple emoji can be inserted in one go — closes
 * via outside click, Escape, or toggling the trigger again.
 *
 * @param {'trigger' | 'dialog-header' | 'quick-edit-input-row'} [flyoutAnchor]
 *   `trigger` — below the button (default, EventEditor etc.)
 *   `dialog-header` — just under `.day-quick-edit-header` inside the nearest dialog
 *   `quick-edit-input-row` — just under `.day-quick-edit-create` (the title input row)
 */
export default function EmojiPickerButton({
  onSelect,
  className,
  buttonClassName,
  title = '이모지 추가',
  disabled = false,
  flyoutAnchor = 'trigger',
}) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState([]);
  const [activeCategory, setActiveCategory] = useState(EMOJI_CATEGORIES[0]?.id ?? 'smileys');
  const [panelStyle, setPanelStyle] = useState(null);
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();

  const categories = useMemo(() => {
    if (recent.length === 0) return EMOJI_CATEGORIES;
    return [{ id: 'recent', label: '최근 사용', icon: recent[0], emojis: recent }, ...EMOJI_CATEGORIES];
  }, [recent]);

  useEffect(() => {
    if (!open) return;
    setRecent(getRecentEmojis());
  }, [open]);

  useEffect(() => {
    if (categories.some((cat) => cat.id === activeCategory)) return;
    setActiveCategory(categories[0]?.id ?? 'smileys');
  }, [categories, activeCategory]);

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

      const anchorsUnderDialogRow = flyoutAnchor === 'dialog-header' || flyoutAnchor === 'quick-edit-input-row';
      if (anchorsUnderDialogRow) {
        const dialog = rootRef.current?.closest('[role="dialog"]');
        const rowSelector = flyoutAnchor === 'quick-edit-input-row' ? '.day-quick-edit-create' : '.day-quick-edit-header';
        const row = dialog?.querySelector(rowSelector);
        const rowRect = row?.getBoundingClientRect();
        if (rowRect) {
          // Sit flush under the anchor row; keep left aligned with the emoji control when possible.
          top = rowRect.bottom + 4;
          left = Math.min(ar.left, rowRect.right - width - PANEL_PAD);
          left = Math.max(left, rowRect.left + PANEL_PAD);
        }
      }

      const maxLeft = bounds.right - width;
      const minLeft = bounds.left;
      left = Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft));

      // Prefer staying below the header/button; only flip above if it would leave the clamp box.
      if (!anchorsUnderDialogRow && top + height > bounds.bottom) {
        top = ar.top - height - PANEL_PAD;
      }
      if (top + height > bounds.bottom) {
        top = Math.max(bounds.top, bounds.bottom - height);
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
  }, [open, activeCategory, flyoutAnchor]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

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

  const pick = (emoji) => {
    onSelect?.(emoji);
    addRecentEmoji(emoji);
    setRecent(getRecentEmojis());
  };

  const current = categories.find((cat) => cat.id === activeCategory) ?? categories[0];

  const panel = open ? (
    <div
      ref={panelRef}
      id={panelId}
      className="emoji-picker-panel"
      role="dialog"
      aria-label="이모지 선택"
      style={panelStyle ?? { position: 'fixed', visibility: 'hidden', zIndex: 80 }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="emoji-picker-tabs" role="tablist">
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            role="tab"
            aria-selected={cat.id === activeCategory}
            className={cn('emoji-picker-tab', cat.id === activeCategory && 'active')}
            title={cat.label}
            aria-label={cat.label}
            onClick={() => setActiveCategory(cat.id)}
          >
            {cat.icon}
          </button>
        ))}
      </div>
      <div className="emoji-picker-grid">
        {current?.emojis.length ? (
          current.emojis.map((emoji, idx) => (
            <button
              key={`${emoji}-${idx}`}
              type="button"
              className="emoji-picker-item"
              title={emoji}
              onClick={() => pick(emoji)}
            >
              {emoji}
            </button>
          ))
        ) : (
          <p className="emoji-picker-empty">최근 사용한 이모지가 없습니다</p>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={cn('emoji-picker-root', className)}>
      <button
        type="button"
        className={cn('emoji-picker-trigger', buttonClassName)}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
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
        <span aria-hidden="true">🙂</span>
      </button>
      {panel && createPortal(panel, document.body)}
    </div>
  );
}
