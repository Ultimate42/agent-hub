#!/usr/bin/env node
/**
 * Archiviste Agent - Resident memory manager for Florent's health, sport, nutrition data
 * Joins a room, monitors for commands, and interfaces with memory-agent API
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const ROOM_TOKEN = process.env.ROOM_TOKEN || '***REMOVED***';
const AGENT_HUB_URL = process.env.AGENT_HUB_URL || 'http://localhost:4030';
const MEMORY_API_URL = process.env.MEMORY_API_URL || 'http://localhost:4010';
const STATE_FILE = path.join(__dirname, 'state.json');
const AGENT_NAME = 'Archiviste';
const AGENT_ROLE = 'agent';

// Global state
let state = {
  memberToken: null,
  joinedAt: null,
  lastProcessedMessageId: null,
  welcomedAt: null,
};

const PID_FILE = path.join(__dirname, 'archiviste.pid');
let messagesThisMinute = 0;
let lastMinuteReset = Date.now();

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
async function processMessage(msg) {
  try {
    // Ignore own messages - check author field, not member_name
    if (msg.author === AGENT_NAME) {
      console.log(`[ARCHIVISTE] Ignoring own message (author=${msg.author})`);
      return;
    }

    const content = msg.content || '';
    const author = msg.author || msg.member_name || 'Unknown';
    console.log(`[ARCHIVISTE] Processing msg_id=${msg.id} author=${author}: ${content.substring(0, 60)}`);

    const normalized = normalize(content);

    // Command: retiens: ... or ajoute: ... (add memory)
    if (normalized.startsWith('retiens:') || normalized.startsWith('ajoute:')) {
      console.log('[ARCHIVISTE] -> Matched: retiens/ajoute');
      const memoryContent = content.substring(content.indexOf(':') + 1).trim();
      const success = await writeMemory({
        name: 'Note',
        description: memoryContent,
        date: new Date().toISOString(),
      });

      if (success && canPostMessage()) {
        await postMessage(`✓ Enregistré: "${memoryContent.substring(0, 40)}..."`);
      } else if (!success && canPostMessage()) {
        await postMessage('❌ Erreur enregistrement.');
      }
    }

    // Command: cherche: ... or recherche: ... (search memory)
    else if (normalized.startsWith('cherche:') || normalized.startsWith('recherche:')) {
      console.log('[ARCHIVISTE] -> Matched: cherche/recherche');
      const query = content.substring(content.indexOf(':') + 1).trim();
      const result = await readMemory(query);

      if (canPostMessage()) {
        if (result && typeof result.result === 'string' && result.result.trim()) {
          await postMessage(`📚 ${result.result.trim().substring(0, 1500)}`);
        } else if (result && result.text) {
          await postMessage(`📚 ${result.text}`);
        } else if (result && result.summary) {
          await postMessage(`📚 ${result.summary}`);
        } else if (result && Object.keys(result).length > 0) {
          // Fallback: stringify the result
          const summary = JSON.stringify(result).substring(0, 100);
          await postMessage(`📚 ${summary}`);
        } else {
          await postMessage('Aucun résultat.');
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
          await postMessage(`📊 ${result.result.trim().substring(0, 1500)}`);
        } else if (result && result.summary) {
          await postMessage(`📊 ${result.summary}`);
        } else if (result && result.text) {
          await postMessage(`📊 ${result.text}`);
        } else {
          await postMessage('Pas de résumé disponible.');
        }
      }
    }

    // Help: exact match "?" or "aide"
    else if (content.trim() === '?' || content.trim() === 'aide') {
      console.log('[ARCHIVISTE] -> Matched: help');
      if (canPostMessage()) {
        await postMessage(
          'Commandes:\n' +
          '• retiens: <texte> - Enregistrer\n' +
          '• cherche: <terme> - Rechercher\n' +
          '• résume: <sujet> - Résumer'
        );
      }
    }

    // All other messages: SILENCE (no response)
    else {
      console.log('[ARCHIVISTE] -> No command, silence');
    }
  } catch (err) {
    console.error('[ARCHIVISTE] Error in processMessage:', err.message);
  }
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
  while (true) {
    try {
      const messages = await pollMessages();

      if (messages && messages.length > 0) {
        for (const msg of messages) {
          // Process only if id > lastProcessedMessageId (numeric comparison)
          if (msg.id > (state.lastProcessedMessageId || 0)) {
            state.lastProcessedMessageId = msg.id;
            saveState();
            await processMessage(msg);
          }
        }
      }

      // Reset backoff on successful poll
      currentBackoffMs = BACKOFF_CONFIG.initialDelayMs;
    } catch (err) {
      console.error(`[ARCHIVISTE] Error in main loop: ${err.message}`);
      await sleep(currentBackoffMs);
      currentBackoffMs = Math.min(currentBackoffMs * BACKOFF_CONFIG.multiplier, BACKOFF_CONFIG.maxDelayMs);
    }
  }
}

// Start
acquirePidLock();
loadState();
mainLoop().catch(err => {
  console.error('[ARCHIVISTE] Fatal error:', err);
  releasePidLock();
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[ARCHIVISTE] Received SIGTERM, shutting down gracefully');
  saveState();
  releasePidLock();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[ARCHIVISTE] Received SIGINT, shutting down gracefully');
  saveState();
  releasePidLock();
  process.exit(0);
});

process.on('exit', () => {
  releasePidLock();
});
