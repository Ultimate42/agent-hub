// Session Claude Agent SDK en entrée continue (flux), avec rotation par résumé quand le nombre de tours dépasse un seuil.
// `queryFn` est injecté (SDK réel ou simulé dans les tests).
export class AgentSession {
  constructor({ agent, queryFn, appendPrompt = '', env, claudeExecutable, log = () => {}, restartDelayMs = 5000, summaryMaxChars = 6000 }) {
    Object.assign(this, { agent, queryFn, appendPrompt, env, claudeExecutable, log, restartDelayMs, summaryMaxChars });
    this.queue = [];
    this.wake = null;
    this.turns = 0;          // tours terminés dans la session courante
    this.generation = 0;     // numéro de session (rotations incluses)
    this.rotating = false;   // demande de résumé en cours
    this.ctl = { closed: false };
    this.running = false;
    this.lastText = '';
    this.carry = '';         // résumé à injecter à la prochaine session
    this.q = null;
    this.busy = false;
  }

  push(text) {
    this.queue.push(text);
    this.busy = true;
    if (this.wake) { this.wake(); this.wake = null; }
  }

  start() { this.running = true; this.done = this._main(); return this.done; }

  async stop(graceMs = 3000) {
    this.running = false; this.ctl.closed = true;
    if (this.wake) { this.wake(); this.wake = null; }
    const t = setTimeout(() => { try { this.q?.close?.(); } catch {} }, graceMs);
    try { await this.done; } finally { clearTimeout(t); }
  }

  async *_input(ctl) {
    while (true) {
      if (ctl.closed) return;
      if (this.queue.length) {
        const text = this.queue.shift();
        yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
        continue;
      }
      await new Promise((r) => (this.wake = r));
    }
  }

  async _main() {
    while (this.running) {
      let crashed = false;
      try { await this._runOne(); } catch (e) { crashed = true; this.log(`erreur de session : ${String(e?.message || e).slice(0, 300)}`); }
      if (!this.running) break;
      if (crashed || !this.rotating) await new Promise((r) => setTimeout(r, this.restartDelayMs)); // crash ou fin inattendue
      this.rotating = false;
    }
  }

  async _runOne() {
    this.generation++; this.turns = 0; this.skipTurns = 1; // le message initial (démarrage/reprise) ne compte pas
    this.ctl = { closed: false }; this.lastText = '';
    const a = this.agent;
    if (this.carry) {
      this.queue.unshift(`[Reprise après rotation] Résumé de ta session précédente (tours épuisés) :\n${this.carry}\nContinue à partir de là.`);
      this.carry = '';
    } else if (this.generation === 1 || this.queue.length === 0) {
      this.queue.unshift(`[Démarrage] Tu es ${a.name}, session continue connectée au hub. Les messages du salon arrivent étiquetés « [Hub <salon> #id de <auteur>] ». Réponds seulement quand c'est utile.`);
    }
    this.busy = true;
    this.log(`session #${this.generation} démarrée (modèle ${a.model})`);
    this.q = this.queryFn({
      prompt: this._input(this.ctl),
      options: {
        model: a.model, cwd: a.cwd,
        permissionMode: a.permissionMode,
        ...(a.allowedTools?.length ? { allowedTools: a.allowedTools } : {}),
        ...(a.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        settingSources: a.settingSources,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.appendPrompt },
        ...(this.claudeExecutable ? { pathToClaudeCodeExecutable: this.claudeExecutable } : {}),
        ...(this.env ? { env: this.env } : {}),
      },
    });
    for await (const m of this.q) this._onMessage(m);
  }

  _onMessage(m) {
    if (m.type === 'assistant') {
      const t = (m.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (t) this.lastText = t;
    } else if (m.type === 'result') {
      if (this.skipTurns > 0) this.skipTurns--; else this.turns++;
      this.busy = this.queue.length > 0;
      if (this.rotating) {
        this.carry = (typeof m.result === 'string' && m.result ? m.result : this.lastText).slice(0, this.summaryMaxChars);
        this.log(`rotation : session #${this.generation} close après ${this.turns} tours`);
        this.ctl.closed = true;
        if (this.wake) { this.wake(); this.wake = null; }
      } else if (this.agent.maxTurns > 0 && this.turns >= this.agent.maxTurns && !this.queue.length) {
        this.rotating = true; this.busy = true;
        this.push('[Rotation] Ta session va être redémarrée. Réponds UNIQUEMENT par un résumé concis (décisions, tâches en cours, points à suivre) qui servira de mémoire à la nouvelle session.');
      }
    }
  }
}
