#!/usr/bin/env node
/**
 * Archiviste Agent - Resident memory manager for health, sport and nutrition data
 * Joins a room, monitors for commands, and interfaces with memory-agent API
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const ROOM_TOKEN = process.env.ROOM_TOKEN;
const LLM_MODEL = process.env.ARCHIVISTE_MODEL || 'claude-sonnet-5-5';
// Runtime state (member token, pid) lives outside the repo: ARCHIVISTE_STATE_DIR (default: this directory)
const STATE_DIR = process.env.ARCHIVISTE_STATE_DIR || __dirname;
const AGENT_HUB_URL = process.env.AGENT_HUB_URL || 'http://localhost:4030';
const MEMORY_API_URL = process.env.MEMORY_API_URL || 'http://localhost:4010';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const AGENT_NAME = 'Archiviste';
const AGENT_ROLE = 'agent';

// Global state
let state = {
  memberToken: null,
  joinedAt: null,
  lastProcessedMessageId: null,
  welcomedAt: null,
  doneIds: [],     // ids > lastProcessedMessageId already fully handled (out-of-order completion)
  writtenIds: [],  // recent ids whose retiens: was written to memory (idempotence after a crash)
};

const CONCURRENCY = Math.max(1, parseInt(process.env.ARCHIVISTE_CONCURRENCY || '3', 10));
const SHUTDOWN_GRACE_MS = parseInt(process.env.ARCHIVISTE_SHUTDOWN_GRACE_MS || '30000', 10);
const MAX_ATTEMPTS = 3;
let shuttingDown = false;
const attempts = new Map(); // msg id -> failed attempts

const PID_FILE = path.join(STATE_DIR, 'archiviste.pid');
let messagesThisMinute = 0;
let lastMinuteReset = Date.now();

// Track last help response per author to avoid spam
const lastHelpResponsePerAuthor = new Map(); // author -> timestamp

// Backoff configuration
const BACKOFF_CONFIG = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 2,
};

let currentBackoffMs = BACKOFF_CONFIG.initialDelayMs;

/**
 * Load saved state from file
 */
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      state = { ...state, ...JSON.parse(data) };
      console.log('[ARCHIVISTE] State loaded');
    } catch (err) {
      console.warn('[ARCHIVISTE] Failed to load state:', err.message);
    }
  }
}

/**
 * Save state to file with secure permissions
 */
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    fs.chmodSync(STATE_FILE, 0o600);
    console.log('[ARCHIVISTE] State saved');
  } catch (err) {
    console.error('[ARCHIVISTE] Failed to save state:', err.message);
  }
}

/**
 * Fetch with smart retry: 5xx, 429, or network errors only
 */
async function fetchWithRetry(url, options = {}, attempt = 0, timeoutMs = 40000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Don't retry on 4xx except 429
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new Error(`HTTP ${response.status}: not retryable`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    currentBackoffMs = BACKOFF_CONFIG.initialDelayMs; // Reset on success
    return response;
  } catch (err) {
    // No retry for non-network, non-5xx, non-429 errors
    if (attempt === 0 && err.message.includes('not retryable')) {
      throw err;
    }

    if (attempt >= 2) {
      throw new Error(`Failed after ${attempt + 1} attempts: ${err.message}`);
    }

    const nextBackoff = Math.min(
      BACKOFF_CONFIG.initialDelayMs * Math.pow(BACKOFF_CONFIG.multiplier, attempt),
      BACKOFF_CONFIG.maxDelayMs
    );

    console.error(
      `[ARCHIVISTE] Fetch error (attempt ${attempt + 1}): ${err.message}. Retry in ${nextBackoff}ms`
    );

    await sleep(nextBackoff);
    return fetchWithRetry(url, options, attempt + 1, timeoutMs);
  }
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Join the room
 */
async function joinRoom() {
  try {
    console.log(`[ARCHIVISTE] Joining room...`);

    const response = await fetchWithRetry(
      `${AGENT_HUB_URL}/api/rooms/${ROOM_TOKEN}/join`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: AGENT_NAME,
          role: AGENT_ROLE,
        }),
      }
    );

    const data = await response.json();
    state.memberToken = data.member_token;
    state.joinedAt = new Date().toISOString();
    saveState();

    console.log(`[ARCHIVISTE] Successfully joined room`);
    return true;
  } catch (err) {
    console.error(`[ARCHIVISTE] Failed to join room: ${err.message}`);
    throw err;
  }
}

