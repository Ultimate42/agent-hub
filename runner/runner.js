// Orchestration : une session + un abonnement hub par agent de la config.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, formatMessage, RateLimiter, readSecretFile } from './lib.js';
import { AgentSession } from './session.js';
import { HubSubscription } from './hub-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Relie un abonnement hub à une session pour un agent (logique de routage, testable sans réseau). */
export class AgentBridge {
  constructor({ agent, peers, session, now = Date.now, log = () => {} }) {
    Object.assign(this, { agent, peers, session, log });
    this.limiter = new RateLimiter(agent.maxMessagesPerMinute, 60_000, now);
    this.ownIds = new Set();
    this.roomLabel = agent.roomLabel || 'salon';
    this.dropped = 0;
    this.stats = { pushed: 0, skipped: 0, rateLimited: 0 };
  }
  setRoomName(n) { if (!this.agent.roomLabel && n) this.roomLabel = n; }
  handle(msg) {
    if (msg.author && msg.author.toLowerCase() === this.agent.name.toLowerCase()) {
      this.ownIds.add(msg.id);
      if (this.ownIds.size > 500) this.ownIds.delete(this.ownIds.values().next().value);
    }
    const d = decide(msg, this.agent, { peers: this.peers, ownIds: this.ownIds });
    if (!d.push) { this.stats.skipped++; return d; }
    if (!this.limiter.tryTake()) {
      this.dropped++; this.stats.rateLimited++;
      this.log(`${this.agent.name} : limite ${this.agent.maxMessagesPerMinute}/min atteinte, message #${msg.id} ignoré`);
      return { push: false, reason: 'rate-limit' };
    }
    const extra = this.dropped ? `[Runner : ${this.dropped} message(s) du salon ignoré(s) (limite de débit) ; relis le salon si besoin.]` : '';
    this.dropped = 0;
    this.session.push(formatMessage(msg, this.roomLabel, extra));
    this.stats.pushed++;
    return d;
  }
}

function buildAppendPrompt(agent, cfg, roomToken) {
  const parts = [];
  if (agent.systemPrompt) parts.push(agent.systemPrompt);
  if (agent.systemPromptFile) parts.push(fs.readFileSync(agent.systemPromptFile, 'utf8'));
  const post = `node ${path.join(HERE, 'hub-post.mjs')} --hub ${cfg.hubUrl} --room ${agent.roomTokenFile || '<room>'} --token-file ${agent.memberTokenFile}`;
  parts.push(`Tu es « ${agent.name} », connecté en continu à un salon du hub. Chaque message du salon t'arrive comme « [Hub <salon> #id de <auteur>] texte ». ` +
    `Pour répondre dans le salon, envoie ton texte sur stdin de : ${post} [--reply-to <id>] (heredoc). Ne réponds pas à chaque message : seulement quand c'est utile. ` +
    `Ne lis ni n'affiche jamais les fichiers de token.`);
  return parts.join('\n\n');
}

export async function loadSdkQuery(cfg) {
  const mod = cfg.sdkModule
    ? await import(cfg.sdkModule.startsWith('/') ? cfg.sdkModule : path.resolve(cfg.sdkModule))
    : await import('@anthropic-ai/claude-agent-sdk');
  return mod.query;
}

export class Runner {
  constructor(cfg, { queryFn, SubscriptionImpl = HubSubscription, WebSocketImpl, log = (s) => console.log(`[${new Date().toISOString()}] ${s}`) } = {}) {
    Object.assign(this, { cfg, queryFn, SubscriptionImpl, WebSocketImpl, log });
    this.bridges = [];
    this.subs = [];
  }

  async start() {
    const cfg = this.cfg;
    const peers = cfg.agents.map((a) => a.name);
    for (const agent of cfg.agents) {
      const memberToken = readSecretFile(agent.memberTokenFile);
      const roomToken = agent.roomToken || readSecretFile(agent.roomTokenFile);
      const env = { ...process.env };
      if (agent.oauthTokenFile) env.CLAUDE_CODE_OAUTH_TOKEN = readSecretFile(agent.oauthTokenFile);
      const log = (s) => this.log(`[${agent.name}] ${s}`);
      const session = new AgentSession({ agent, queryFn: this.queryFn, appendPrompt: buildAppendPrompt(agent, cfg, roomToken), env, claudeExecutable: cfg.claudeExecutable, log });
      const bridge = new AgentBridge({ agent, peers, session, log });
      const sub = new this.SubscriptionImpl({
        hubUrl: cfg.hubUrl, roomToken, memberToken, transport: cfg.transport, WebSocketImpl: this.WebSocketImpl, log,
        onMessage: (m) => bridge.handle(m), onRoomName: (n) => bridge.setRoomName(n),
      });
      this.bridges.push(bridge); this.subs.push(sub);
      session.start();
      await sub.start();
    }
    this.log(`runner démarré : ${cfg.agents.length} agent(s), transport ${cfg.transport}`);
  }

  async stop() {
    this.subs.forEach((s) => s.stop());
    await Promise.all(this.bridges.map((b) => b.session.stop()));
    this.log('runner arrêté');
  }
}
