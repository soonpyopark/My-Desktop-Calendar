import { useLayoutEffect, useRef, useState } from 'react';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getViewportSize() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/**
 * @param {number} clientX
 * @param {number} clientY
 */
export function createPointerAnchor(clientX, clientY) {
  return {
    top: clientY,
    left: clientX,
    right: clientX,
    bottom: clientY,
    width: 0,
    height: 0,
    x: clientX,
    y: clientY,
  };
}

/**
 * @param {{ x: number; y: number } | DOMRect | null | undefined} anchor
 */
export function resolvePopoverAnchor(anchor) {
  if (!anchor) return null;
  if ('x' in anchor && 'y' in anchor && typeof anchor.x === 'number' && !('width' in anchor)) {
    return {
      rect: createPointerAnchor(anchor.x, anchor.y),
      mode: 'pointer',
    };
  }
  return {
    rect: anchor,
    mode: 'element',
  };
}

function isPointerAnchor(anchorRect, anchorMode) {
  return anchorMode === 'pointer' || (anchorRect.width === 0 && anchorRect.height === 0);
}

/**
 * @param {{ top: number; left: number; width: number; height: number; padding?: number }} rect
 */
export function clampRectToViewport({ top, left, width, height, padding = 8 }) {
  const { width: viewportWidth, height: viewportHeight } = getViewportSize();
  const safeWidth = Math.min(width, viewportWidth - padding * 2);
  const safeHeight = Math.min(height, viewportHeight - padding * 2);

  return {
    top: clamp(top, padding, Math.max(padding, viewportHeight - safeHeight - padding)),
    left: clamp(left, padding, Math.max(padding, viewportWidth - safeWidth - padding)),
    width: safeWidth,
    maxHeight: safeHeight,
  };
}

/**
 * @param {number} clientX
 * @param {number} clientY
 * @param {{
 *   width?: number;
 *   estimatedHeight?: number;
 *   gap?: number;
 *   padding?: number;
 * }} [options]
 */
export function getPointerPopoverPosition(
  clientX,
  clientY,
  {
    width = 380,
    estimatedHeight = 320,
    gap = 8,
    padding = 8,
  } = {},
) {
  const { width: viewportWidth, height: viewportHeight } = getViewportSize();
  const popoverWidth = Math.min(width, viewportWidth - padding * 2);
  const availableTotal = Math.max(120, viewportHeight - padding * 2);
  const desiredHeight = Math.min(estimatedHeight, availableTotal);

  let left = clientX + gap;
  if (left + popoverWidth > viewportWidth - padding) {
    left = clientX - popoverWidth - gap;
  }
  left = clamp(left, padding, viewportWidth - popoverWidth - padding);

  // Prefer below the pointer; if that clips, flip above; finally slide into the viewport
  // so the full panel (including chrome) stays visible with internal scroll if needed.
  let top = clientY + gap;
  let maxHeight = Math.min(desiredHeight, viewportHeight - top - padding);

  if (maxHeight < desiredHeight) {
    const aboveTop = clientY - gap - desiredHeight;
    const spaceAbove = clientY - gap - padding;
    if (spaceAbove >= desiredHeight || spaceAbove > maxHeight) {
      top = Math.max(padding, aboveTop);
      maxHeight = Math.min(desiredHeight, viewportHeight - top - padding);
    }
  }

  if (top + maxHeight > viewportHeight - padding) {
    top = Math.max(padding, viewportHeight - padding - maxHeight);
    maxHeight = Math.min(maxHeight, viewportHeight - top - padding);
  }
  if (top < padding) {
    top = padding;
    maxHeight = Math.min(maxHeight, viewportHeight - padding * 2);
  }

  return {
    top,
    left,
    width: popoverWidth,
    maxHeight: Math.max(120, Math.min(maxHeight, availableTotal)),
  };
}