/**
 * Post a message to the room
 */
async function postMessage(content) {
  if (!state.memberToken) {
    console.error('[ARCHIVISTE] No member token');
    return false;
  }

  try {
    const response = await fetchWithRetry(
      `${AGENT_HUB_URL}/api/rooms/${ROOM_TOKEN}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.memberToken}`,
        },
        body: JSON.stringify({
          content: content,
          type: 'message',
        }),
      }
    );

    await response.json();
    console.log(`[ARCHIVISTE] Message posted`);
    return true;
  } catch (err) {
    console.error(`[ARCHIVISTE] Failed to post message: ${err.message}`);
    return false;
  }
}

/**
 * Write to memory via memory-agent API
 */
async function writeMemory(content, path = 'sante-sport-nutrition/notes') {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    const response = await fetch(
      `${MEMORY_API_URL}/write`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content,
          tree: 'coach',
          path: path,
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const data = await response.json();
    // Verify success: check for id field or explicit success indicator
    const isSuccess = data.id || data.success;
    if (!isSuccess) {
      console.error('[ARCHIVISTE] Write memory response missing id/success:', data);
      return false;
    }
    console.log(`[ARCHIVISTE] Memory written: ${data.id || 'success'}`);
    return true;
  } catch (err) {
    console.error(`[ARCHIVISTE] Failed to write memory: ${err.message}`);
    return false;
  }
}

/**
 * Read from memory via memory-agent API
 */
async function readMemory(subject) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    const response = await fetch(
      `${MEMORY_API_URL}/read`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: subject,
          tree: 'coach',
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (err) {
    console.error(`[ARCHIVISTE] Failed to read memory: ${err.message}`);
    return null;
  }
}

/**
 * Initialize lastProcessedMessageId from latest messages
 */
