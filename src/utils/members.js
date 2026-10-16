/**
 * Members list utilities: dedup and presence calculation
 */

/**
 * Calculate presence status based on last_seen timestamp
 * @param {string|null} lastSeen - ISO timestamp or null
 * @returns {string} 'active' | 'passive' | 'stale'
 */
export function calculatePresence(lastSeen) {
  if (!lastSeen) {
    return 'stale';
  }

  const lastSeenTime = new Date(lastSeen).getTime();
  const nowTime = Date.now();
  const diffMs = nowTime - lastSeenTime;

  const fiveMinMs = 5 * 60 * 1000;      // 5 minutes
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;  // 24 hours

  if (diffMs < fiveMinMs) {
    return 'active';
  } else if (diffMs < twentyFourHoursMs) {
    return 'passive';
  } else {
    return 'stale';
  }
}

/**
 * Deduplicate members by name within a room, keeping the most recent (highest last_seen)
 * Does NOT modify the database, only filters the list
 * @param {Array} members - Array of member objects from DB
 * @returns {Array} Deduplicated members with presence field added
 */
export function deduplicateAndAddPresence(members) {
  // Group by name (case-insensitive, trimmed)
  const byName = new Map();

  for (const member of members) {
    const nameKey = (member.name || '').trim().toLowerCase();

    if (!byName.has(nameKey)) {
      byName.set(nameKey, member);
    } else {
      // Keep the one with the most recent last_seen
      const existing = byName.get(nameKey);
      const lastSeenExisting = existing.last_seen ? new Date(existing.last_seen).getTime() : 0;
      const lastSeenCurrent = member.last_seen ? new Date(member.last_seen).getTime() : 0;

      if (lastSeenCurrent > lastSeenExisting) {
        byName.set(nameKey, member);
      }
    }
  }

  // Convert back to array and add presence field
  return Array.from(byName.values()).map(m => ({
    name: m.name,
    role: m.role,
    last_seen: m.last_seen,
    presence: calculatePresence(m.last_seen)
  }));
}
