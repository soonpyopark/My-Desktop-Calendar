/**
 * Insert `text` into `currentValue` at `inputEl`'s current caret (replacing any
 * selection), returning the next full value and the caret position after the
 * inserted text so the caller can restore focus/selection post-render.
 * @param {HTMLInputElement | null | undefined} inputEl
 * @param {string} currentValue
 * @param {string} text
 * @returns {{ nextValue: string, nextPos: number }}
 */
export function insertTextAtCursor(inputEl, currentValue, text) {
  const length = currentValue.length;
  const start = inputEl && typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : length;
  const end = inputEl && typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : length;
  const nextValue = currentValue.slice(0, start) + text + currentValue.slice(end);
  return { nextValue, nextPos: start + text.length };
}
