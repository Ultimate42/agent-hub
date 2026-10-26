import { database } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { parseDbTime } from '../utils/time.js';
import { publishMessage } from './messages.js';
import { deleteRoomFiles } from './files.js';
import { getOrCreateWatchdogMember } from '../watchdog.js';

// ---------------------------------------------------------------------------
// Room retention: a room with no message for retention_days is deleted (with its files).
// settings.retention_days: number of days, 0 = never, absent = config.retentionDefaultDays.
// A warning is posted in the room retentionWarnMs before deletion; any new message resets it.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;

/** Effective retention of a room in days (0 = never). */
export function roomRetentionDays(settings = {}) {
  const v = settings.retention_days;
  return typeof v === 'number' && v >= 0 ? v : config.retentionDefaultDays;
}

/** Validate a retention value from an agent: number of days (> 0), or 0 / "never". */
export function parseRetention(value) {
  if (value === 'never' || value === 0 || value === '0') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 3650) return null;
  return n;
}

/** Set a room's retention (member with write permission). Clears a pending warning. */
export function setRoomRetention(member, value) {
  if (!member.permissions.includes('w')) return { ok: false, status: 403, error: 'Write permission required' };
  const days = parseRetention(value);
  if (days === null) return { ok: false, status: 400, error: 'retention_days must be a number of days (1-3650), or 0 / "never"' };
  const room = database.getRoomById(member.room_id);
  const { retention_warned_at, ...settings } = room.settings;
  database.updateRoomSettings(room.id, { ...settings, retention_days: days });
  logger.info('Room retention set', { roomId: room.id, days, by: member.name });
  return { ok: true, retention_days: days };
}

function describe(days) {
  return days === 0 ? 'never' : `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * One pass: warn rooms close to expiry, delete expired ones.
 * @returns {{warned: number[], deleted: number[]}}
 */
export function runRetention(now = Date.now()) {
  const warned = [];
  const deleted = [];
  for (const room of database.listRoomsForRetention()) {
    const days = roomRetentionDays(room.settings);
    if (!days) continue;
    const last = parseDbTime(room.last_activity || room.created_at);
    if (Number.isNaN(last)) continue;
    const expiresAt = last + days * DAY_MS;

    if (now >= expiresAt) {
      // Only delete after the warning was posted (a pass may have been missed while the hub was down)
      const warnedAt = room.settings.retention_warned_at;
      if (warnedAt && warnedAt > last && now >= warnedAt + Math.min(config.retentionWarnMs, days * DAY_MS / 2)) {
        database.deleteRoom(room.id);
        deleteRoomFiles(room.id);
        deleted.push(room.id);
        logger.info('Room deleted for inactivity', { roomId: room.id, days });
        continue;
      }
    }

    const warnAt = expiresAt - Math.min(config.retentionWarnMs, days * DAY_MS / 2);
    const alreadyWarned = room.settings.retention_warned_at && room.settings.retention_warned_at > last;
    if (now >= warnAt && !alreadyWarned) {
      const when = new Date(Math.max(expiresAt, now + Math.min(config.retentionWarnMs, days * DAY_MS / 2)));
      const content = `⚠️ This room will be deleted on ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC ` +
        `after ${describe(days)} without messages. Post a message to keep it, or change it with ` +
        `set_retention (e.g. retention_days: 30, or "never"). / Ce salon sera supprimé faute d'activité : ` +
        `postez un message ou changez le délai avec set_retention.`;
      const memberId = getOrCreateWatchdogMember(room.id);
      const id = Number(database.createMessage(room.id, memberId, 'message', content, null));
      database.updateRoomSettings(room.id, { ...room.settings, retention_warned_at: now });
      publishMessage(room.id, {
        id, type: 'message', content, author: 'HubWatchdog', author_role: 'observer', created_at: new Date(now).toISOString()
      });
      warned.push(room.id);
    }
  }
  return { warned, deleted };
}

let timer = null;
export function startRetentionSweeper(intervalMs = 3600 * 1000) {
  const tick = () => {
    try { runRetention(); } catch (err) { logger.error('Retention pass failed', { error: err.message }); }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}

export function stopRetentionSweeper() {
  clearInterval(timer);
  timer = null;
}
