import { Router } from 'express';
import { database } from '../db.js';
import { logger } from '../utils/logger.js';
import { broadcast } from '../ws/handler.js';
import { requireRoomMember, requireRoomAdmin, clampInt } from '../utils/auth.js';

const router = Router();

// Coordination timeout in milliseconds (15 seconds)
const COORDINATION_TIMEOUT = 15000;
const HEARTBEAT_INTERVAL = 5000;
const COORDINATION_ROLES = ['manager', 'second'];

/** A member of this room by id, or null (never a member of another room). */
function roomMemberById(room, id) {
  const memberId = Number(id);
  if (!Number.isInteger(memberId)) return null;
  return database.getMembersByRoom(room.id).find(m => m.id === memberId) || null;
}

/**
 * POST /api/rooms/:token/coordination/heartbeat
 * Send heartbeat from manager/second agent
 */
router.post('/rooms/:token/coordination/heartbeat', (req, res) => {
  const ctx = requireRoomMember(req, res);
  if (!ctx) return;
  const { member, room } = ctx;

  // Update heartbeat timestamp
  const now = Date.now();
  database.updateMemberHeartbeat(member.id, now);

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
  const room = requireRoomAdmin(req, res);
  if (!room) return;
  const { to_member_id } = req.body || {};

  const coordMembers = database.getCoordinationMembers(room.id);
  const currentActive = coordMembers.find(m => m.coordination_role === 'manager');
  const newActive = coordMembers.find(m => m.id === Number(to_member_id));

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
  const ctx = requireRoomMember(req, res, { touch: false });
  if (!ctx) return;
  const { room } = ctx;

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
  const ctx = requireRoomMember(req, res, { touch: false });
  if (!ctx) return;

  const limit = clampInt(req.query.limit, 50, 1, 200);
  const events = database.getCoordinationEvents(ctx.room.id, limit);

  res.json({ events });
});

/**
 * POST /api/rooms/:token/coordination/set-role
 * Set coordination role for a member of this room (admin only); null/absent clears it
 */
router.post('/rooms/:token/coordination/set-role', (req, res) => {
  const room = requireRoomAdmin(req, res);
  if (!room) return;
  const { member_id, coordination_role } = req.body || {};

  // Validate coordination role
  const role = coordination_role === undefined || coordination_role === null || coordination_role === '' ? null : coordination_role;
  if (role !== null && !COORDINATION_ROLES.includes(role)) {
    return res.status(400).json({ error: `Invalid coordination role. Must be ${COORDINATION_ROLES.map(r => `"${r}"`).join(' or ')}` });
  }

  // The target must be a member of THIS room (an admin token only rules its own room)
  const target = roomMemberById(room, member_id);
  if (!target) {
    return res.status(404).json({ error: 'Member not found in this room' });
  }

  database.updateMemberCoordinationRole(target.id, role);

  // Broadcast status update
  broadcast(room.id, {
    type: 'coordination_status',
    timestamp: Date.now()
  });

  logger.info('Coordination role set', {
    roomId: room.id,
    memberId: target.id,
    role
  });

  res.json({ success: true, member_id: target.id, coordination_role: role });
});

export default router;
