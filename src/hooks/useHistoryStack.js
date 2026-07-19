import { useCallback, useRef, useState } from 'react';

/**
 * @typedef {{ undo: () => void | Promise<void>; redo: () => void | Promise<void> }} HistoryEntry
 */

/**
 * @param {number} [maxSize]
 */
export function useHistoryStack(maxSize = 50) {
  /** @type {import('react').MutableRefObject<HistoryEntry[]>} */
  const pastRef = useRef([]);
  /** @type {import('react').MutableRefObject<HistoryEntry[]>} */
  const futureRef = useRef([]);
  const applyingRef = useRef(false);
  const [stackState, setStackState] = useState({ canUndo: false, canRedo: false });

  const syncState = useCallback(() => {
    setStackState({
      canUndo: pastRef.current.length > 0,
      canRedo: futureRef.current.length > 0,
    });
  }, []);

  const push = useCallback(
    /** @param {HistoryEntry} entry */
    (entry) => {
      if (applyingRef.current) return;
      pastRef.current = [...pastRef.current, entry].slice(-maxSize);
      futureRef.current = [];
      syncState();
    },
    [maxSize, syncState],
  );

  const undo = useCallback(async () => {
    const entry = pastRef.current.at(-1);
    if (!entry) return false;

    pastRef.current = pastRef.current.slice(0, -1);
    applyingRef.current = true;
    try {
      await entry.undo();
      futureRef.current = [...futureRef.current, entry];
      syncState();
      return true;
    } catch (err) {
      pastRef.current = [...pastRef.current, entry];
      syncState();
      throw err;
    } finally {
      applyingRef.current = false;
    }
  }, [syncState]);

  const redo = useCallback(async () => {
    const entry = futureRef.current.at(-1);
    if (!entry) return false;

    futureRef.current = futureRef.current.slice(0, -1);
    applyingRef.current = true;
    try {
      await entry.redo();
      pastRef.current = [...pastRef.current, entry];
      syncState();
      return true;
    } catch (err) {
      futureRef.current = [...futureRef.current, entry];
      syncState();
      throw err;
    } finally {
      applyingRef.current = false;
    }
  }, [syncState]);

  const clear = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    syncState();
  }, [syncState]);

  return {
    push,
    undo,
    redo,
    clear,
    canUndo: stackState.canUndo,
    canRedo: stackState.canRedo,
  };
}
