// Wake policy: which messages should wake which member. Pure functions (no DB, no I/O) shared by the
// watchdog, the wake targets, the REST endpoint used by the watcher kit and the tests.
// Nothing here knows a room or an agent by name: only roles, mentions and each member's own policy.
import { isMentioned } from './utils/mentions.js';

export const WAKE_POLICIES = ['all', 'humans+mentions', 'mentions'];
export const DEFAULT_WAKE_POLICY = 'humans+mentions';
export const DEFAULT_LOOP_LIMIT = 6;
// Roles whose messages count as "a human spoke" (resets the anti-loop counter, wakes humans+mentions)
export const HUMAN_ROLES = ['human'];
// Hub-internal authors: never wake anybody
const SYSTEM_NAMES = new Set(['system', 'hubwatchdog', 'transcription']);
const WAKE_TYPES = new Set(['message', 'question', 'response', 'directive']);

export function normalizePolicy(p) {
  const v = typeof p === 'string' ? p.trim().toLowerCase() : '';
  return WAKE_POLICIES.includes(v) ? v : null;
}
export const effectivePolicy = (p) => normalizePolicy(p) || DEFAULT_WAKE_POLICY;

export const isHumanRole = (role) => HUMAN_ROLES.includes(String(role || '').toLowerCase());
export function isSystemAuthor(name) {
  const n = String(name || '').trim().toLowerCase();
  return !n || SYSTEM_NAMES.has(n) || n.startsWith('auto-');
}

/**
 * Is `message` addressed to `member`? @Name in the content, or a reply to one of their messages
 * (unless the reply names other members only: then it is addressed to them).
 */
export function isAddressed(message, member, memberNames = []) {
  if (isMentioned(message.content, member.name)) return true;
  if (message.reply_to_member_id != null && message.reply_to_member_id === member.id) {
    return !memberNames.some(n => n !== member.name && isMentioned(message.content, n));
  }
  return false;
}

/**
 * Number of consecutive non-human messages ending with `message` (included), stopping at the last human
 * message or at the last message that mentions `member` (not counted: the conversation restarted there).
 * `recent` = messages posted before `message`, NEWEST FIRST, shape {author, author_role, content}.
 */
export function agentStreak(message, member, recent = [], limit = DEFAULT_LOOP_LIMIT) {
  let n = 1;
  for (const m of recent) {
    if (n > limit) break; // already past the limit: no need to look further
    if (isSystemAuthor(m.author) || !WAKE_TYPES.has(m.type || 'message')) continue;
    if (isHumanRole(m.author_role)) break;
    if (isMentioned(m.content, member.name)) break;
    n++;
  }
  return n;
}

/**
 * Decide whether `message` wakes `member`.
 *  policy   : 'all' | 'humans+mentions' | 'mentions' (null = default)
 *  member   : {id, name}
 *  message  : {author_id, author, author_role, content, type, reply_to_member_id}
 *  recent   : earlier messages, newest first (only used for the anti-loop guard)
 *  memberNames : names of the room members (reply-naming-others rule)
 * Returns {wake, reason, streak?}. reason: own | system | not-chat | mention | human | all | policy | loop-suspended
 */
export function decideWake({ policy, member, message, recent = [], memberNames = [], loopLimit = DEFAULT_LOOP_LIMIT }) {
  const p = effectivePolicy(policy);
  if (message.author_id != null && message.author_id === member.id) return { wake: false, reason: 'own' };
  if (message.author && String(message.author).trim().toLowerCase() === String(member.name).trim().toLowerCase()) return { wake: false, reason: 'own' };
  if (isSystemAuthor(message.author)) return { wake: false, reason: 'system' };
  if (message.type && !WAKE_TYPES.has(message.type)) return { wake: false, reason: 'not-chat' };

  if (isAddressed(message, member, memberNames)) return { wake: true, reason: 'mention' };
  const human = isHumanRole(message.author_role);
  if (p === 'mentions') return { wake: false, reason: 'policy' };
  if (human) return { wake: true, reason: 'human' };
  if (p === 'humans+mentions') return { wake: false, reason: 'policy' };

  // p === 'all', author is an agent, not addressed: anti-loop guard
  const limit = Number.isFinite(loopLimit) && loopLimit > 0 ? loopLimit : DEFAULT_LOOP_LIMIT;
  const streak = agentStreak(message, member, recent, limit);
  if (streak > limit) return { wake: false, reason: 'loop-suspended', streak };
  return { wake: true, reason: 'all', streak };
}

/**
 * Did `message` genuinely wait for an answer from `member`? (watchdog: "no reply" alerts)
 * A wake-up is not enough: with humans+mentions every human message wakes every member, which is no
 * request for a reply. A reply is expected only when
 *  - the member is explicitly mentioned or the message replies directly to one of their messages, or
 *  - a human posts in a room where the member is the only possible non-human recipient.
 * Hub-internal members (system, HubWatchdog, Transcription, auto-*) and observers never owe a reply.
 * `members` = room members {id, name, role}; `message` as for decideWake.
 */
export function expectsReply({ message, member, members = [] }) {
  if (isSystemAuthor(member.name) || String(member.role || '').toLowerCase() === 'observer') return false;
  if (isSystemAuthor(message.author)) return false;
  if (isAddressed(message, member, members.map(m => m.name))) return true;
  if (!isHumanRole(message.author_role)) return false;
  const recipients = members.filter(m => m.id !== message.author_id && !isHumanRole(m.role)
    && String(m.role || '').toLowerCase() !== 'observer' && !isSystemAuthor(m.name));
  return recipients.length === 1 && recipients[0].id === member.id;
}

/** Old enough to be worth an alert, but not so old that it is history (e.g. after a restart). */
export function inAlertWindow(elapsedSeconds, minSeconds, maxSeconds) {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < minSeconds) return false;
  return !(Number.isFinite(maxSeconds) && maxSeconds > 0 && elapsedSeconds > maxSeconds);
}
