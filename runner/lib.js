// Logique pure du hub-session-runner (sans E/S réseau ni SDK) : config, filtre, anti-boucle, étiquetage.
import fs from 'node:fs';
import path from 'node:path';

// Seuls Sonnet 5.5 et Opus 5.5 sont autorisés (jamais de 4.x).
export const ALLOWED_MODELS = Object.freeze(['claude-sonnet-5-5', 'claude-opus-5-5']);
export const CHAT_TYPES = new Set(['message', 'question', 'response', 'directive']);

export function assertModel(model) {
  if (!ALLOWED_MODELS.includes(model)) {
    throw new Error(`modèle non autorisé "${model}" (autorisés : ${ALLOWED_MODELS.join(', ')})`);
  }
  return model;
}

/** Lit un secret depuis un fichier : "member_token=xxx", "KEY=xxx" ou simplement la 1re ligne. Ne jamais logger le résultat. */
export function readSecretFile(file) {
  const first = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const m = first.match(/^[A-Za-z_]+=(.+)$/);
  return (m ? m[1] : first).trim();
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const isMentioned = (content, name) => new RegExp(`@${esc(name)}(?![\\w-])`, 'i').test(content || '');
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/**
 * Décide si un message du salon doit être poussé dans la session de `agent`.
 * @returns {{push:boolean, reason:string}}
 */
export function decide(msg, agent, ctx) {
  const { peers = [], ownIds = new Set(), ignoreAuthors = ['system', 'HubWatchdog'] } = ctx || {};
  if (!msg || !Number.isFinite(msg.id)) return { push: false, reason: 'no-id' };
  if (msg.type && !CHAT_TYPES.has(msg.type)) return { push: false, reason: 'type' };
  if (!msg.content) return { push: false, reason: 'empty' };
  const author = msg.author || '';
  if (same(author, agent.name)) return { push: false, reason: 'self' };
  if (/^auto-/i.test(author)) return { push: false, reason: 'auto' };
  if (ignoreAuthors.some((a) => same(a, author))) return { push: false, reason: 'ignored-author' };
  const fromPeer = peers.some((p) => same(p, author));
  if (fromPeer) {
    const addressed = isMentioned(msg.content, agent.name) || (msg.reply_to && ownIds.has(msg.reply_to));
    if (!addressed) return { push: false, reason: 'peer-not-mentioned' };
  }
  return { push: true, reason: fromPeer ? 'peer-mentioned' : 'ok' };
}

export function formatMessage(msg, roomLabel, extra = '') {
  const head = `[Hub ${roomLabel} #${msg.id} de ${msg.author}${msg.reply_to ? ` (réponse à #${msg.reply_to})` : ''}]`;
  return `${extra ? extra + '\n' : ''}${head} ${msg.content}`;
}

/** Fenêtre glissante : au plus `limit` messages par `windowMs`. limit<=0 : illimité. */
export class RateLimiter {
  constructor(limit, windowMs = 60_000, now = Date.now) { this.limit = limit; this.windowMs = windowMs; this.now = now; this.hits = []; }
  tryTake() {
    if (!(this.limit > 0)) return true;
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(t);
    return true;
  }
}

/** Valide et normalise la config. Les chemins relatifs sont résolus par rapport au fichier de config. */
export function loadConfig(file) {
  const base = path.dirname(path.resolve(file));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalizeConfig(raw, base);
}

export function normalizeConfig(raw, base = process.cwd()) {
  const abs = (p) => (p ? path.resolve(base, p) : p);
  const list = Array.isArray(raw) ? raw : raw.agents;
  if (!Array.isArray(list) || !list.length) throw new Error('config : "agents" doit être une liste non vide');
  const d = Array.isArray(raw) ? {} : raw;
  const agents = list.map((a, i) => {
    if (!a.name) throw new Error(`agent #${i} : "name" requis`);
    if (!a.memberTokenFile) throw new Error(`${a.name} : "memberTokenFile" requis`);
    if (!a.roomToken && !a.roomTokenFile) throw new Error(`${a.name} : "roomToken" ou "roomTokenFile" requis`);
    return {
      name: a.name,
      memberTokenFile: abs(a.memberTokenFile),
      roomToken: a.roomToken,
      roomTokenFile: abs(a.roomTokenFile),
      roomLabel: a.roomLabel,
      model: assertModel(a.model || d.defaultModel || 'claude-sonnet-5-5'),
      systemPrompt: a.systemPrompt || '',
      systemPromptFile: abs(a.systemPromptFile),
      cwd: abs(a.cwd) || base,
      maxTurns: a.maxTurns ?? d.maxTurns ?? 40,
      maxMessagesPerMinute: a.maxMessagesPerMinute ?? d.maxMessagesPerMinute ?? 6,
      permissionMode: a.permissionMode || d.permissionMode || 'bypassPermissions',
      settingSources: a.settingSources || d.settingSources || ['project'],
      oauthTokenFile: abs(a.oauthTokenFile || d.oauthTokenFile),
    };
  });
  const names = new Set();
  for (const a of agents) { const k = a.name.toLowerCase(); if (names.has(k)) throw new Error(`agent en double : ${a.name}`); names.add(k); }
  return {
    hubUrl: (d.hubUrl || 'http://localhost:4030').replace(/\/$/, ''),
    transport: d.transport || 'auto', // auto | ws | poll
    claudeExecutable: d.claudeExecutable,
    sdkModule: d.sdkModule, // chemin d'un module @anthropic-ai/claude-agent-sdk si non installé ici
    logFile: abs(d.logFile),
    agents,
  };
}
