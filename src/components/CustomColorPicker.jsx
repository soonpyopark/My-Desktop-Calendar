import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn.js';

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PANEL_PAD = 8;

function normalizeHex(raw, fallback = '#1976d2') {
  const value = String(raw ?? '').trim();
  if (!value) return fallback;
  const withHash = value.startsWith('#') ? value : `#${value}`;
  if (!HEX_RE.test(withHash)) return fallback;
  if (withHash.length === 4) {
    const [, r, g, b] = withHash;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return withHash.toLowerCase();
}

function resolveBounds(anchorEl) {
  const host = anchorEl?.closest('.day-quick-edit')
    ?? anchorEl?.closest('.calendar-color-palette-wrap')
    ?? null;
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
 * Custom color: first click opens an editor; color applies only on 「적용」.
 * Panel is portaled + clamped so it stays inside the parent dialog.
 */
export default function CustomColorPicker({
  value,
  isActive = false,
  defaultDraft = '#1976d2',
  onApply,
  onRequestClose,
  className,
  swatchClassName,
  compact = false,
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => normalizeHex(value, defaultDraft));
  const [hexText, setHexText] = useState(() => normalizeHex(value, defaultDraft));
  const [panelStyle, setPanelStyle] = useState(null);
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const next = normalizeHex(value, defaultDraft);
    setDraft(next);
    setHexText(next);
  }, [open, value, defaultDraft]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelStyle(null);
      return undefined;
    }

    const place = () => {
      const anchor = rootRef.current?.querySelector('button');
      const panel = panelRef.current;
      if (!anchor || !panel) return;

      const bounds = resolveBounds(rootRef.current);
      const ar = anchor.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      const width = pr.width || 168;
      const height = pr.height || 140;

      // Prefer aligning to the right side of the swatch (keeps 「적용」 visible).
      let left = ar.right - width;
      let top = ar.top - height - PANEL_PAD;

      const maxLeft = bounds.right - width;
      const minLeft = bounds.left;
      left = Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft));

      if (top < bounds.top) {
        top = ar.bottom + PANEL_PAD;
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
  }, [open, draft, hexText]);

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

  const commit = () => {
    const next = normalizeHex(hexText, draft);
    onApply(next);
    setOpen(false);
    onRequestClose?.();
  };

  const panel = open ? (
    <div
      ref={panelRef}
      id={panelId}
      className="custom-color-panel"
      role="dialog"
      aria-label="기타 색상 선택"
      style={panelStyle ?? { position: 'fixed', visibility: 'hidden', zIndex: 80 }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <label className="custom-color-panel-row">
        <span className="custom-color-panel-label">미리보기</span>
        <input
          type="color"
          className="custom-color-native"
          value={draft}
          onInput={(e) => {
            const next = e.target.value;
            setDraft(next);
            setHexText(next);
          }}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            setHexText(next);
          }}
        />
      </label>
      <label className="custom-color-panel-row">
        <span className="custom-color-panel-label">HEX</span>
        <input
          type="text"
          className="custom-color-hex"
          value={hexText}
          spellCheck={false}
          maxLength={7}
          onChange={(e) => {
            const raw = e.target.value.trim();
            setHexText(raw.startsWith('#') || raw.length === 0 ? raw : `#${raw}`);
            if (HEX_RE.test(raw.startsWith('#') ? raw : `#${raw}`)) {
              setDraft(normalizeHex(raw, draft));
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
      </label>
      <div className="custom-color-panel-actions">
        <button type="button" className="custom-color-btn custom-color-btn--ghost" onClick={() => setOpen(false)}>
          취소
        </button>
        <button type="button" className="custom-color-btn custom-color-btn--primary" onClick={commit}>
          적용
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={cn('custom-color-picker', compact && 'custom-color-picker--compact', className)}>
      <button
        type="button"
        role="option"
        aria-selected={isActive}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(swatchClassName, isActive && 'active')}
        title="기타 색상"
        aria-label="기타 색상 선택"
        style={isActive && value ? { backgroundColor: value } : undefined}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
      >
        {!isActive && (
          <span className="custom-color-picker-glyph" aria-hidden="true">
            🎨
          </span>
        )}
      </button>

      {panel && createPortal(panel, document.body)}
    </div>
  );
}
