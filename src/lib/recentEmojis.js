const STORAGE_KEY = 'mycalendar.recentEmojis';
const MAX_RECENT = 24;

/** @returns {string[]} */
export function getRecentEmojis() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/** @param {string} emoji */
export function addRecentEmoji(emoji) {
  if (!emoji) return;
  try {
    const next = [emoji, ...getRecentEmojis().filter((e) => e !== emoji)].slice(0, MAX_RECENT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}
