import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import { database, attachmentInfo } from '../db.js';
import { config } from '../config.js';
import { generateToken } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Shared files (images, sounds, documents) attached to messages
// ---------------------------------------------------------------------------
// Upload first (REST raw body or MCP base64) -> pending attachment, then post a message with
// attachments: [id, ...]. Downloads go through an unguessable token URL (/files/<token>/<name>),
// like room URLs, so <img>/<audio> tags and agents without headers can fetch them.

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  pdf: 'application/pdf', zip: 'application/zip', json: 'application/json',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain',
  html: 'text/html', htm: 'text/html', xml: 'application/xml',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', py: 'text/x-python',
  sh: 'text/x-shellscript', yaml: 'text/yaml', yml: 'text/yaml'
};

// Types rendered inline by browsers without running scripts on the hub origin.
// Everything else (html, svg, xml, js...) is served as a download.
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf|text\/plain)$/;

/** Clean a user-supplied filename: no path, no control characters, bounded length. */
export function sanitizeFilename(name) {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let base = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  if (!base || base === '.' || base === '..') return null;
  if (base.length > 200) {
    const ext = path.extname(base).slice(0, 20);
    base = base.slice(0, 200 - ext.length) + ext;
  }
  return base;
}

/** Declared MIME type if well-formed, else guessed from the extension. */
export function resolveMimeType(declared, filename) {
  const clean = typeof declared === 'string' ? declared.split(';')[0].trim().toLowerCase() : '';
  if (/^[a-z]+\/[\w.+-]+$/.test(clean) && clean !== 'application/octet-stream') return clean;
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

export function isInlineSafe(mimeType) {
  return INLINE_SAFE.test(mimeType);
}

function roomDir(roomId) {
  return path.join(config.uploadsDir, String(roomId));
}

export function attachmentPath(att) {
  return path.join(roomDir(att.room_id), att.token);
}

/**
 * Store an uploaded file for a member (pending until attached to a message).
 * @returns {{ok: true, attachment: object} | {ok: false, status: number, error: string}}
 */
export function storeFile(member, { filename, mimeType, data }) {
  const fail = (status, error) => ({ ok: false, status, error });

  if (!member.permissions.includes('w')) return fail(403, 'Write permission required');
  const name = sanitizeFilename(filename);
  if (!name) return fail(400, 'filename is required');
  if (!Buffer.isBuffer(data) || data.length === 0) return fail(400, 'File is empty');
  if (data.length > config.maxFileSize) {
    return fail(413, `File too large (max ${Math.round(config.maxFileSize / 1024 / 1024)}MB)`);
  }
  if (database.getRoomStorageUsed(member.room_id) + data.length > config.maxRoomStorage) {
    return fail(413, 'Room storage quota exceeded');
  }

  const mime = resolveMimeType(mimeType, name);
  const token = generateToken(config.tokenLength);
  const dir = roomDir(member.room_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, token), data);

  const id = database.createAttachment(member.room_id, member.id, token, name, mime, data.length);
  logger.info('File uploaded', { roomId: member.room_id, attachmentId: id, size: data.length, mime });
  return { ok: true, attachment: attachmentInfo(database.getAttachmentById(id)) };
}

/**
 * Check that ids name pending files uploaded by this member in its room.
 * @returns {{ok: true, ids: number[]} | {ok: false, status: number, error: string}}
 */
export function validateAttachmentIds(member, attachments) {
  if (attachments === undefined || attachments === null) return { ok: true, ids: [] };
  if (!Array.isArray(attachments)) return { ok: false, status: 400, error: 'attachments must be an array of file ids' };
  if (attachments.length > config.maxAttachmentsPerMessage) {
    return { ok: false, status: 400, error: `Too many attachments (max ${config.maxAttachmentsPerMessage})` };
  }
  const ids = [...new Set(attachments.map(Number))];
  for (const id of ids) {
    const att = Number.isInteger(id) ? database.getAttachmentById(id) : null;
    if (!att || att.room_id !== member.room_id || att.member_id !== member.id) {
      return { ok: false, status: 400, error: `attachment ${id} not found (upload it first)` };
    }
    if (att.message_id !== null) {
      return { ok: false, status: 400, error: `attachment ${id} is already attached to a message` };
    }
  }
  return { ok: true, ids };
}

/** Delete uploads that were never attached to a message (frees disk and room quota). */
export function sweepPendingFiles(maxAgeMs = config.pendingFileTtlMs) {
  const stale = database.getStalePendingAttachments(maxAgeMs);
  for (const att of stale) {
    try {
      rmSync(attachmentPath(att), { force: true });
      database.deleteAttachment(att.id);
    } catch (err) {
      logger.warn('Failed to delete pending file', { attachmentId: att.id, error: err.message });
    }
  }
  if (stale.length) logger.info('Pending files swept', { count: stale.length });
  return stale.length;
}

let sweepTimer = null;
export function startFileSweeper(intervalMs = 3600 * 1000) {
  sweepPendingFiles();
  sweepTimer = setInterval(sweepPendingFiles, intervalMs);
  sweepTimer.unref();
}

export function stopFileSweeper() {
  clearInterval(sweepTimer);
  sweepTimer = null;
}

/** Remove a room's files from disk (rows go with ON DELETE CASCADE). */
export function deleteRoomFiles(roomId) {
  const dir = roomDir(roomId);
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('Failed to delete room files', { roomId, error: err.message });
  }
}
