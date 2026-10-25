import crypto from 'crypto';
import { database } from '../db.js';
import { config } from '../config.js';
import { generateToken, compareTokens } from '../utils/tokens.js';

// ---------------------------------------------------------------------------
// App (PWA) sessions
// ---------------------------------------------------------------------------
// The browser never stores member tokens: it holds one HttpOnly cookie (random session token).
// The DB keeps sha256(session token) and, per thread, sha256(member token) at the time it was added.
// A thread is valid only while the member's current token still matches: rotating a member token
// (rejoin, scripts/rotate-token.mjs) revokes it in every app session.

export const APP_COOKIE = 'hub_app';
export const APP_SESSION_MAX_AGE_S = 90 * 24 * 3600; // 90 days, sliding
export const MAX_THREADS_PER_SESSION = 20;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const db = database.db;
const stmts = {
  createSession: db.prepare('INSERT INTO app_sessions (token_hash) VALUES (?)'),
  getSession: db.prepare(`SELECT id FROM app_sessions WHERE token_hash = ?
    AND last_seen > datetime('now', ?)`),
  touchSession: db.prepare('UPDATE app_sessions SET last_seen = CURRENT_TIMESTAMP WHERE id = ?'),
  deleteSession: db.prepare('DELETE FROM app_sessions WHERE id = ?'),
  purgeExpired: db.prepare(`DELETE FROM app_sessions WHERE last_seen <= datetime('now', ?)`),
  addThread: db.prepare(`INSERT OR REPLACE INTO app_session_threads (session_id, member_id, member_token_hash)
    VALUES (?, ?, ?)`),
  countThreads: db.prepare('SELECT COUNT(*) AS n FROM app_session_threads WHERE session_id = ?'),
  getThreads: db.prepare(`
    SELECT t.member_token_hash, m.*, r.name AS room_name
    FROM app_session_threads t
    JOIN members m ON m.id = t.member_id
    JOIN rooms r ON r.id = m.room_id
    WHERE t.session_id = ?
    ORDER BY t.added_at, m.id`),
  removeThread: db.prepare('DELETE FROM app_session_threads WHERE session_id = ? AND member_id = ?')
};

const maxAgeModifier = `-${APP_SESSION_MAX_AGE_S} seconds`;

/** Create a session. Returns the raw token (to put in the cookie) and the session id. */
export function createAppSession() {
  stmts.purgeExpired.run(maxAgeModifier);
  const token = generateToken(config.adminTokenLength);
  const id = Number(stmts.createSession.run(sha256(token)).lastInsertRowid);
  return { token, id };
}

/** Resolve a raw session token to a session id (sliding expiry), or null. */
export function getAppSession(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  const row = stmts.getSession.get(sha256(token), maxAgeModifier);
  if (!row) return null;
  stmts.touchSession.run(row.id);
  return row.id;
}

export function deleteAppSession(sessionId) {
  stmts.deleteSession.run(sessionId);
}

/**
 * Add the thread of a member token to a session.
 * @returns {{ok: true, member: object} | {ok: false, status: number, error: string}}
 */
export function addThread(sessionId, memberToken) {
  if (typeof memberToken !== 'string' || !memberToken || memberToken.length > 128) {
    return { ok: false, status: 400, error: 'member_token is required' };
  }
  const member = database.getMemberByToken(memberToken.trim());
  if (!member) return { ok: false, status: 403, error: 'Invalid token' };
  if (member.role !== 'human') return { ok: false, status: 403, error: 'Only human members can use the app' };

  const already = getThreads(sessionId).some(t => t.id === member.id);
  if (!already && stmts.countThreads.get(sessionId).n >= MAX_THREADS_PER_SESSION) {
    return { ok: false, status: 429, error: `Too many threads (max ${MAX_THREADS_PER_SESSION})` };
  }
  stmts.addThread.run(sessionId, member.id, sha256(member.token));
  return { ok: true, member };
}

/** Members of the session's threads whose token was not rotated since they were added. */
export function getThreads(sessionId) {
  return stmts.getThreads.all(sessionId)
    .filter(t => compareTokens(t.member_token_hash, sha256(t.token)))
    .map(({ member_token_hash, ...member }) => member);
}

/** The member behind one thread of the session, or null. */
export function getThread(sessionId, memberId) {
  const id = Number(memberId);
  if (!Number.isInteger(id)) return null;
  return getThreads(sessionId).find(t => t.id === id) || null;
}

export function removeThread(sessionId, memberId) {
  return stmts.removeThread.run(sessionId, Number(memberId)).changes > 0;
}

/** Read one cookie from a raw Cookie header (no dependency). */
export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/** Same-origin check for cookie-authenticated requests (CSRF / cross-site WebSocket hijacking). */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client or same-origin GET without Origin
  const allowed = new Set([config.publicUrl.replace(/\/$/, ''), ...config.corsOrigins]);
  const host = req.headers.host;
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  return allowed.has(origin);
}
