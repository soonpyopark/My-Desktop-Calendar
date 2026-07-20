import { useCallback, useEffect, useRef, useState } from 'react';

const HOVER_DELAY_MS = 500;
const MOVE_THRESHOLD_PX = 3;

/**
 * @param {{
 *   resetTimerOnMove?: boolean,
 *   onOpen?: (detail: {
 *     event: object,
 *     dayKey: string,
 *     clientX: number,
 *     clientY: number,
 *     anchorRect: DOMRect,
 *   }) => void,
 * }} [options]
 */
export function useEventHoverPreview({ resetTimerOnMove = true, onOpen = null } = {}) {
  const [preview, setPreview] = useState(null);
  const timerRef = useRef(null);
  const pointerRef = useRef(null);
  const targetRef = useRef(null);
  const resetTimerOnMoveRef = useRef(resetTimerOnMove);
  const onOpenRef = useRef(onOpen);
  resetTimerOnMoveRef.current = resetTimerOnMove;
  onOpenRef.current = onOpen;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = null;
  }, []);

  const clearPreview = useCallback(() => {
    clearTimer();
    pointerRef.current = null;
    targetRef.current = null;
    setPreview(null);
  }, [clearTimer]);

  const schedulePreview = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      const target = targetRef.current;
      const pointer = pointerRef.current;
      if (!target) return;
      const anchorRect = target.element.getBoundingClientRect();
      const detail = {
        event: target.event,
        dayKey: target.dayKey,
        clientX: pointer?.x ?? anchorRect.left + anchorRect.width / 2,
        clientY: pointer?.y ?? anchorRect.top + anchorRect.height / 2,
        anchorRect,
      };
      if (onOpenRef.current) {
        onOpenRef.current(detail);
        pointerRef.current = null;
        targetRef.current = null;
        setPreview(null);
        return;
      }
      setPreview({
        event: detail.event,
        dayKey: detail.dayKey,
        anchorRect: detail.anchorRect,
      });
    }, HOVER_DELAY_MS);
  }, [clearTimer]);

  const handleEventMouseEnter = useCallback((event, dayKey, element, clientX, clientY) => {
    targetRef.current = { event, dayKey, element };
    pointerRef.current = { x: clientX, y: clientY };
    schedulePreview();
  }, [schedulePreview]);

  const handleEventMouseMove = useCallback((clientX, clientY) => {
    const last = pointerRef.current;
    if (!last || !targetRef.current) return;

    // Always track the latest pointer so onOpen (list hover) matches click placement.
    pointerRef.current = { x: clientX, y: clientY };

    if (!resetTimerOnMoveRef.current) return;

    const moved =
      Math.abs(clientX - last.x) > MOVE_THRESHOLD_PX
      || Math.abs(clientY - last.y) > MOVE_THRESHOLD_PX;

    if (!moved) return;

    setPreview(null);
    schedulePreview();
  }, [schedulePreview]);

  const handleEventMouseLeave = useCallback(() => {
    clearPreview();
  }, [clearPreview]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return {
    preview,
    clearPreview,
    handleEventMouseEnter,
    handleEventMouseMove,
    handleEventMouseLeave,
  };
}
