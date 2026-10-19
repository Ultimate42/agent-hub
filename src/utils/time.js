/**
 * Parse a SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC, no zone marker)
 * or an ISO string into epoch ms. Returns NaN if invalid. Independent of process TZ.
 */
export function parseDbTime(value) {
  if (typeof value !== 'string') return NaN;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v)) {
    return new Date(v.replace(' ', 'T') + 'Z').getTime();
  }
  return new Date(v).getTime();
}
