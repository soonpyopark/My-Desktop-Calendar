/**
 * @param {EventTarget | null} target
 */
export function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * @param {KeyboardEvent} event
 */
export function isUndoShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  if (event.key !== 'z' && event.key !== 'Z') return false;
  return !event.shiftKey;
}

/**
 * @param {KeyboardEvent} event
 */
export function isRedoShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  if (event.key === 'y' || event.key === 'Y') return true;
  if (event.key === 'z' || event.key === 'Z') return event.shiftKey;
  return false;
}
