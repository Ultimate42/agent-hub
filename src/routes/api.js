import { Router } from 'express';
import { database } from '../db.js';
import { generateToken, compareTokens, maskToken } from '../utils/tokens.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { checkMemberContext } from '../utils/security-check.js';
import { deduplicateAndAddPresence, countPendingUnreplied } from '../utils/members.js';
import {
  postMessage, notifyWaiters, waitingClients, sanitizeName, MEMBER_ROLES,
  parseBool, peekUnread, settleDelivery, ackMessages,
  editMessage, deleteMessage, toggleReaction, setDirective
} from '../services/messages.js';
import { exportMessages, exportJson, exportMarkdown } from '../services/export.js';
import { checkRoomCreationLimit } from '../utils/security.js';
import { deleteRoomFiles } from '../services/files.js';

const router = Router();

// Re-exported for backward compatibility (implementation lives in services/messages.js)
export { notifyWaiters };

const MAX_LONGPOLLS_PER_ROOM = 200;

// Helper: Extract token from Authorization header or query
function getToken(req) {
  const auth = req.get('Authorization');
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return req.query.token;
}

// Helper: Validate member access
function requireMember(req, res) {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authorization required' });
    return null;
  }

  const member = database.getMemberByToken(token);
  if (!member) {
    res.status(403).json({ error: 'Invalid token' });
    return null;
  }

  database.updateMemberLastSeen(member.id);
  return member;
}

/**
 * POST /api/rooms - Create a new room
 */
router.post('/rooms', (req, res) => {
  try {
    if (!checkRoomCreationLimit(req.ip)) {
      return res.status(429).json({ error: `Rate limit exceeded: max ${config.maxRoomsPerHour} rooms per hour` });
    }

    let { name } = req.body || {};
    if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > 200)) {
      return res.status(400).json({ error: 'name must be a string of at most 200 characters' });
    }
    name = (typeof name === 'string' && name.trim()) ? name.trim() : null;

    const roomToken = generateToken(config.tokenLength);
    const adminToken = generateToken(config.adminTokenLength);

    const roomId = database.createRoom(roomToken, adminToken, name || 'Untitled Room');

    logger.info('Room created', { roomId });

    res.status(201).json({
      room_token: roomToken,
      admin_token: adminToken,
      name: name || 'Untitled Room',
      url: `${config.publicUrl}/r/${roomToken}`,
      setup_url: `${config.publicUrl}/r/${roomToken}/setup`
    });
  } catch (error) {
    logger.error('Failed to create room', { error: error.message });
    res.status(500).json({ error: 'Failed to create room' });
  }
});

/**
 * GET /api/rooms/:token - Get room info
 */
router.get('/rooms/:token', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  // Verify member belongs to this room
  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json({
    name: room.name,
    directive: room.directive,
    created_at: room.created_at,
    member_count: database.countMembersByRoom(room.id)
  });
});

/**
 * DELETE /api/rooms/:token - Delete a room (requires admin token)
 */
router.delete('/rooms/:token', (req, res) => {
  const adminToken = getToken(req);
  if (!adminToken) {
    return res.status(401).json({ error: 'Admin token required' });
  }

  const room = database.getRoomByToken(req.params.token);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (!compareTokens(adminToken, room.admin_token)) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }

  database.deleteRoom(room.id);
  deleteRoomFiles(room.id);
  logger.info('Room deleted', { roomId: room.id });

  res.json({ success: true });
});

/**
 * POST /api/rooms/:token/join - Join a room (idempotent)
 * If a member with same name exists, update their token and return 200
 * If no member exists, create new and return 201
 */
