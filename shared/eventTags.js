/**
 * Event tag helpers — master catalog on store.tags, event.tagIds references.
 */

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeTagIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * @param {object[]} tags
 * @returns {object[]}
 */
export function sortTags(tags) {
  return [...(tags ?? [])].sort((a, b) => {
    const ao = typeof a.sortOrder === 'number' ? a.sortOrder : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.sortOrder === 'number' ? b.sortOrder : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ko');
  });
}

/**
 * @param {object} event
 * @param {object[]} tags
 * @returns {object[]}
 */
export function resolveEventTags(event, tags) {
  const byId = new Map((tags ?? []).map((tag) => [tag.id, tag]));
  return normalizeTagIds(event?.tagIds)
    .map((id) => byId.get(id))
    .filter(Boolean);
}

/**
 * Bracket prefix for display, e.g. "[행정][출장]".
 * @param {object} event
 * @param {object[]} tags
 */
export function formatEventTagPrefix(event, tags) {
  const resolved = resolveEventTags(event, tags);
  if (!resolved.length) return '';
  return resolved.map((tag) => `[${tag.name}]`).join('');
}

/**
 * Title with tag prefix: "[행정] 점심 커피".
 * @param {object} event
 * @param {object[]} tags
 */
export function formatTaggedEventTitle(event, tags) {
  const title = event?.title ?? '';
  const prefix = formatEventTagPrefix(event, tags);
  return prefix ? `${prefix} ${title}` : title;
}
