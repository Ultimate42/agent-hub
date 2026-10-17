import { Router } from 'express';
import { database } from '../db.js';
import { generateToken, compareTokens, maskToken } from '../utils/tokens.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { checkMemberContext } from '../utils/security-check.js';
import { deduplicateAndAddPresence } from '../utils/members.js';

const router = Router();

// Long-poll waiting clients: Map<roomId, Set<{res, since, timeout}>>
const waitingClients = new Map();

/**
 * Notify waiting clients of new messages
 */
export function notifyWaiters(roomId, messages) {
  const clients = waitingClients.get(roomId);
  if (!clients || clients.size === 0) return;

  for (const client of clients) {
    clearTimeout(client.timeout);
    client.res.json({ messages });
    clients.delete(client);
  }
}

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
    const { name } = req.body || {};

    const roomToken = generateToken(config.tokenLength);
    const adminToken = generateToken(config.adminTokenLength);

    const roomId = database.createRoom(roomToken, adminToken, name || 'Untitled Room');

    logger.info('Room created', { roomId, name });

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
    const { name, role = 'agent' } = req.body || {};

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
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
        is_rejoin: true
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
      is_rejoin: false
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

  res.json({
    members: dedupedMembers.map(m => {
      const obj = {
        name: m.name,
        role: m.role,
        last_seen: m.last_seen,
        presence: m.presence,
        is_you: m.name === member.name
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

  if (!member.permissions.includes('w')) {
    return res.status(403).json({ error: 'Write permission required' });
  }

  // Secure mode: only coordinators (manager/second) and agents can post
  if (room.settings?.secure_mode) {
    const allowedRoles = ['manager', 'second', 'agent'];
    const coordinationRole = member.coordination_role;

    if (!allowedRoles.includes(member.role) && !coordinationRole) {
      return res.status(403).json({ error: 'Secure mode: Only coordinators and agents can post messages' });
    }
  }

  const { content, type = 'message', reply_to } = req.body || {};

  if (!content) {
    return res.status(400).json({ error: 'Content is required' });
  }

  if (content.length > config.maxMessageSize) {
    return res.status(413).json({ error: 'Message too large' });
  }

  // Validate reply_to if provided
  if (reply_to && !database.messageExistsInRoom(reply_to, room.id)) {
    return res.status(400).json({ error: 'reply_to not found' });
  }

  const messageId = database.createMessage(room.id, member.id, type, content, reply_to);

  const newMessage = {
    id: messageId,
    type,
    content,
    author: member.name,
    author_role: member.role,
    reply_to,
    created_at: new Date().toISOString()
  };

  logger.debug('Message posted', { roomId: room.id, messageId, author: member.name });

  // Notify waiting long-poll clients
  notifyWaiters(room.id, [newMessage]);

  res.status(201).json(newMessage);
});

/**
 * GET /api/rooms/:token/messages - Read messages
 * Query params:
 *   since: return messages after this ID
 *   limit: max messages (default 50, max 100)
 *   exclude_self: if true, exclude messages from the calling member
 */
router.get('/rooms/:token/messages', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const since = parseInt(req.query.since, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, config.maxMessagesPerRequest);
  const excludeSelf = req.query.exclude_self === 'true';

  let messages;
  if (since > 0) {
    messages = database.getMessagesSince(room.id, since, limit);
  } else {
    messages = database.getMessages(room.id, limit);
  }

  // Filter out self messages if exclude_self is true
  if (excludeSelf) {
    messages = messages.filter(msg => msg.author !== member.name);
  }

  res.json({
    messages,
    last_id: messages.length > 0 ? messages[messages.length - 1].id : since
  });
});

/**
 * GET /api/rooms/:token/messages/wait - Long-poll for new messages
 */
router.get('/rooms/:token/messages/wait', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const since = parseInt(req.query.since, 10) || database.getLastMessageId(room.id);
  const timeout = Math.min(
    parseInt(req.query.timeout, 10) || config.longPollTimeout,
    config.longPollTimeout
  );

  // Check for existing messages first
  const existing = database.getMessagesSince(room.id, since, config.maxMessagesPerRequest);
  if (existing.length > 0) {
    return res.json({ messages: existing });
  }

  // Set up long-poll waiting
  if (!waitingClients.has(room.id)) {
    waitingClients.set(room.id, new Set());
  }

  const client = {
    res,
    since,
    timeout: setTimeout(() => {
      waitingClients.get(room.id)?.delete(client);
      res.json({ messages: [] });
    }, timeout)
  };

  waitingClients.get(room.id).add(client);

  // Clean up on disconnect
  req.on('close', () => {
    clearTimeout(client.timeout);
    waitingClients.get(room.id)?.delete(client);
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

  const { content } = req.body || {};

  if (!content) {
    return res.status(400).json({ error: 'Content is required' });
  }

  database.updateRoomDirective(room.id, content, member.name);

  logger.info('Directive updated', { roomId: room.id, by: member.name });

  res.json({ success: true, directive: content });
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
  database.updateMemberStatus(memberId, status);

  logger.info('Member status updated', { roomId: room.id, memberId, status });

  res.json({ success: true, member_id: memberId, status });
});

export default router;