router.post('/rooms/:token/join', (req, res) => {
  try {
    const body = req.body || {};
    const name = sanitizeName(body.name);
    const role = body.role === undefined || body.role === null ? 'agent' : body.role;

    if (!name) {
      return res.status(400).json({ error: `Name is required (string, max 64 chars, no control characters)` });
    }
    if (typeof role !== 'string' || !MEMBER_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${MEMBER_ROLES.join(', ')}` });
    }

    const room = database.getRoomByToken(req.params.token);
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Check if member with same name already exists (case-insensitive, trimmed)
    const existingMember = database.getMemberByNameAndRoom(room.id, name);

    if (existingMember) {
      // Member exists: update token and role, invalidate old token
      const newToken = generateToken(config.tokenLength);
      database.updateMemberToken(existingMember.id, newToken);

      // Update role if provided
      if (role && role !== 'agent') {
        database.updateMemberRole(existingMember.id, role);
      }

      logger.info('Member rejoined (token refreshed)', { roomId: room.id, memberId: existingMember.id, name, role });

      // No system message for rejoin to avoid noise
      return res.status(200).json({
        member_token: newToken,
        room_name: room.name,
        directive: room.directive,
        is_rejoin: true,
        unread_count: database.countUnread(room.id, existingMember.id),
        last_read_id: database.getReadCursor(existingMember.id)
      });
    }

    // New member: check limit and create
    const memberCount = database.countMembersByRoom(room.id);
    if (memberCount >= config.maxMembersPerRoom) {
      return res.status(429).json({ error: 'Room is full' });
    }

    const memberToken = generateToken(config.tokenLength);
    const memberId = database.createMember(room.id, memberToken, name, role);

    // Secure mode: check member context
    if (room.settings.secure_mode) {
      const status = checkMemberContext(name);
      if (status !== 'normal') {
        database.updateMemberStatus(memberId, status);
        logger.warn('Member flagged in secure mode', { roomId: room.id, name, status });
      }
    }

    logger.info('Member joined', { roomId: room.id, memberId, name, role });

    // Notify others only for new joins
    notifyWaiters(room.id, [{
      type: 'system',
      content: `${name} joined the room`,
      author: 'system',
      created_at: new Date().toISOString()
    }]);

    res.status(201).json({
      member_token: memberToken,
      room_name: room.name,
      directive: room.directive,
      is_rejoin: false,
      unread_count: 0,
      last_read_id: database.getReadCursor(memberId)
    });
  } catch (error) {
    logger.error('Failed to join room', { error: error.message });
    res.status(500).json({ error: 'Failed to join room' });
  }
});

/**
 * GET /api/rooms/:token/members - List members
 */
router.get('/rooms/:token/members', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const allMembers = database.getMembersByRoom(room.id);
  const dedupedMembers = deduplicateAndAddPresence(allMembers);
  const pending = countPendingUnreplied(
    database.getAllMessages(room.id),
    dedupedMembers.map(m => ({ id: m._id, name: m.name })),
    database.getRoomReactionPairs(room.id)
  );

  res.json({
    members: dedupedMembers.map(m => {
      const obj = {
        name: m.name,
        role: m.role,
        last_seen: m.last_seen,
        presence: m.presence,
        is_you: m.name === member.name,
        unread_count: database.countUnread(room.id, m._id),
        pending_unreplied: pending.get(m._id) || 0
      };
      return obj;
    })
  });
});

/**
 * POST /api/rooms/:token/messages - Post a message
 */
router.post('/rooms/:token/messages', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { content, type, reply_to, attachments } = req.body || {};
  const result = postMessage(member, { content, type, reply_to, attachments });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  res.status(201).json(result.message);
});

/**
 * GET /api/rooms/:token/messages - Read messages
 * Query params:
 *   since: return messages after this ID (legacy; omit it to use the server-side read cursor)
 *   limit: max messages (default 50, max 100)
 *   exclude_self: if true, exclude messages from the calling member
 *   auto_ack: default true (cursor advances on delivery); false = only POST /ack moves it
 *   mode=recent: last N messages (history view), never touches the cursor
 * Without since: returns the member's UNREAD messages (own excluded, id order, paginated);
 * if nothing is unread, returns recent history (history: true).
 */
router.get('/rooms/:token/messages', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const since = Math.max(parseInt(req.query.since, 10) || 0, 0);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), config.maxMessagesPerRequest);
  const excludeSelf = req.query.exclude_self === 'true';
  const autoAck = parseBool(req.query.auto_ack, true);
  const recentOnly = req.query.mode === 'recent';

  let messages;
  let history = false;
  if (since > 0) {
    messages = database.getMessagesSince(room.id, since, limit);
  } else if (recentOnly) {
    history = true;
    messages = database.getMessages(room.id, limit);
  } else {
    messages = peekUnread(member, limit);
    if (messages.length === 0) {
      history = true;
      messages = database.getMessages(room.id, limit);
    }
  }

  // Filter out self messages if exclude_self is true
  if (excludeSelf) {
    messages = messages.filter(msg => msg.author !== member.name);
  }

  const info = settleDelivery(member, history ? [] : messages, { since, autoAck });
  res.json({
    messages,
    last_id: messages.length > 0 ? messages[messages.length - 1].id : (since || info.last_read_id),
    ...info,
    history
  });
});

// Resolve the calling member and check it belongs to :token (sends the error response otherwise)
function requireRoomMember(req, res) {
  const member = requireMember(req, res);
  if (!member) return null;
  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return { member, room };
}

/**
 * PATCH /api/rooms/:token/messages/:id {content} - Edit one of your messages
 */
router.patch('/rooms/:token/messages/:id', (req, res) => {
  const ctx = requireRoomMember(req, res);
  if (!ctx) return;
  const result = editMessage(ctx.member, req.params.id, (req.body || {}).content);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.message);
});

/**
 * DELETE /api/rooms/:token/messages/:id - Delete one of your messages (and its files)
 */
router.delete('/rooms/:token/messages/:id', (req, res) => {
  const ctx = requireRoomMember(req, res);
  if (!ctx) return;
  const result = deleteMessage(ctx.member, req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ success: true, id: result.id });
});

/**
 * POST /api/rooms/:token/messages/:id/reactions {emoji} - Toggle an emoji reaction
 */
router.post('/rooms/:token/messages/:id/reactions', (req, res) => {
  const ctx = requireRoomMember(req, res);
  if (!ctx) return;
  const result = toggleReaction(ctx.member, req.params.id, (req.body || {}).emoji);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ message_id: result.message_id, reactions: result.reactions });
});

/**
 * GET /api/rooms/:token/messages/search?q=text&limit=50 - Search content, authors, file names, transcripts
 */
router.get('/rooms/:token/messages/search', (req, res) => {
  const ctx = requireRoomMember(req, res);
  if (!ctx) return;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q || q.length > 200) return res.status(400).json({ error: 'q is required (max 200 characters)' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), config.maxMessagesPerRequest);
  res.json({ query: q, messages: database.searchMessages(ctx.room.id, q, limit) });
});

/**
 * GET /api/rooms/:token/export?format=md|json - Download the whole conversation
 */
router.get('/rooms/:token/export', (req, res) => {
  const ctx = requireRoomMember(req, res);
  if (!ctx) return;
  const messages = exportMessages(ctx.room.id);
  const base = (ctx.room.name || 'room').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'room';
  if (req.query.format === 'json') {
    res.set('Content-Disposition', `attachment; filename="${base}.json"`);
    return res.json(exportJson(ctx.room, messages));
  }
  res.set('Content-Disposition', `attachment; filename="${base}.md"`);
  res.type('text/markdown; charset=utf-8').send(exportMarkdown(ctx.room, messages));
});

/**
 * GET /api/rooms/:token/messages/history?before_id=N&limit=50 - older messages, never touches the cursor
 */
router.get('/rooms/:token/messages/history', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;
  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), config.maxMessagesPerRequest);
  const before = parseInt(req.query.before_id, 10) > 0 ? parseInt(req.query.before_id, 10) : Number.MAX_SAFE_INTEGER;
  const messages = database.getMessagesBefore(room.id, before, limit);
  res.json({
    messages,
    oldest_id: messages.length ? messages[0].id : null,
    has_more: messages.length === limit && database.messageExistsBefore(room.id, messages[0].id),
    last_read_id: database.getReadCursor(member.id)
  });
});

/**
 * POST /api/rooms/:token/ack {up_to_id} - explicit read receipt (cursor never moves backwards)
 */
router.post('/rooms/:token/ack', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;
  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(ackMessages(member, (req.body || {}).up_to_id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/rooms/:token/messages/wait - Long-poll for new messages
 * Without since: cursor mode (first returns the whole unread backlog; see GET /messages).
 */
router.get('/rooms/:token/messages/wait', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const since = Math.max(parseInt(req.query.since, 10) || 0, 0);
  const autoAck = parseBool(req.query.auto_ack, true);
  const timeout = Math.min(
    parseInt(req.query.timeout, 10) || config.longPollTimeout,
    config.longPollTimeout
  );
  database.updateMemberLastSeen(member.id);

  const respond = (messages) => {
    const info = settleDelivery(member, messages, { since, autoAck });
    res.json({
      messages,
      last_id: messages.length > 0 ? messages[messages.length - 1].id : (since || info.last_read_id),
      ...info
    });
  };

  // Check for existing messages first
  const existing = since
    ? database.getMessagesSince(room.id, since, config.maxMessagesPerRequest)
    : peekUnread(member, config.maxMessagesPerRequest);
  if (existing.length > 0) {
    return respond(existing);
  }

  // Set up long-poll waiting
  if ((waitingClients.get(room.id)?.size || 0) >= MAX_LONGPOLLS_PER_ROOM) {
    return res.status(429).json({ error: 'Too many concurrent long-polls for this room' });
  }
  if (!waitingClients.has(room.id)) {
    waitingClients.set(room.id, new Set());
  }

  const client = {
    res,
    since,
    timeout: setTimeout(() => {
      const set = waitingClients.get(room.id);
      set?.delete(client);
      if (set && set.size === 0) waitingClients.delete(room.id);
      if (!res.headersSent) respond([]);
    }, timeout)
  };
  if (!since) {
    // Cursor mode: re-read the unread backlog from the DB when something is published
    // (own messages are not unread, so they do not wake the waiter).
    client.tryDeliver = (force) => {
      if (res.headersSent) return true;
      const msgs = peekUnread(member, config.maxMessagesPerRequest);
      if (msgs.length === 0 && !force) return false;
      respond(msgs);
      return true;
    };
  }

  waitingClients.get(room.id).add(client);

  // Clean up on disconnect
  req.on('close', () => {
    clearTimeout(client.timeout);
    const set = waitingClients.get(room.id);
    set?.delete(client);
    if (set && set.size === 0) waitingClients.delete(room.id);
  });
});

/**
 * POST /api/rooms/:token/directive - Set room directive (archives old directive)
 */
router.post('/rooms/:token/directive', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!member.permissions.includes('w')) {
    return res.status(403).json({ error: 'Write permission required' });
  }

  const result = setDirective(member, (req.body || {}).content);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  logger.info('Directive updated', { roomId: room.id, by: member.name });

  res.json({ success: true, directive: result.directive });
});

/**
 * GET /api/rooms/:token/directive/history - Get directive history (read-only)
 */
router.get('/rooms/:token/directive/history', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const history = database.getDirectiveHistory(room.id, limit);

  res.json({ history });
});

/**
 * DELETE /api/rooms/:token/leave - Leave a room
 */
router.delete('/rooms/:token/leave', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  database.deleteMember(member.id);

  logger.info('Member left', { roomId: room.id, name: member.name });

  res.json({ success: true });
});

/**
 * POST /api/rooms/:token/settings - Update room settings (admin only)
 */
router.post('/rooms/:token/settings', (req, res) => {
  const adminToken = getToken(req);
  if (!adminToken) {
    return res.status(401).json({ error: 'Admin token required' });
  }

  const room = database.getRoomByToken(req.params.token);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (!compareTokens(adminToken, room.admin_token)) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }

  const { secure_mode } = req.body || {};

  if (typeof secure_mode !== 'boolean') {
    return res.status(400).json({ error: 'secure_mode must be a boolean' });
  }

  const newSettings = { ...room.settings, secure_mode };
  database.updateRoomSettings(room.id, newSettings);

  logger.info('Room settings updated', { roomId: room.id, secure_mode });

  res.json({ success: true, settings: newSettings });
});

/**
 * POST /api/rooms/:token/members/:memberId/status - Update member status (admin only)
 */
router.post('/rooms/:token/members/:memberId/status', (req, res) => {
  const adminToken = getToken(req);
  if (!adminToken) {
    return res.status(401).json({ error: 'Admin token required' });
  }

  const room = database.getRoomByToken(req.params.token);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (!compareTokens(adminToken, room.admin_token)) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }

  const { status } = req.body || {};

  if (!['normal', 'suspect', 'quarantine'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be: normal, suspect, or quarantine' });
  }

  const memberId = parseInt(req.params.memberId, 10);
  const target = database.getMembersByRoom(room.id).find(m => m.id === memberId);
  if (!target) {
    return res.status(404).json({ error: 'Member not found in this room' });
  }
  database.updateMemberStatus(memberId, status);

  logger.info('Member status updated', { roomId: room.id, memberId, status });

  res.json({ success: true, member_id: memberId, status });
});

export default router;
