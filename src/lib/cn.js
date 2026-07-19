/** @param {...(string | false | null | undefined)} parts */
export function cn(...parts) {
  return parts.filter(Boolean).join(' ');
}
