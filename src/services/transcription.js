import { database, attachmentInfo } from '../db.js';
import { config } from '../config.js';
import { generateToken } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';
import { publishMessage } from './messages.js';

// ---------------------------------------------------------------------------
// Voice transcription, delegated to an external worker (scripts/transcribe-worker.mjs)
// ---------------------------------------------------------------------------
// The hub never runs a speech model: audio attachments are queued, a worker authenticated with
// HUB_TRANSCRIBE_TOKEN claims them (lease), sends them to whatever Whisper service it has, and
// posts the text back. The hub then stores it on the attachment and posts it in the room as a
// reply to the voice message, so agents that cannot hear audio read it like any other message.

export const TRANSCRIBER_NAME = 'Transcription';

export function transcriptionEnabled() {
  return Boolean(config.transcribeToken);
}

/** Queue the audio files of a freshly posted message. */
export function queueTranscriptions(attachmentIds) {
  if (!transcriptionEnabled()) return;
  for (const id of attachmentIds) database.queueTranscription(id);
}

/** Next job for the worker, or null. */
export function claimTranscription() {
  const att = database.claimNextTranscription(config.transcribeLeaseMs, config.transcribeMaxAttempts);
  if (!att) return null;
  const info = attachmentInfo(att);
  return {
    id: att.id,
    filename: att.filename,
    mime_type: att.mime_type,
    size: att.size,
    url: info.url,
    attempt: att.transcript_attempts
  };
}

function getOrCreateTranscriber(roomId) {
  const existing = database.getMemberByNameAndRoom(roomId, TRANSCRIBER_NAME);
  if (existing) return existing.id;
  // Never authenticates: random token nobody receives, read-only
  return Number(database.createMember(roomId, generateToken(32), TRANSCRIBER_NAME, 'observer', 'r'));
}

/**
 * Worker result for a claimed job.
 * @returns {{ok: true, message_id?: number} | {ok: false, status: number, error: string}}
 */
export function completeTranscription(attachmentId, { text, error } = {}) {
  const att = database.getAttachmentById(attachmentId);
  if (!att) return { ok: false, status: 404, error: 'Unknown transcription job' };
  if (att.transcript_status !== 'claimed') {
    return { ok: false, status: 409, error: `Job is ${att.transcript_status || 'not queued'}` };
  }

  if (typeof error === 'string' || typeof text !== 'string') {
    const retry = (att.transcript_attempts || 0) < config.transcribeMaxAttempts;
    database.setTranscriptionStatus(att.id, retry ? 'pending' : 'failed');
    logger.warn('Transcription failed', { attachmentId: att.id, error: String(error || 'no text'), retry });
    return { ok: true };
  }

  const transcript = text.trim().slice(0, config.maxMessageSize - 200);
  database.setTranscriptionStatus(att.id, 'done', transcript);
  if (!transcript || !att.message_id || !database.getRoomById(att.room_id)) return { ok: true };

  const content = `🎙️ ${att.filename}: ${transcript}`;
  const memberId = getOrCreateTranscriber(att.room_id);
  const messageId = Number(database.createMessage(att.room_id, memberId, 'message', content, att.message_id));
  publishMessage(att.room_id, {
    id: messageId,
    type: 'message',
    content,
    author: TRANSCRIBER_NAME,
    author_role: 'observer',
    reply_to: att.message_id,
    created_at: new Date().toISOString()
  });
  logger.info('Transcription posted', { roomId: att.room_id, attachmentId: att.id, messageId });
  return { ok: true, message_id: messageId };
}
