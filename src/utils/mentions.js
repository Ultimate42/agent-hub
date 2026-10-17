// Detect "@Name" mentions; names may contain spaces, parentheses, accents.
export function isMentioned(content, name) {
  if (typeof content !== 'string' || typeof name !== 'string' || !name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${esc}(?![\\p{L}\\p{N}_])`, 'iu').test(content);
}
