import { database } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { processWakeTargets } from '../wake-targets.js';
import { validateAttachmentIds } from './files.js';
import { queueTranscriptions } from './transcription.js';

export const MESSAGE_TYPES = ['message', 'question', 'response', 'directive'];
export const MEMBER_ROLES = ['agent', 'human', 'observer', 'manager', 'second'];
export const MAX_NAME_LENGTH = 64;
const RESERVED_NAMES = ['hubwatchdog', 'system', 'transcription'];

// ---------------------------------------------------------------------------
// Realtime fan-out: long-poll waiters + WebSocket clients
// ---------------------------------------------------------------------------

// Long-poll waiting clients: Map<roomId, Set<{res, since, timeout}>>
export const waitingClients = new Map();

// WebSocket broadcaster, registered by ws/handler.js (avoids a circular import)
let wsBroadcaster = null;
export function setWsBroadcaster(fn) {
  wsBroadcaster = fn;
}

/**
 * Resolve every long-poll waiting on a room with the given messages.
 */
export function notifyWaiters(roomId, messages) {
  const clients = waitingClients.get(roomId);
  if (!clients || clients.size === 0) return;

  for (const client of [...clients]) {
    // Cursor-mode waiters read their own unread backlog from the DB (excluding their own messages);
    // they only resolve when something is really unread, or when released (empty list = shutdown).
    if (client.tryDeliver && !client.tryDeliver(messages.length === 0)) continue;
    clearTimeout(client.timeout);
    clients.delete(client);
    try {
      if (client.tryDeliver) { /* already answered by tryDeliver */ }
      else if (!client.res.headersSent) client.res.json({ messages });
    } catch (err) {
      logger.warn('Failed to notify long-poll waiter', { error: err.message });
    }
  }
  if (clients.size === 0) waitingClients.delete(roomId);
}

/**
 * Release all pending long-polls (used on shutdown).
 */
export function releaseAllWaiters() {
  for (const roomId of [...waitingClients.keys()]) notifyWaiters(roomId, []);
}

/**
 * Publish a new message to ALL realtime channels (WebSocket + long-poll).
 * Single entry point: every code path that creates a message must call this.
 */
export function publishMessage(roomId, message) {
  try {
    wsBroadcaster?.(roomId, message);
  } catch (err) {
    logger.warn('WebSocket broadcast failed', { error: err.message });
  }
  notifyWaiters(roomId, [message]);
}

// ---------------------------------------------------------------------------
// Server-side read cursor (per member)
// ---------------------------------------------------------------------------
// Each member has a persistent cursor (members.last_read_id). Without an explicit `since`, reads return
// the member's UNREAD messages (id > cursor, own messages excluded) in id order, paginated.
// Default ack mode "auto": the cursor advances to the last message DELIVERED in a successful response.
// Mode "manual" (auto_ack=false): the cursor only moves on ack_messages(up_to_id) -> at-least-once.
// With an explicit `since`, legacy behaviour (messages after since, own included); the cursor only
// auto-advances if since <= cursor (contiguous: nothing unread can be skipped). It never moves backwards.

export function parseBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return !['false', '0', 'no', 'off'].includes(String(v).toLowerCase());
}

/** Unread backlog page for a member (no side effect). */
export function peekUnread(member, limit) {
  const cursor = database.getReadCursor(member.id);
  return database.getUnread(member.room_id, member.id, cursor, limit);
}

/**
 * Finalize a delivery: optionally advance the cursor, and build the cursor info for the response.
 * @param {object} opts { since: number|0 (explicit since), autoAck: boolean }
 */
export function settleDelivery(member, messages, { since = 0, autoAck = true } = {}) {
  let cursor = database.getReadCursor(member.id);
  if (autoAck && messages.length > 0 && (!since || since <= cursor)) {
    cursor = database.ackUpTo(member.id, messages[messages.length - 1].id);
  }
  return {
    last_read_id: cursor,
    unread_remaining: database.countUnread(member.room_id, member.id, cursor)
  };
}

/** Explicit acknowledgement. Returns { last_read_id, unread_remaining }. */
export function ackMessages(member, upToId) {
  const n = Number(upToId);
  if (!Number.isInteger(n) || n < 0) throw new Error('up_to_id must be a non-negative integer');
  const cursor = database.ackUpTo(member.id, n);
  return { acked: true, last_read_id: cursor, unread_remaining: database.countUnread(member.room_id, member.id, cursor) };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate a display name. Returns the trimmed name or null.
 */
export function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;
  if (RESERVED_NAMES.includes(trimmed.toLowerCase())) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Unified message posting (REST, MCP and WebSocket)
// ---------------------------------------------------------------------------

/**
 * Validate, store and publish a message.
 * @returns {{ok: true, message: object} | {ok: false, status: number, error: string}}
 */
export function postMessage(member, { content, type = 'message', reply_to, attachments, applyDirective = false } = {}) {
  const fail = (status, error) => ({ ok: false, status, error });

  if (!member.permissions.includes('w')) return fail(403, 'Write permission required');

  const room = database.getRoomById(member.room_id);
  if (!room) return fail(404, 'Room not found');

  // Secure mode: only coordinators (manager/second) and agents can post
  if (room.settings?.secure_mode) {
    const allowedRoles = ['manager', 'second', 'agent'];
    if (!allowedRoles.includes(member.role) && !member.coordination_role) {
      return fail(403, 'Secure mode: Only coordinators and agents can post messages');
    }
  }

  const files = validateAttachmentIds(member, attachments);
  if (!files.ok) return fail(files.status, files.error);

  // A message carrying files may have no text
  if (files.ids.length > 0 && (content === undefined || content === null)) content = '';
  if (typeof content !== 'string' || (!content && files.ids.length === 0)) return fail(400, 'Content is required');
  if (content.length > config.maxMessageSize) return fail(413, 'Message too large');
  if (typeof type !== 'string' || !MESSAGE_TYPES.includes(type)) {
    return fail(400, `Invalid type. Must be one of: ${MESSAGE_TYPES.join(', ')}`);
  }

  let replyTo = null;
  if (reply_to !== undefined && reply_to !== null && reply_to !== '' && reply_to !== 0) {
    replyTo = Number(reply_to);
    if (!Number.isInteger(replyTo) || !database.messageExistsInRoom(replyTo, room.id)) {
      return fail(400, 'reply_to not found');
    }
  }

  if (applyDirective && type === 'directive') {
    database.updateRoomDirective(room.id, content, member.name);
  }

  let messageId;
  try {
    messageId = database.db.transaction(() => {
      const id = Number(database.createMessage(room.id, member.id, type, content, replyTo));
      if (files.ids.length > 0) database.linkAttachments(id, files.ids);
      return id;
    })();
  } catch (err) {
    if (err.message === 'attachment already used') return fail(400, 'attachment is already attached to a message');
    throw err;
  }
  queueTranscriptions(files.ids);
  const attachmentList = files.ids.length > 0
    ? database.getMessageAttachments(messageId)
    : undefined;

  const message = {
    id: messageId,
    type,
    content,
    author: member.name,
    author_role: member.role,
    reply_to: replyTo ?? undefined,
    attachments: attachmentList,
    created_at: new Date().toISOString()
  };

  logger.debug('Message posted', { roomId: room.id, messageId, author: member.name });

  publishMessage(room.id, message);

  // Wake targets run asynchronously (don't block the caller)
  processWakeTargets(room.id, messageId, member.id, member.name, content, replyTo).catch(err => {
    logger.error('Error processing wake targets after message', { error: err.message });
  });

  return { ok: true, message };
}
