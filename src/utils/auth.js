import { database } from '../db.js';
import { compareTokens } from './tokens.js';

// ---------------------------------------------------------------------------
// Request authentication shared by every REST router (api, files, coordination, wake targets).
// One implementation: a member token is looked up once, the room in the URL must be the member's
// room, and admin tokens are compared in constant time.
// ---------------------------------------------------------------------------

/** Bearer token from the Authorization header, or ?token= (legacy; headers are preferred). */
export function getToken(req) {
  const auth = req.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return typeof req.query.token === 'string' ? req.query.token : undefined;
}

/**
 * Resolve the calling member from its token (401/403 sent otherwise) and mark it seen.
 * @returns member row or null
 */
export function requireMember(req, res, { touch = true } = {}) {
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
  if (touch) database.updateMemberLastSeen(member.id);
  return member;
}

/**
 * Member + the room named by req.params.token; 403 when the member belongs to another room.
 * @returns {{member, room}|null}
 */
export function requireRoomMember(req, res, opts) {
  const member = requireMember(req, res, opts);
  if (!member) return null;
  const room = database.getRoomByToken(req.params.token);
  if (!room || room.id !== member.room_id) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return { member, room };
}

/**
 * Room named by req.params.token, authenticated with its admin token (header, ?token= or
 * body.admin_token). Sends 401/404/403 itself.
 * @returns room or null
 */
export function requireRoomAdmin(req, res) {
  const adminToken = getToken(req) || (typeof req.body?.admin_token === 'string' ? req.body.admin_token : undefined);
  if (!adminToken) {
    res.status(401).json({ error: 'Admin token required' });
    return null;
  }
  const room = database.getRoomByToken(req.params.token);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return null;
  }
  if (!compareTokens(adminToken, room.admin_token)) {
    res.status(403).json({ error: 'Invalid admin token' });
    return null;
  }
  return room;
}

/**
 * Integer query/body parameter clamped to [min, max]; dflt when absent or not a number.
 * Prevents negative or NaN values from reaching SQL LIMIT (where -1 means "no limit").
 */
export function clampInt(value, dflt, min, max) {
  const n = Math.floor(Number(value));
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}
