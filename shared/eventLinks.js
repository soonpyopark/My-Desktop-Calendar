/**
 * Normalize an event link URL for storage.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeEventLinkUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * @returns {string}
 */
export function newEventLinkId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `lnk-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * @param {unknown} item
 * @returns {{ id: string, url: string, title: string } | null}
 */
export function normalizeEventLinkItem(item) {
  if (typeof item === 'string') {
    const url = normalizeEventLinkUrl(item);
    if (!url) return null;
    return { id: newEventLinkId(), url, title: '' };
  }
  if (!item || typeof item !== 'object') return null;
  const url = normalizeEventLinkUrl(
    /** @type {{ url?: unknown, href?: unknown }} */ (item).url
      ?? /** @type {{ href?: unknown }} */ (item).href
      ?? '',
  );
  if (!url) return null;
  const idRaw = /** @type {{ id?: unknown }} */ (item).id;
  const id = typeof idRaw === 'string' && idRaw.trim() ? idRaw.trim() : newEventLinkId();
  const titleRaw = /** @type {{ title?: unknown }} */ (item).title;
  const title = typeof titleRaw === 'string' ? titleRaw.trim() : '';
  return { id, url, title };
}

/**
 * Resolve links from `links[]` and/or legacy `link` string.
 * @param {object | null | undefined} event
 * @returns {{ id: string, url: string, title: string }[]}
 */
export function getEventLinks(event) {
  const fromArray = Array.isArray(event?.links)
    ? event.links.map(normalizeEventLinkItem).filter(Boolean)
    : [];
  if (fromArray.length > 0) {
    return /** @type {{ id: string, url: string, title: string }[]} */ (fromArray);
  }

  const legacy = normalizeEventLinkUrl(event?.link);
  if (!legacy) return [];
  return [{ id: newEventLinkId(), url: legacy, title: '' }];
}

/**
 * @param {object | null | undefined} event
 * @returns {string}
 */
export function getPrimaryEventLinkUrl(event) {
  return getEventLinks(event)[0]?.url ?? '';
}

/**
 * @param {unknown} links
 * @returns {{ id: string, url: string, title: string }[]}
 */
export function normalizeEventLinksArray(links) {
  if (!Array.isArray(links)) return [];
  return /** @type {{ id: string, url: string, title: string }[]} */ (
    links.map(normalizeEventLinkItem).filter(Boolean)
  );
}

/**
 * @param {{ id: string, url: string, title: string }[] | null | undefined} links
 * @param {string} url
 * @returns {{ id: string, url: string, title: string }[]}
 */
export function appendEventLink(links, url) {
  const item = normalizeEventLinkItem({ url });
  if (!item) return [...(links ?? [])];
  return [...(links ?? []), item];
}
