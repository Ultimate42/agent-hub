import express, { Router } from 'express';
import { createReadStream, existsSync } from 'fs';
import { database } from '../db.js';
import { config } from '../config.js';
import { storeFile, attachmentPath, isInlineSafe } from '../services/files.js';

const router = Router();

function getToken(req) {
  const auth = req.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return req.query.token;
}

/**
 * POST /api/rooms/:token/files?filename=photo.png - Upload a file (raw body, any Content-Type)
 * Returns { id, filename, mime_type, size, url }. Then post a message with attachments: [id].
 */
router.post('/api/rooms/:token/files',
  express.raw({ type: () => true, limit: config.maxFileSize }),
  (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Authorization required' });
    const member = database.getMemberByToken(token);
    if (!member) return res.status(403).json({ error: 'Invalid token' });
    const room = database.getRoomByToken(req.params.token);
    if (!room || room.id !== member.room_id) return res.status(403).json({ error: 'Access denied' });
    database.updateMemberLastSeen(member.id);

    let filename = req.query.filename || req.get('X-Filename');
    try { filename = filename && decodeURIComponent(filename); } catch { /* keep raw */ }
    const result = storeFile(member, {
      filename,
      mimeType: req.get('Content-Type'),
      data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.attachment);
  });

/**
 * GET /files/:fileToken/:name - Download a shared file (the token is the capability, like room URLs)
 */
router.get(['/files/:fileToken', '/files/:fileToken/:name'], (req, res) => {
  const att = database.getAttachmentByToken(req.params.fileToken);
  const file = att && attachmentPath(att);
  if (!att || !existsSync(file)) return res.status(404).json({ error: 'File not found' });

  const inline = isInlineSafe(att.mime_type) && req.query.download === undefined;
  res.set({
    'Content-Type': inline ? att.mime_type : 'application/octet-stream',
    'Content-Length': String(att.size),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=86400'
  });
  createReadStream(file).pipe(res);
});

export default router;
