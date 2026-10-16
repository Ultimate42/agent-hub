import { Router } from 'express';
import { database } from '../db.js';
import { logger } from '../utils/logger.js';
import { broadcast } from '../ws/handler.js';

const router = Router();

// Coordination timeout in milliseconds (15 seconds)
const COORDINATION_TIMEOUT = 15000;
const HEARTBEAT_INTERVAL = 5000;

// Helper: Extract token from Authorization header
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

  return member;
}

/**
 * POST /api/rooms/:token/coordination/heartbeat
 * Send heartbeat from manager/second agent
 */
router.post('/rooms/:token/coordination/heartbeat', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  // Verify member belongs to this room
  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Update heartbeat timestamp
  const now = Date.now();
  database.updateMemberHeartbeat(member.id, now);
  database.updateMemberLastSeen(member.id);

  // Get coordination status
  const coordMembers = database.getCoordinationMembers(room.id);
  const manager = coordMembers.find(m => m.coordination_role === 'manager');
  const second = coordMembers.find(m => m.coordination_role === 'second');

  // Check for timeout and trigger failover if needed
  let failover = null;
  if (manager && manager.last_heartbeat) {
    const timeSinceLastHeartbeat = now - manager.last_heartbeat;
    if (timeSinceLastHeartbeat > COORDINATION_TIMEOUT && second) {
      // Manager timed out, switch to second
      failover = {
        from: manager.name,
        to: second.name,
        reason: 'Manager timeout'
      };

      // Log coordination event
      database.createCoordinationEvent(
        room.id,
        'failover',
        manager.id,
        second.id,
        'Manager timeout - automatic switch to second'
      );

      // Broadcast failover event
      broadcast(room.id, {
        type: 'failover',
        from: manager.name,
        to: second.name,
        reason: 'Manager timeout',
        timestamp: now
      });

      logger.info('Coordination failover', {
        roomId: room.id,
        from: manager.name,
        to: second.name,
        reason: 'timeout'
      });
    }
  }

  // Broadcast heartbeat to all clients
  broadcast(room.id, {
    type: 'heartbeat',
    from: member.name,
    role: member.coordination_role || member.role,
    timestamp: now
  });

  res.json({
    acknowledged: true,
    role: member.coordination_role || member.role,
    timeout_in: COORDINATION_TIMEOUT,
    heartbeat_interval: HEARTBEAT_INTERVAL,
    failover: failover
  });
});

/**
 * POST /api/rooms/:token/coordination/switch
 * Manually switch active agent (admin only)
 */
router.post('/rooms/:token/coordination/switch', (req, res) => {
  const { admin_token, to_member_id } = req.body;

  const room = database.getRoomByToken(req.params.token);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  // Verify admin token
  if (!admin_token || admin_token !== room.admin_token) {
    return res.status(403).json({ error: 'Admin authorization required' });
  }

  const coordMembers = database.getCoordinationMembers(room.id);
  const currentActive = coordMembers.find(m => m.coordination_role === 'manager');
  const newActive = coordMembers.find(m => m.id === to_member_id);

  if (!newActive) {
    return res.status(400).json({ error: 'Target member not found or not a coordination member' });
  }

  // Swap roles if both exist
  if (currentActive && newActive && currentActive.id !== newActive.id) {
    database.updateMemberCoordinationRole(currentActive.id, 'second');
    database.updateMemberCoordinationRole(newActive.id, 'manager');

    // Log event
    database.createCoordinationEvent(
      room.id,
      'manual_switch',
      currentActive.id,
      newActive.id,
      'Manual switch by administrator'
    );

    // Broadcast switch
    broadcast(room.id, {
      type: 'failover',
      from: currentActive.name,
      to: newActive.name,
      reason: 'Manual switch',
      timestamp: Date.now()
    });

    logger.info('Manual coordination switch', {
      roomId: room.id,
      from: currentActive.name,
      to: newActive.name
    });

    res.json({
      success: true,
      active: newActive.name,
      previous: currentActive.name
    });
  } else {
    res.status(400).json({ error: 'Invalid switch operation' });
  }
});

/**
 * GET /api/rooms/:token/coordination/status
 * Get current coordination state
 */
router.get('/rooms/:token/coordination/status', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const coordMembers = database.getCoordinationMembers(room.id);
  const manager = coordMembers.find(m => m.coordination_role === 'manager');
  const second = coordMembers.find(m => m.coordination_role === 'second');

  const now = Date.now();

  res.json({
    mode: 'manager-second',
    active: manager ? manager.name : null,
    manager: manager ? {
      name: manager.name,
      last_heartbeat: manager.last_heartbeat,
      health: manager.last_heartbeat && (now - manager.last_heartbeat < COORDINATION_TIMEOUT) ? 'ok' : 'timeout'
    } : null,
    second: second ? {
      name: second.name,
      last_heartbeat: second.last_heartbeat,
      health: second.last_heartbeat && (now - second.last_heartbeat < COORDINATION_TIMEOUT) ? 'ok' : 'timeout'
    } : null,
    timeout: COORDINATION_TIMEOUT,
    heartbeat_interval: HEARTBEAT_INTERVAL,
    secure_mode: room.settings?.secure_mode || false
  });
});

/**
 * GET /api/rooms/:token/coordination/events
 * Get coordination event history
 */
router.get('/rooms/:token/coordination/events', (req, res) => {
  const member = requireMember(req, res);
  if (!member) return;

  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const limit = parseInt(req.query.limit) || 50;
  const events = database.getCoordinationEvents(room.id, limit);

  res.json({ events });
});

/**
 * POST /api/rooms/:token/coordination/set-role
 * Set coordination role for a member (admin only)
 */
router.post('/rooms/:token/coordination/set-role', (req, res) => {
  const { admin_token, member_id, coordination_role } = req.body;

  const room = database.getRoomByToken(req.params.token);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  // Verify admin token
  if (!admin_token || admin_token !== room.admin_token) {
    return res.status(403).json({ error: 'Admin authorization required' });
  }

  // Validate coordination role
  if (coordination_role && !['manager', 'second'].includes(coordination_role)) {
    return res.status(400).json({ error: 'Invalid coordination role. Must be "manager" or "second"' });
  }

  // Update coordination role
  database.updateMemberCoordinationRole(member_id, coordination_role);

  // Broadcast status update
  broadcast(room.id, {
    type: 'coordination_status',
    timestamp: Date.now()
  });

  logger.info('Coordination role set', {
    roomId: room.id,
    memberId: member_id,
    role: coordination_role
  });

  res.json({ success: true, member_id, coordination_role });
});

export default router;