/**
 * @param {DOMRect | { top: number; left: number; right: number; bottom: number; width: number; height: number }} anchorRect
 * @param {{
 *   width?: number;
 *   estimatedHeight?: number;
 *   gap?: number;
 *   padding?: number;
 *   preferAbove?: boolean;
 *   anchorMode?: 'pointer' | 'element';
 * }} [options]
 */
export function getAnchoredPopoverPosition(
  anchorRect,
  {
    width = 380,
    estimatedHeight = 320,
    gap = 8,
    padding = 8,
    preferAbove = false,
    anchorMode = 'element',
  } = {},
) {
  if (isPointerAnchor(anchorRect, anchorMode)) {
    return getPointerPopoverPosition(anchorRect.left, anchorRect.top, {
      width,
      estimatedHeight,
      gap,
      padding,
    });
  }

  const { width: viewportWidth, height: viewportHeight } = getViewportSize();
  const popoverWidth = Math.min(width, viewportWidth - padding * 2);

  let left = anchorRect.left;
  if (left + popoverWidth > viewportWidth - padding) {
    left = anchorRect.right - popoverWidth;
  }
  left = clamp(left, padding, viewportWidth - popoverWidth - padding);

  const belowTop = anchorRect.bottom + gap;
  const spaceBelow = viewportHeight - belowTop - padding;
  const spaceAbove = anchorRect.top - gap - padding;

  let top;
  let maxHeight;
  const placeBelow = !preferAbove && (spaceBelow >= estimatedHeight || spaceBelow >= spaceAbove);

  if (placeBelow) {
    top = belowTop;
    maxHeight = Math.max(120, Math.min(estimatedHeight, spaceBelow));
  } else {
    maxHeight = Math.max(120, Math.min(estimatedHeight, spaceAbove));
    top = anchorRect.top - gap - maxHeight;
    if (top < padding) {
      top = belowTop;
      maxHeight = Math.max(120, Math.min(estimatedHeight, spaceBelow));
    }
  }

  const clamped = clampRectToViewport({
    top,
    left,
    width: popoverWidth,
    height: maxHeight,
    padding,
  });

  return {
    top: clamped.top,
    left: clamped.left,
    width: clamped.width,
    maxHeight: clamped.maxHeight,
  };
}

/**
 * @param {DOMRect | { top: number; left: number; right: number; bottom: number; width: number; height: number }} anchorRect
 * @param {ReturnType<typeof getAnchoredPopoverPosition>} position
 * @param {{ padding?: number; anchorMode?: 'pointer' | 'element' }} [options]
 */
export function nudgeRectIntoViewport(anchorRect, position, { padding = 8, anchorMode = 'element' } = {}) {
  const { width: viewportWidth, height: viewportHeight } = getViewportSize();
  let { top, left, width, maxHeight } = position;

  if (left + width > viewportWidth - padding) {
    left = viewportWidth - width - padding;
  }
  if (left < padding) {
    left = padding;
  }

  const availableTotal = Math.max(120, viewportHeight - padding * 2);
  maxHeight = Math.min(maxHeight, availableTotal);

  if (isPointerAnchor(anchorRect, anchorMode)) {
    // Prefer sliding the panel up over shrinking below the usable floor — otherwise a
    // near-bottom open leaves top + minHeight past the viewport edge and clips chrome.
    if (top + maxHeight > viewportHeight - padding) {
      top = Math.max(padding, viewportHeight - padding - maxHeight);
      maxHeight = Math.min(maxHeight, viewportHeight - top - padding);
    }
    if (top < padding) {
      top = padding;
      maxHeight = Math.min(maxHeight, viewportHeight - padding * 2);
    }
    return { top, left, width, maxHeight: Math.max(120, Math.min(maxHeight, availableTotal)) };
  }

  if (top + maxHeight > viewportHeight - padding) {
    const aboveTop = anchorRect.top - padding - maxHeight;
    if (aboveTop >= padding) {
      top = aboveTop;
    } else {
      top = Math.max(padding, viewportHeight - maxHeight - padding);
      maxHeight = Math.min(maxHeight, viewportHeight - top - padding);
    }
  }
  if (top < padding) {
    top = padding;
    maxHeight = Math.min(maxHeight, viewportHeight - padding * 2);
  }

  return { top, left, width, maxHeight: Math.max(120, Math.min(maxHeight, availableTotal)) };
}

