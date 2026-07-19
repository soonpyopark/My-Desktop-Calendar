import { useEffect } from 'react';
import { isEditableTarget, isRedoShortcut, isUndoShortcut } from '../lib/keyboard.js';

/**
 * @param {{
 *   canUndo: boolean;
 *   canRedo: boolean;
 *   onUndo: () => void | Promise<void>;
 *   onRedo: () => void | Promise<void>;
 *   enabled?: boolean;
 * }} options
 */
export function useUndoRedoShortcuts({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  enabled = true,
}) {
  useEffect(() => {
    if (!enabled) return undefined;

    const onKeyDown = (event) => {
      if (isEditableTarget(event.target)) return;

      if (isUndoShortcut(event)) {
        if (!canUndo) return;
        event.preventDefault();
        void onUndo();
        return;
      }

      if (isRedoShortcut(event)) {
        if (!canRedo) return;
        event.preventDefault();
        void onRedo();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canRedo, canUndo, enabled, onRedo, onUndo]);
}
