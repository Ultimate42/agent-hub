import express, { Router } from 'express';
import { createReadStream, existsSync } from 'fs';
import { database } from '../db.js';
import { config } from '../config.js';
import { storeFile, attachmentPath, isInlineSafe } from '../services/files.js';
import { claimTranscription, completeTranscription, transcriptionEnabled } from '../services/transcription.js';
import { compareTokens } from '../utils/tokens.js';

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

// ---------------------------------------------------------------------------
// Transcription worker API (Bearer HUB_TRANSCRIBE_TOKEN); 404 when transcription is disabled
// ---------------------------------------------------------------------------
function requireWorker(req, res) {
  if (!transcriptionEnabled()) {
    res.status(404).json({ error: 'Transcription is not enabled (set HUB_TRANSCRIBE_TOKEN)' });
    return false;
  }
  const auth = req.get('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !compareTokens(token, config.transcribeToken)) {
    res.status(403).json({ error: 'Invalid transcription worker token' });
    return false;
  }
  return true;
}

/**
 * GET /api/transcriptions/next?wait=25 - Claim the next audio file to transcribe.
 * 200 {id, url, filename, mime_type, size, attempt} or 204 when the queue stays empty for `wait` seconds.
 */
router.get('/api/transcriptions/next', (req, res) => {
  if (!requireWorker(req, res)) return;
  const waitMs = Math.min(Math.max(parseInt(req.query.wait, 10) || 0, 0), 25) * 1000;
  const deadline = Date.now() + waitMs;
  let closed = false;
  req.on('close', () => { closed = true; });

  const attempt = () => {
    if (closed) return;
    const job = claimTranscription();
    if (job) return res.json(job);
    if (Date.now() >= deadline) return res.status(204).end();
    setTimeout(attempt, 1000);
  };
  attempt();
});

/**
 * POST /api/transcriptions/:id {text} | {error} - Result for a claimed job
 */
router.post('/api/transcriptions/:id', express.json({ limit: '128kb' }), (req, res) => {
  if (!requireWorker(req, res)) return;
  const result = completeTranscription(parseInt(req.params.id, 10), req.body || {});
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ success: true, ...(result.message_id ? { message_id: result.message_id } : {}) });
});

export default router;
