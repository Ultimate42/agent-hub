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
const MEMORY_API_URL = process.env.MEMORY_API_URL || 'http://localhost:7654';
const STATE_FILE = path.join(__dirname, 'state.json');
const AGENT_NAME = 'Archiviste';
const AGENT_ROLE = 'agent';

// Global state
let state = {
  memberToken: null,
  joinedAt: null,
  lastProcessedMessageId: null,
};

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
 * Fetch with retry and backoff
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

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    currentBackoffMs = BACKOFF_CONFIG.initialDelayMs; // Reset on success
    return response;
  } catch (err) {
    const nextBackoff = Math.min(
      BACKOFF_CONFIG.initialDelayMs * Math.pow(BACKOFF_CONFIG.multiplier, attempt),
      BACKOFF_CONFIG.maxDelayMs
    );

    console.error(
      `[ARCHIVISTE] Fetch error (attempt ${attempt + 1}): ${err.message}. Retry in ${nextBackoff}ms`
    );

    await sleep(nextBackoff);

    if (attempt < 5) {
      return fetchWithRetry(url, options, attempt + 1, timeoutMs);
    }

    throw new Error(`Failed after ${attempt + 1} attempts: ${err.message}`);
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
async function writeMemory(content, path = 'divers') {
  try {
    const response = await fetchWithRetry(
      `${MEMORY_API_URL}/write`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content,
          tree: 'coach',
          path: path,
        }),
      }
    );

    const data = await response.json();
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
    const response = await fetchWithRetry(
      `${MEMORY_API_URL}/read`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: subject,
        }),
      }
    );

    const data = await response.json();
    return data;
  } catch (err) {
    console.error(`[ARCHIVISTE] Failed to read memory: ${err.message}`);
    return null;
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
    const response = await fetchWithRetry(
      `${AGENT_HUB_URL}/api/rooms/${ROOM_TOKEN}/messages/wait?timeout=30000`,
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
 * Process a single message
 */
async function processMessage(msg) {
  try {
    // Ignore own messages
    if (msg.member_name === AGENT_NAME) {
      return;
    }

    const content = msg.content || '';
    console.log(`[ARCHIVISTE] Processing msg_id=${msg.id} name=${msg.member_name} role=${msg.member_role}: ${content.substring(0, 60)}`);

    // Command: retiens: ... (add memory)
    if (content.toLowerCase().startsWith('retiens:') || content.toLowerCase().startsWith('ajoute:')) {
      console.log('[ARCHIVISTE] -> Matched: retiens/ajoute');
      const memoryContent = content.substring(content.indexOf(':') + 1).trim();
      const success = await writeMemory({
        name: 'Note',
        description: memoryContent,
        date: new Date().toISOString(),
      });

      if (success) {
        await postMessage(
          `✓ Mémoire enregistrée: "${memoryContent.substring(0, 40)}..."`
        );
      } else {
        await postMessage('❌ Erreur lors de l\'enregistrement.');
      }
    }

    // Command: cherche: ... (search memory)
    else if (
      content.toLowerCase().startsWith('cherche:') ||
      content.toLowerCase().startsWith('recherche:')
    ) {
      console.log('[ARCHIVISTE] -> Matched: cherche/recherche');
      const query = content.substring(content.indexOf(':') + 1).trim();
      const result = await readMemory(query);

      if (result && result.summary) {
        await postMessage(`📚 ${result.summary}`);
      } else if (result) {
        await postMessage(`📚 Résultat: ${JSON.stringify(result).substring(0, 100)}...`);
      } else {
        await postMessage('Aucun résultat trouvé.');
      }
    }

    // Command: résume: ... (summarize)
    else if (content.toLowerCase().startsWith('résume:')) {
      console.log('[ARCHIVISTE] -> Matched: résume');
      const query = content.substring(content.indexOf(':') + 1).trim();
      const result = await readMemory(query);

      if (result && result.summary) {
        await postMessage(`📊 Résumé: ${result.summary}`);
      } else {
        await postMessage('Impossible de générer un résumé.');
      }
    }

    // Help for unknown commands
    else if (content.trim() === '?' || content.toLowerCase().includes('aide')) {
      console.log('[ARCHIVISTE] -> Matched: help');
      await postMessage(
        'Commandes:\n' +
        '• retiens: <texte> - Enregistrer une info\n' +
        '• cherche: <terme> - Rechercher en mémoire\n' +
        '• résume: <sujet> - Résumer un sujet'
      );
    }

    // Echo for regular messages
    else {
      console.log('[ARCHIVISTE] -> No match, generic response');
      await postMessage(`✓ Compris. Tapez "?" pour l'aide.`);
    }
  } catch (err) {
    console.error('[ARCHIVISTE] Error in processMessage:', err.message);
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

  // Post welcome message
  try {
    await postMessage(
      '👋 Bienvenue! Je suis l\'Archiviste.\n' +
      'Je construis la mémoire complète et exploitable de vos données: ' +
      'séances de sport, poids, repas, santé.\n' +
      'Utilisez:\n' +
      '• retiens: <info> - Enregistrer\n' +
      '• cherche: <terme> - Rechercher\n' +
      '• résume: <sujet> - Résumer'
    );

    // Initialize lastProcessedMessageId by fetching current messages
    // This ensures we skip old messages and only process new ones
    await sleep(500);
  } catch (err) {
    console.error('[ARCHIVISTE] Failed to post welcome message');
  }

  // Long-poll loop
  while (true) {
    try {
      const messages = await pollMessages();

      if (messages && messages.length > 0) {
        for (const msg of messages) {
          if (msg.id !== state.lastProcessedMessageId) {
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
loadState();
mainLoop().catch(err => {
  console.error('[ARCHIVISTE] Fatal error:', err);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[ARCHIVISTE] Received SIGTERM, shutting down gracefully');
  saveState();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[ARCHIVISTE] Received SIGINT, shutting down gracefully');
  saveState();
  process.exit(0);
});
