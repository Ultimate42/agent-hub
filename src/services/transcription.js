import { database, attachmentInfo } from '../db.js';
import { config } from '../config.js';
import { generateToken, compareTokens } from '../utils/tokens.js';
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
  return Boolean(config.transcribeToken) || config.transcribeWorkerTokens.length > 0 || config.transcribeWorkerMembers.length > 0;
}

// ---------------------------------------------------------------------------
// Workers: identity (one token each), last poll, shadow cursors
// ---------------------------------------------------------------------------
const workers = new Map(); // name -> { lastPollAt, lastClaimAt, shadow, done, failed }
const shadowCursors = new Map(); // worker -> highest attachment id already offered
const WORKER_NAME = /^[\w.-]{1,32}$/;

/**
 * Who is calling? A per-worker token fixes the name; the legacy shared token takes the name the worker
 * announces (worker=nom or X-Worker header, default "default"). Returns {name} or null (bad token).
 */
export function identifyWorker(token, announced) {
  if (!token) return null;
  for (const w of config.transcribeWorkerTokens) {
    if (compareTokens(token, w.token)) return { name: w.name };
  }
  if (config.transcribeToken && compareTokens(token, config.transcribeToken)) {
    return { name: WORKER_NAME.test(announced || '') ? announced : 'default' };
  }
  // A room member token whose member name is listed in HUB_TRANSCRIBE_WORKER_MEMBERS: worker name imposed
  if (config.transcribeWorkerMembers.length > 0) {
    const member = database.getMemberByToken(token);
    const entry = member && config.transcribeWorkerMembers.find(w => w.member === member.name && w.roomId === Number(member.room_id));
    if (entry) return { name: entry.name };
  }
  return null;
}

function workerEntry(name) {
  let w = workers.get(name);
  if (!w) {
    w = { lastPollAt: 0, lastClaimAt: 0, shadow: false, done: 0, failed: 0 };
    workers.set(name, w);
  }
  return w;
}

export function noteWorkerPoll(name, { shadow = false } = {}) {
  const w = workerEntry(name);
  w.lastPollAt = Date.now();
  w.shadow = shadow;
}

/** Last poll per worker, plus recent permanent failures (their error is kept on the attachment). */
export function transcriptionWorkers(now = Date.now()) {
  return {
    workers: [...workers.entries()].map(([name, w]) => ({
      name,
      last_poll_at: w.lastPollAt ? new Date(w.lastPollAt).toISOString() : null,
      age_s: w.lastPollAt ? Math.round((now - w.lastPollAt) / 1000) : null,
      shadow: w.shadow,
      done: w.done,
      failed: w.failed
    })),
    failed_jobs: database.recentFailedTranscriptions(20)
  };
}

/** Shadow mode: a finished note this worker has not re-transcribed yet (only notes finished after it started). */
export function claimShadow(worker) {
  if (!shadowCursors.has(worker)) shadowCursors.set(worker, database.maxDoneTranscriptionId());
  const att = database.nextShadowCandidate(worker, shadowCursors.get(worker));
  if (!att) return null;
  shadowCursors.set(worker, att.id);
  const info = attachmentInfo(att);
  return { id: att.id, filename: att.filename, mime_type: att.mime_type, size: att.size, url: info.url, attempt: 1, shadow: true };
}

/** Shadow result: stored apart for comparison, never posted, the real transcript is untouched. */
export function completeShadow(attachmentId, worker, { text } = {}) {
  const att = database.getAttachmentById(attachmentId);
  if (!att || att.transcript_status !== 'done') return { ok: false, status: 404, error: 'Unknown shadow job' };
  if (typeof text !== 'string') return { ok: true };
  database.saveShadow(att.id, worker, text.trim().slice(0, config.maxMessageSize));
  return { ok: true };
}

/**
 * Queue the audio files of a freshly posted message. Only audio posted by a human (voice notes recorded
 * in the UI) is transcribed: audio files sent by agents/bots are never transcribed automatically.
 */
export function queueTranscriptions(attachmentIds, author = null) {
  if (!transcriptionEnabled()) return;
  if (!author || author.role !== 'human') return;
  for (const id of attachmentIds) database.queueTranscription(id);
}

/** Next job for the worker, or null. */
export function claimTranscription({ worker = null, minAgeMs = 0 } = {}) {
  const att = database.claimNextTranscription(config.transcribeLeaseMs, config.transcribeMaxAttempts, { worker, minAgeMs });
  if (!att) return null;
  if (worker) workerEntry(worker).lastClaimAt = Date.now();
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
export function completeTranscription(attachmentId, { text, error } = {}, worker = null) {
  const att = database.getAttachmentById(attachmentId);
  if (!att) return { ok: false, status: 404, error: 'Unknown transcription job' };
  if (att.transcript_status !== 'claimed') {
    return { ok: false, status: 409, error: `Job is ${att.transcript_status || 'not queued'}` };
  }

  if (typeof error === 'string' || typeof text !== 'string') {
    const retry = (att.transcript_attempts || 0) < config.transcribeMaxAttempts;
    const reason = String(error || 'no text');
    database.setTranscriptionStatus(att.id, retry ? 'pending' : 'failed');
    database.setTranscriptionError(att.id, `${worker || att.transcript_worker || '?'}: ${reason}`);
    if (worker) workerEntry(worker).failed++;
    if (retry) logger.warn('Transcription failed', { attachmentId: att.id, worker, error: reason, retry });
    else logger.error('Transcription failed permanently', { attachmentId: att.id, worker, attempts: att.transcript_attempts, error: reason });
    return { ok: true };
  }

  const transcript = text.trim().slice(0, config.maxMessageSize - 200);
  database.setTranscriptionStatus(att.id, 'done', transcript);
  database.setTranscriptionError(att.id, null);
  if (worker) workerEntry(worker).done++;
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
