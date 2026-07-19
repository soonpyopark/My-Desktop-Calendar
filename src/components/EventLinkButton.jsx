import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  appendEventLink,
  getEventLinks,
  normalizeEventLinkUrl,
  normalizeEventLinksArray,
} from '../../shared/eventLinks.js';
import { cn } from '../lib/cn.js';
import { openExternalUrl } from '../lib/openExternal.js';

const PANEL_PAD = 8;
const PANEL_FALLBACK_WIDTH = 280;
const PANEL_FALLBACK_HEIGHT = 140;

/** Link glyph — trigger for the per-event link URL editor. */
function LinkGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"
      />
    </svg>
  );
}

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
 * Footer trigger + portaled flyout for managing an event's shortcut URLs from quick-edit.
 * `links` / `onChange(links)` is the primary API; legacy `value`/`onChange(string)` still works
 * for a single URL.
 */
export default function EventLinkButton({
  links: linksProp,
  value,
  onChange,
  disabled = false,
  title = '바로가기 추가',
  buttonClassName,
  className,
}) {
  const resolvedLinks = Array.isArray(linksProp)
    ? normalizeEventLinksArray(linksProp)
    : getEventLinks(value ? { link: value } : null);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [panelStyle, setPanelStyle] = useState(null);
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const panelId = useId();

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) setDraft('');
  }, [open]);

  const usesArrayApi = Array.isArray(linksProp);

  const emitLinks = (nextLinks) => {
    const normalized = normalizeEventLinksArray(nextLinks);
    // Array API when `links` prop is provided; otherwise legacy single-string callback.
    onChange?.(usesArrayApi ? normalized : (normalized[0]?.url ?? ''));
  };

  const addDraft = () => {
    const url = normalizeEventLinkUrl(draft);
    if (!url) return;
    emitLinks(appendEventLink(resolvedLinks, url));
    setDraft('');
  };

  const removeAt = (id) => {
    emitLinks(resolvedLinks.filter((item) => item.id !== id));
  };

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
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, resolvedLinks.length]);

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

  const linkCount = resolvedLinks.length;
  const hasLink = linkCount > 0;
  const triggerTitle = hasLink ? `${title} (${linkCount})` : title;
  const triggerLabel = hasLink ? `${title} ${linkCount}개` : title;

  const panel = open ? (
    <div
      ref={panelRef}
      id={panelId}
      className="event-link-flyout-panel"
      role="dialog"
      aria-label="바로가기 관리"
      style={panelStyle ?? { position: 'fixed', visibility: 'hidden', zIndex: 80 }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {resolvedLinks.length > 0 && (
        <ul className="event-link-flyout-list">
          {resolvedLinks.map((item) => (
            <li key={item.id} className="event-link-flyout-item">
              <button
                type="button"
                className="event-link-flyout-item-open"
                title="바로가기 열기"
                onClick={() => void openExternalUrl(item.url)}
              >
                {item.title || item.url}
              </button>
              <button
                type="button"
                className="event-link-flyout-item-remove"
                title="삭제"
                onClick={() => removeAt(item.id)}
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        type="url"
        className="event-link-flyout-input"
        placeholder="https://example.com"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addDraft();
          }
        }}
      />
      <div className="event-link-flyout-actions">
        <button
          type="button"
          className="event-link-flyout-apply"
          disabled={!normalizeEventLinkUrl(draft)}
          onClick={addDraft}
        >
          추가
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={cn('event-link-picker-root', className)}>
      <button
        type="button"
        className={cn('event-link-picker-trigger', hasLink && 'has-link', buttonClassName)}
        title={triggerTitle}
        aria-label={triggerLabel}
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
        <LinkGlyph />
        {hasLink ? (
          <span className="event-link-picker-badge">{linkCount > 9 ? '9+' : linkCount}</span>
        ) : null}
      </button>
      {panel && createPortal(panel, document.body)}
    </div>
  );
}
