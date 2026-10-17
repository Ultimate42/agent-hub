// Abonnement au hub : WebSocket (reconnexion auto + rattrapage REST) ou long-poll en repli.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HubSubscription {
  constructor({ hubUrl, roomToken, memberToken, onMessage, onRoomName = () => {}, transport = 'auto', WebSocketImpl, fetchImpl = fetch, log = () => {}, backoffMinMs = 1000, backoffMaxMs = 30000 }) {
    Object.assign(this, { hubUrl, roomToken, memberToken, onMessage, onRoomName, transport, WebSocketImpl, fetchImpl, log, backoffMinMs, backoffMaxMs });
    this.floor = -1; this.lastId = null;     // curseur REST (messages déjà vus via REST / démarrage)
    this.seen = new Set();  // dédoublonnage WS + REST
    this.abort = new AbortController();
    this.stopped = false;
    this.ws = null;
    this.mode = null;
  }

  get headers() { return { Authorization: `Bearer ${this.memberToken}`, 'Content-Type': 'application/json' }; }
  async _get(p) {
    const r = await this.fetchImpl(`${this.hubUrl}/api/rooms/${this.roomToken}${p}`, { headers: this.headers, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(40000)]) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  _deliver(msg, fromRest = false) {
    if (!Number.isFinite(msg?.id)) return;
    if (fromRest && msg.id > this.lastId) this.lastId = msg.id;
    if (msg.id <= this.floor || this.seen.has(msg.id)) return; // déjà vu (WS / REST) ou antérieur au démarrage
    this.seen.add(msg.id);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
    try { this.onMessage(msg); } catch (e) { this.log(`onMessage: ${e.message}`); }
  }

  async _init() {
    const r = await this._get('/messages?limit=1');
    if (this.lastId === null) { this.lastId = this.floor = r.messages?.length ? r.messages[r.messages.length - 1].id : 0; } // pas de rejeu de l'historique
  }
  async _catchUp() {
    for (let i = 0; i < 10; i++) {
      const r = await this._get(`/messages?since=${this.lastId}&limit=100`);
      if (!r.messages?.length) return;
      r.messages.forEach((m) => this._deliver(m, true));
    }
  }

  async _resolveWS() {
    if (this.WebSocketImpl) return this.WebSocketImpl;
    if (this.transport === 'poll') return null;
    try { return (await import('ws')).WebSocket || (await import('ws')).default; } catch { return null; }
  }

  async start() {
    this.loop = this._run();
    // Le hub ne diffuse PAS en WebSocket les messages postés via REST/MCP (seulement aux long-polls) :
    // en mode WS on garde donc un long-poll en parallèle comme filet de sécurité (dédoublonné par id).
    this.pollLoop = this._safetyPoll();
    return this;
  }

  async _safetyPoll() {
    let backoff = this.backoffMinMs;
    while (!this.stopped) {
      if (this.mode !== 'ws' || this.lastId === null) { await sleep(200); continue; }
      try { await this._pollOnce(); backoff = this.backoffMinMs; }
      catch (e) { if (this.stopped) break; this.log(`long-poll de sécurité : ${e.message}`); await sleep(backoff); backoff = Math.min(backoff * 2, this.backoffMaxMs); }
    }
  }

  async _run() {
    let backoff = this.backoffMinMs;
    while (!this.stopped) {
      try {
        if (this.lastId === null) await this._init();
        const WS = await this._resolveWS();
        if (WS) { this.mode = 'ws'; await this._wsOnce(WS); }
        else { this.mode = 'poll'; await this._pollOnce(); }
        backoff = this.backoffMinMs;
      } catch (e) {
        this.log(`hub (${this.mode || '?'}) : ${e.message} ; nouvelle tentative dans ${backoff} ms`);
      }
      if (this.stopped) break;
      await sleep(this.mode === 'poll' && backoff === this.backoffMinMs ? 0 : backoff);
      backoff = Math.min(backoff * 2, this.backoffMaxMs);
    }
  }

  async _pollOnce() {
    const r = await this._get(`/messages/wait?since=${this.lastId}&timeout=25000`);
    (r.messages || []).forEach((m) => this._deliver(m, true));
  }

  _wsOnce(WS) {
    const url = this.hubUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(this.memberToken)}`;
    return new Promise((resolve, reject) => {
      const ws = new WS(url);
      this.ws = ws;
      let opened = false;
      const on = (ev, fn) => (ws.addEventListener ? ws.addEventListener(ev, fn) : ws.on(ev, fn));
      on('open', () => { opened = true; this._catchUp().catch((e) => this.log(`rattrapage: ${e.message}`)); });
      on('message', (ev) => {
        let m; try { m = JSON.parse(String(ev?.data ?? ev)); } catch { return; }
        if (m.type === 'connected') { if (m.room_name) this.onRoomName(m.room_name); return; }
        this._deliver(m);
      });
      on('error', () => {});
      on('close', (ev) => {
        this.ws = null;
        const code = ev?.code ?? ev;
        if (code === 4001 || code === 4003) reject(new Error(`WS refusé (${code})`));
        else if (!opened) reject(new Error('WS non connecté'));
        else resolve();
      });
    });
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    try { this.ws?.close(); } catch {}
  }
}