async function initializeLastMessageId() {
  if (state.lastProcessedMessageId !== null) {
    return; // Already initialized
  }

  if (!state.memberToken) {
    console.error('[ARCHIVISTE] Cannot init, no member token');
    return;
  }

  try {
    const response = await fetchWithRetry(
      `${AGENT_HUB_URL}/api/rooms/${ROOM_TOKEN}/messages?limit=1`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${state.memberToken}`,
        },
      }
    );

    const data = await response.json();
    if (data.messages && data.messages.length > 0) {
      state.lastProcessedMessageId = data.messages[0].id;
      saveState();
      console.log(`[ARCHIVISTE] Initialized lastProcessedMessageId: ${state.lastProcessedMessageId}`);
    }
  } catch (err) {
    console.warn(`[ARCHIVISTE] Failed to init message ID: ${err.message}`);
  }
}

/**
 * Poll for new messages
 */
async function pollMessages() {
  if (!state.memberToken) {
    console.error('[ARCHIVISTE] No member token');
    return [];
  }

  try {
    const sinceParam = state.lastProcessedMessageId ? `&since=${state.lastProcessedMessageId}` : '';
    const response = await fetchWithRetry(
      `${AGENT_HUB_URL}/api/rooms/${ROOM_TOKEN}/messages/wait?timeout=30000${sinceParam}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${state.memberToken}`,
        },
      }
    );

    const data = await response.json();
    return data.messages || [];
  } catch (err) {
    console.error(`[ARCHIVISTE] Poll error: ${err.message}`);
    return [];
  }
}

/**
 * Normalize text: trim, lowercase, remove accents from prefix
 */
function normalize(text) {
  return text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Determine if a message should trigger LLM response
 * Returns true if:
 * - Not a recognized command (retiens:/cherche:/résume:/?)
 * - AND (mentions "Archiviste"/@Archiviste OR contains generic agent appeal like "each agent"/"tous les agents")
 * Exported for testing
 */
export function shouldCallLLM(content) {
  const normalized = normalize(content);

  // Check if it's a recognized command - if so, skip LLM
  if (
    normalized.startsWith('retiens:') ||
    normalized.startsWith('ajoute:') ||
    normalized.startsWith('cherche:') ||
    normalized.startsWith('recherche:') ||
    normalized.startsWith('résume:') ||
    normalized.startsWith('resume:')
  ) {
    return false;
  }

  if (content.trim() === '?' || content.trim() === 'aide') {
    return false;
  }

  // Check for Archiviste mention or agent appeal
  const hasMention = /\b(archiviste|@archiviste)\b/i.test(content);
  const hasAgentAppeal = /\b(each agent|tous les agents)\b/i.test(content);

  return hasMention || hasAgentAppeal;
}

/**
 * Call Claude (ARCHIVISTE_MODEL, default Sonnet 5.5) via CLI with timeout
 * Returns the response text or null on error
 */
async function callClaudeLLM(systemPrompt, userMessage) {
  try {
    const fullPrompt = `${systemPrompt}\n\n${userMessage}`;

    // Prompt passed via stdin (no shell: room content is never interpreted)
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', '--model', LLM_MODEL], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', errOut = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Claude call timed out after 90s')); }, 90000);
      child.stdout.on('data', d => { if (out.length < 10 * 1024 * 1024) out += d; });
      child.stderr.on('data', d => { errOut += d; });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        code === 0 ? resolve({ stdout: out, stderr: errOut }) : reject(new Error(`claude exited ${code}: ${errOut}`));
      });
      child.stdin.end(fullPrompt);
    });

    if (stderr && !stderr.includes('warning')) {
      console.warn(`[ARCHIVISTE] Claude stderr: ${stderr.substring(0, 200)}`);
    }

    return stdout.trim();
  } catch (err) {
    console.error(`[ARCHIVISTE] Claude call failed: ${err.message.substring(0, 200)}`);
    return null;
  }
}

/**
 * Check rate limit: max 20 messages per minute
 */
function canPostMessage() {
  const now = Date.now();
  if (now - lastMinuteReset > 60000) {
    messagesThisMinute = 0;
    lastMinuteReset = now;
  }
  if (messagesThisMinute >= 20) {
    console.warn('[ARCHIVISTE] Rate limit: 20 messages/min reached');
    return false;
  }
  messagesThisMinute++;
  return true;
}

/**
 * Process a single message - use author/author_role (not member_name/member_role)
 */
async function processMessage(msg, gate = Promise.resolve()) {
  // gate: resolves when earlier messages have posted their reply (keeps replies in message order).
  // Returns true when handled (reply posted or deliberately none), false when it must be retried.
  let postFailed = false;
  const post = async (text) => { await gate; const ok = await postMessage(text); if (!ok) postFailed = true; return ok; };
  try {
    // Ignore own messages - check author field, not member_name
    if (msg.author === AGENT_NAME) {
      console.log(`[ARCHIVISTE] Ignoring own message (author=${msg.author})`);
      return true;
    }

    // Ignore messages from other bots unless they mention Archiviste
    const author = msg.author || msg.member_name || 'Unknown';
    const messageType = msg.type || 'message';
    if (messageType === 'system') {
      console.log(`[ARCHIVISTE] Ignoring system message`);
      return true;
    }

    const content = msg.content || '';
    console.log(`[ARCHIVISTE] Processing msg_id=${msg.id} author=${author}: ${content.substring(0, 60)}`);

    const normalized = normalize(content);

    // Command: retiens: ... or ajoute: ... (add memory)
    if (normalized.startsWith('retiens:') || normalized.startsWith('ajoute:')) {
      console.log('[ARCHIVISTE] -> Matched: retiens/ajoute');
      const memoryContent = content.substring(content.indexOf(':') + 1).trim();
      let success = state.writtenIds.includes(msg.id);
      if (success) {
        console.log(`[ARCHIVISTE] msg_id=${msg.id} already written to memory, skipping write`);
      } else {
        success = await writeMemory({
          name: 'Note',
          description: memoryContent,
          date: new Date().toISOString(),
        });
        if (success) {
          state.writtenIds = [...state.writtenIds, msg.id].slice(-200);
          saveState();
        }
      }

      if (!success && (attempts.get(msg.id) || 0) + 1 < MAX_ATTEMPTS) return false; // retry later
      if (canPostMessage()) {
        const ok = await post(success ? `✓ Enregistré: "${memoryContent.substring(0, 40)}..."` : '❌ Erreur enregistrement.');
        if (!ok) return false;
      }
    }

    // Command: cherche: ... or recherche: ... (search memory)
    else if (normalized.startsWith('cherche:') || normalized.startsWith('recherche:')) {
      console.log('[ARCHIVISTE] -> Matched: cherche/recherche');
      const query = content.substring(content.indexOf(':') + 1).trim();
      const result = await readMemory(query);

      if (canPostMessage()) {
        if (result && typeof result.result === 'string' && result.result.trim()) {
          await post(`📚 ${result.result.trim().substring(0, 1500)}`);
        } else if (result && result.text) {
          await post(`📚 ${result.text}`);
        } else if (result && result.summary) {
          await post(`📚 ${result.summary}`);
        } else if (result && Object.keys(result).length > 0) {
          // Fallback: stringify the result
          const summary = JSON.stringify(result).substring(0, 100);
          await post(`📚 ${summary}`);
        } else {
          await post('Aucun résultat.');
        }
      }
    }

    // Command: résume: ... or resume: ... (summarize)
    else if (normalized.startsWith('résume:') || normalized.startsWith('resume:')) {
      console.log('[ARCHIVISTE] -> Matched: résume');
      const query = content.substring(content.indexOf(':') + 1).trim();
      const result = await readMemory(query);

      if (canPostMessage()) {
        if (result && typeof result.result === 'string' && result.result.trim()) {
          await post(`📊 ${result.result.trim().substring(0, 1500)}`);
        } else if (result && result.summary) {
          await post(`📊 ${result.summary}`);
        } else if (result && result.text) {
          await post(`📊 ${result.text}`);
        } else {
          await post('Pas de résumé disponible.');
        }
      }
    }

    // Help: exact match "?" or "aide"
    else if (content.trim() === '?' || content.trim() === 'aide') {
      console.log('[ARCHIVISTE] -> Matched: help');
      if (canPostMessage()) {
        await post(
          'Commandes:\n' +
          '• retiens: <texte> - Enregistrer\n' +
          '• cherche: <terme> - Rechercher\n' +
          '• résume: <sujet> - Résumer'
        );
      }
    }

    // LLM mode: if message mentions Archiviste or addresses all agents
    else if (shouldCallLLM(content)) {
      console.log('[ARCHIVISTE] -> Triggering LLM mode');

      if (!canPostMessage()) {
        console.warn('[ARCHIVISTE] Rate limit reached, skipping LLM');
        return true;
      }

      // Search memory for context
      const memoryContext = await readMemory(content);
      const memoryText = memoryContext && typeof memoryContext.result === 'string'
        ? memoryContext.result.trim().substring(0, 500)
        : '';

      // Build system prompt
      const systemPrompt =
        'You are Archiviste, a memory agent for Florent\'s life assistant. ' +
        'Respond in English in the hub. Keep response to 5 lines max. ' +
        (memoryText ? `Relevant memory context: ${memoryText}` : '');

      // Call Claude LLM
      const llmResponse = await callClaudeLLM(systemPrompt, content);

      if (llmResponse) {
        // Truncate to 5 lines max
        const truncated = llmResponse.split('\n').slice(0, 5).join('\n');
        await post(truncated);
      } else {
        console.error('[ARCHIVISTE] LLM failed, no response posted');
      }
    }

    // All other messages: brief response (not a command)
    else {
      console.log('[ARCHIVISTE] -> No command, brief response');

      if (!canPostMessage()) {
        console.warn('[ARCHIVISTE] Rate limit reached, skipping response');
        return true;
      }

      // Check if we already replied to this author in the last 5 minutes
      const now = Date.now();
      const lastResponse = lastHelpResponsePerAuthor.get(author) || 0;
      const fiveMinutesMs = 5 * 60 * 1000;

      if (now - lastResponse < fiveMinutesMs) {
        console.log(`[ARCHIVISTE] Already responded to ${author} within 5 min, skipping`);
        return true;
      }

      // Detect message language (simple heuristic: has French accents or words)
      const isFrench = /[àâääéèêëïîôöùûüœç]/i.test(content) ||
                       /(que|et|le|de|est|un|une|je|tu|il|elle|nous|vous|ils|elles)\b/i.test(content);

      const briefResponse = isFrench
        ? 'Je suis un script relais vers la mémoire du coach (modèle Sonnet 5.5).\nCommandes: retiens:, cherche:, résume:, ?, aide'
        : 'I am a relay script to the coach\'s memory (Sonnet 5.5 model).\nCommands: retiens:, cherche:, résume:, ?, aide';

      await post(briefResponse);
      lastHelpResponsePerAuthor.set(author, now);
    }
  } catch (err) {
    console.error('[ARCHIVISTE] Error in processMessage:', err.message);
    return false;
  }
  return !postFailed;
}

/**
 * Acquire PID lock - ensure only one instance runs
 */
function acquirePidLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
      if (!isNaN(oldPid) && oldPid !== process.pid) {
        // Check if old process is still alive
        try {
          process.kill(oldPid, 0); // Signal 0 = check existence
          console.error(`[ARCHIVISTE] Another instance (PID ${oldPid}) is running. Exiting.`);
          process.exit(0);
        } catch (err) {
          // Old process is dead, safe to continue
          console.log(`[ARCHIVISTE] Old PID ${oldPid} is dead, proceeding.`);
        }
      }
    }
    fs.writeFileSync(PID_FILE, process.pid.toString(), { mode: 0o600 });
    console.log(`[ARCHIVISTE] PID lock acquired: ${process.pid}`);
  } catch (err) {
    console.error(`[ARCHIVISTE] Failed to acquire PID lock: ${err.message}`);
  }
}

/**
 * Release PID lock on shutdown
 */
function releasePidLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
      console.log('[ARCHIVISTE] PID lock released');
    }
  } catch (err) {
    console.error(`[ARCHIVISTE] Failed to release PID lock: ${err.message}`);
  }
}

/**
 * Main loop
 */
async function mainLoop() {
  if (!ROOM_TOKEN) {
    console.error('[ARCHIVISTE] ROOM_TOKEN env var is required (see archiviste/README.md)');
    process.exit(1);
  }
  console.log('[ARCHIVISTE] Starting main loop...');

  // Initial join
  if (!state.memberToken) {
    try {
      await joinRoom();
    } catch (err) {
      console.error('[ARCHIVISTE] Failed to join on startup');
      await sleep(BACKOFF_CONFIG.initialDelayMs);
      return;
    }
  }

  // Post welcome message only once
  if (!state.welcomedAt) {
    try {
      await postMessage(
        '👋 Archiviste prêt.\n' +
        'Commandes: retiens:, cherche:, résume:, ?, aide'
      );
      state.welcomedAt = new Date().toISOString();
      saveState();
    } catch (err) {
      console.error('[ARCHIVISTE] Failed to post welcome message');
    }
  }

  // Initialize lastProcessedMessageId
  await initializeLastMessageId();

  // Long-poll loop
  while (!shuttingDown) {
    try {
      const messages = await pollMessages();
      if (shuttingDown) break;
      await processBatch(messages);
      // Reset backoff on successful poll
      currentBackoffMs = BACKOFF_CONFIG.initialDelayMs;
    } catch (err) {
      console.error(`[ARCHIVISTE] Error in main loop: ${err.message}`);
      await sleep(currentBackoffMs);
      currentBackoffMs = Math.min(currentBackoffMs * BACKOFF_CONFIG.multiplier, BACKOFF_CONFIG.maxDelayMs);
    }
  }
}

let inflight = 0;
let idleWaiters = [];

/**
 * At-least-once batch processing with limited concurrency.
 * lastProcessedMessageId only advances past a message once it is fully handled
 * (reply posted) AND every earlier message of the batch is handled too.
 * Replies are posted in message order even though the slow work runs concurrently.
 */
export async function processBatch(messages, handler = processMessage) {
  const pending = (messages || [])
    .filter(m => m.id > (state.lastProcessedMessageId || 0) && !state.doneIds.includes(m.id))
    .sort((a, b) => a.id - b.id);
  if (pending.length === 0) {
    if (messages && messages.length > 0) await sleep(1000); // only already-done messages above a retried one
    return;
  }

  const finished = new Map(); // id -> boolean (true = handled)
  let failed = false;

  const advance = () => {
    // Watermark = highest id such that all pending ids <= it are handled
    let wm = state.lastProcessedMessageId || 0;
    const done = new Set(state.doneIds);
    for (const m of pending) {
      if (finished.get(m.id) === true) { done.add(m.id); }
    }
    for (const m of pending) {
      if (done.has(m.id)) wm = Math.max(wm, m.id); else break;
    }
    state.lastProcessedMessageId = wm;
    state.doneIds = [...done].filter(id => id > wm);
    saveState();
  };

  // Reply turnstile: message k posts only after message k-1 finished
  const turns = [];
  let next = 0;
  const worker = async () => {
    while (!shuttingDown && !failed) {
      const idx = next++;
      if (idx >= pending.length) return;
      const msg = pending[idx];
      const gate = idx === 0 ? Promise.resolve() : turns[idx - 1];
      let release;
      turns[idx] = new Promise(r => { release = r; });
      inflight++;
      let ok = false;
      try {
        ok = await handler(msg, gate);
      } catch (err) {
        console.error(`[ARCHIVISTE] Handler error msg_id=${msg.id}: ${err.message}`);
      }
      inflight--;
      if (ok) {
        finished.set(msg.id, true);
        attempts.delete(msg.id);
        advance();
      } else if (!shuttingDown) {
        const n = (attempts.get(msg.id) || 0) + 1;
        attempts.set(msg.id, n);
        if (n >= MAX_ATTEMPTS) {
          console.error(`[ARCHIVISTE] msg_id=${msg.id} failed ${n} times, giving up`);
          finished.set(msg.id, true);
          attempts.delete(msg.id);
          advance();
        } else {
          failed = true; // stop picking up later messages; they stay > watermark
        }
      }
      release();
      if (inflight === 0) { idleWaiters.forEach(r => r()); idleWaiters = []; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  // Unblock any turn that never ran (so nothing hangs)
  if (failed && !shuttingDown) await sleep(currentBackoffMs);
}

function waitIdle(ms) {
  if (inflight === 0) return Promise.resolve();
  return Promise.race([new Promise(r => idleWaiters.push(r)), sleep(ms)]);
}

// Start only when run directly (importing for tests must not join a room)
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  acquirePidLock();
  loadState();
  mainLoop().catch(err => {
    console.error('[ARCHIVISTE] Fatal error:', err);
    releasePidLock();
    process.exit(1);
  });

  // Handle graceful shutdown
  // Graceful shutdown: stop taking new messages, let in-flight ones finish (bounded),
  // never advance past an unfinished message.
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ARCHIVISTE] Received ${sig}, shutting down gracefully (in-flight: ${inflight})`);
    await waitIdle(SHUTDOWN_GRACE_MS);
    if (inflight > 0) console.warn(`[ARCHIVISTE] ${inflight} message(s) abandoned, will be reprocessed at restart`);
    saveState();
    releasePidLock();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('exit', () => {
    releasePidLock();
  });

}