/**
 * @param {{ x: number; y: number } | DOMRect | null | undefined} anchor
 */
export function getAnchorSignature(anchor) {
  if (!anchor) return '';
  if ('x' in anchor && 'y' in anchor && typeof anchor.x === 'number' && !('width' in anchor)) {
    return `pointer:${anchor.x},${anchor.y}`;
  }
  return `element:${anchor.top},${anchor.left},${anchor.right},${anchor.bottom},${anchor.width},${anchor.height}`;
}

/**
 * @param {{ x: number; y: number } | DOMRect | null | undefined} anchor
 * @param {{
 *   width?: number;
 *   estimatedHeight?: number;
 *   gap?: number;
 *   padding?: number;
 * }} options
 */
export function useAnchoredPopoverStyle(anchor, options) {
  const ref = useRef(null);
  const anchorSignature = getAnchorSignature(anchor);
  const resolved = resolvePopoverAnchor(anchor);
  const anchorRect = resolved?.rect ?? null;
  const anchorMode = resolved?.mode ?? 'element';

  const [style, setStyle] = useState(() =>
    anchorRect
      ? getAnchoredPopoverPosition(anchorRect, {
          ...options,
          estimatedHeight: options.estimatedHeight ?? 320,
          anchorMode,
        })
      : null,
  );

  useLayoutEffect(() => {
    const element = ref.current;
    const currentResolved = resolvePopoverAnchor(anchor);
    const currentRect = currentResolved?.rect ?? null;
    const currentMode = currentResolved?.mode ?? 'element';

    if (!element || !currentRect) {
      setStyle(null);
      return;
    }

    const positionOptions = { ...options, anchorMode: currentMode };

    const applyPosition = (height) => {
      const position = getAnchoredPopoverPosition(currentRect, {
        ...positionOptions,
        estimatedHeight: height,
      });
      element.style.top = `${position.top}px`;
      element.style.left = `${position.left}px`;
      element.style.width = `${position.width}px`;
      element.style.maxHeight = `${position.maxHeight}px`;
      return position;
    };

    applyPosition(options.estimatedHeight ?? 320);
    const measuredHeight = element.getBoundingClientRect().height;
    const position = applyPosition(Math.max(measuredHeight, 120));
    const adjusted = nudgeRectIntoViewport(currentRect, position, {
      padding: options.padding ?? 8,
      anchorMode: currentMode,
    });

    element.style.top = `${adjusted.top}px`;
    element.style.left = `${adjusted.left}px`;
    element.style.width = `${adjusted.width}px`;
    element.style.maxHeight = `${adjusted.maxHeight}px`;

    setStyle((prev) => {
      if (
        prev
        && prev.top === adjusted.top
        && prev.left === adjusted.left
        && prev.width === adjusted.width
        && prev.maxHeight === adjusted.maxHeight
      ) {
        return prev;
      }
      return {
        top: adjusted.top,
        left: adjusted.left,
        width: adjusted.width,
        maxHeight: adjusted.maxHeight,
      };
    });
  }, [
    anchor,
    anchorSignature,
    options.width,
    options.estimatedHeight,
    options.gap,
    options.padding,
  ]);

  return { ref, style };
}

/**
 * @param {{ padding?: number; maxWidth?: number }} [options]
 */
export function getCenteredPanelStyle({ padding = 16, maxWidth = 880 } = {}) {
  const { width: viewportWidth, height: viewportHeight } = getViewportSize();
  return {
    width: Math.min(maxWidth, viewportWidth - padding * 2),
    maxHeight: viewportHeight - padding * 2,
  };
}
