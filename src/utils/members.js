import { parseDbTime } from './time.js';
import { isMentioned } from './mentions.js';

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

  const lastSeenTime = parseDbTime(lastSeen);
  if (Number.isNaN(lastSeenTime)) return 'stale';
  const diffMs = Date.now() - lastSeenTime;

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
      const lastSeenExisting = existing.last_seen ? parseDbTime(existing.last_seen) : 0;
      const lastSeenCurrent = member.last_seen ? parseDbTime(member.last_seen) : 0;

      if (lastSeenCurrent > lastSeenExisting) {
        byName.set(nameKey, member);
      }
    }
  }

  // Convert back to array and add presence field
  return Array.from(byName.values()).map(m => ({
    _id: m.id,
    name: m.name,
    role: m.role,
    last_seen: m.last_seen,
    presence: calculatePresence(m.last_seen)
  }));
}

/**
 * Count, per member, the messages addressed to them (reply to one of their messages, or @mention)
 * that they have not answered since (no message of theirs with a higher id, no reaction to it).
 * Single pass from the end: only messages after a member's last message can be unreplied.
 * @param {Array} messages - All room messages, ascending id ({id, member_id, author, content, reply_to})
 * @param {Array} members - [{id, name}]
 * @param {Set<string>} [reacted] - "messageId:memberId" pairs (a reaction acknowledges a message)
 * @returns {Map<number, number>} member id -> pending count
 */
export function countPendingUnreplied(messages, members, reacted = new Set()) {
  const authorOf = new Map(messages.map(m => [m.id, m.member_id]));
  const lastIdByName = new Map();
  for (const msg of messages) if (msg.author) lastIdByName.set(msg.author, msg.id);

  const counts = new Map();
  for (const member of members) {
    const since = lastIdByName.get(member.name) || 0;
    let count = 0;
    for (let i = messages.length - 1; i >= 0 && messages[i].id > since; i--) {
      const msg = messages[i];
      if (msg.author === 'HubWatchdog' || msg.author === 'system' || msg.author === 'Transcription') continue;
      if (msg.deleted_at || reacted.has(`${msg.id}:${member.id}`)) continue;
      const mentioned = isMentioned(msg.content, member.name);
      const repliedTo = msg.reply_to && authorOf.get(msg.reply_to) === member.id &&
        !members.some(o => o.id !== member.id && isMentioned(msg.content, o.name));
      if (mentioned || repliedTo) {
        count++;
      }
    }
    counts.set(member.id, count);
  }
  return counts;
}
