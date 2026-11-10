// Wake policy service: glue between the DB and the pure rule in ../wake-policy.js.
import { database } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { WAKE_POLICIES, DEFAULT_WAKE_POLICY, normalizePolicy, effectivePolicy, decideWake } from '../wake-policy.js';

// Log an anti-loop suspension once per (member, streak run), not once per message
const loggedSuspension = new Map();

/** Decide for one stored message (row from database.getMessage / getAllMessages-like with member_id). */
export function decideForStoredMessage(member, msg, { members, recent } = {}) {
  const roomMembers = members || database.getMembersByRoom(member.room_id);
  const replyTo = msg.reply_to ? database.getMessage(msg.reply_to) : null;
  const message = {
    author_id: msg.member_id,
    author: msg.author,
    author_role: msg.author_role,
    content: msg.content,
    type: msg.type,
    reply_to_member_id: replyTo?.member_id ?? null
  };
  const limit = config.wakeLoopLimit;
  const earlier = recent || database.getRecentForWake(member.room_id, msg.id, limit + 2);
  const d = decideWake({
    policy: member.wake_policy,
    member: { id: member.id, name: member.name },
    message, recent: earlier,
    memberNames: roomMembers.map(m => m.name),
    loopLimit: limit
  });
  if (d.reason === 'loop-suspended') {
    const key = `${member.id}`;
    if (!loggedSuspension.has(key)) {
      loggedSuspension.set(key, msg.id);
      logger.info('Wake suspended: agent-only loop guard', { roomId: member.room_id, member: member.name, messageId: msg.id, streak: d.streak, limit });
    }
  } else if (d.reason === 'mention' || d.reason === 'human') {
    loggedSuspension.delete(`${member.id}`);
  }
  return d;
}

export function getWakePolicyInfo(member) {
  return {
    member: member.name,
    policy: effectivePolicy(member.wake_policy),
    is_default: !normalizePolicy(member.wake_policy),
    policies: WAKE_POLICIES,
    default_policy: DEFAULT_WAKE_POLICY,
    loop_limit: config.wakeLoopLimit,
    history: database.getWakePolicyLog(member.id)
  };
}

/** A member changes its own policy. Returns {ok, ...info} or {ok:false,status,error}. */
export function setWakePolicy(member, policy, changedBy = member.name) {
  const p = normalizePolicy(policy);
  if (!p) return { ok: false, status: 400, error: `policy must be one of: ${WAKE_POLICIES.join(', ')}` };
  const old = database.setWakePolicy(member, p, changedBy);
  logger.info('Wake policy changed', { roomId: member.room_id, member: member.name, from: old ?? DEFAULT_WAKE_POLICY, to: p, by: changedBy });
  return { ok: true, ...getWakePolicyInfo({ ...member, wake_policy: p }) };
}

/** Decisions for a list of message ids of the member's room (used by the watcher kit). */
export function wakeCheck(member, ids) {
  const members = database.getMembersByRoom(member.room_id);
  const fresh = members.find(m => m.id === member.id) || member;
  const decisions = [];
  for (const raw of ids) {
    const msg = Number.isInteger(raw) ? database.getMessage(raw) : undefined;
    if (!msg || msg.room_id !== member.room_id) { decisions.push({ id: raw, wake: false, reason: 'unknown' }); continue; }
    const d = decideForStoredMessage({ ...member, wake_policy: fresh.wake_policy }, msg, { members });
    decisions.push({ id: msg.id, wake: d.wake, reason: d.reason });
  }
  return { policy: effectivePolicy(fresh.wake_policy), loop_limit: config.wakeLoopLimit, decisions };
}
