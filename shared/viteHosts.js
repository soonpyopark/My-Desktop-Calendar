/**
 * @param {string | undefined} raw
 * @returns {true | string[]}
 */
export function parseAllowedHosts(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === '*') {
    return true;
  }
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

const LOCAL_ALLOWED_HOSTS = ['127.0.0.1', 'localhost'];

/**
 * @param {string} hostname
 * @param {string | undefined} raw
 * @returns {true | string[]}
 */
export function resolveAllowedHosts(hostname, raw) {
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    return parseAllowedHosts(raw);
  }
  if (hostname === '0.0.0.0' || hostname === '::') {
    return true;
  }
  return LOCAL_ALLOWED_HOSTS;
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function isServerBindHostname(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return (
    trimmed === '127.0.0.1' ||
    trimmed === '0.0.0.0' ||
    trimmed === '::' ||
    trimmed === 'localhost' ||
    trimmed === '[::]'
  );
}
