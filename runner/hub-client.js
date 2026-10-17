// Abonnement au hub via le CURSEUR DE LECTURE SERVEUR (pas de `since` local, pas d'état local) :
//   - GET /messages/wait?auto_ack=false : renvoie les messages non lus (le curseur n'avance pas) ;
//   - un message n'est acké (POST /ack {up_to_id}) qu'APRÈS traitement réussi par onMessage ;
//   - un message non acké (échec, crash, arrêt) est re-livré au prochain appel => aucune perte (at-least-once).
// onMessage(msg) peut retourner une Promise : `false` ou un rejet = non traité (pas d'ack, re-livraison) ;
// toute autre valeur = traité. Le dédoublonnage local (par id) évite de retraiter ce qui est déjà en cours.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HubSubscription {
  constructor({ hubUrl, roomToken, memberToken, onMessage, onRoomName = () => {}, fetchImpl = fetch, log = () => {}, backoffMinMs = 1000, backoffMaxMs = 30000, dupDelayMs = 2000, waitTimeoutMs = 25000 }) {
    Object.assign(this, { hubUrl, roomToken, memberToken, onMessage, onRoomName, fetchImpl, log, backoffMinMs, backoffMaxMs, dupDelayMs, waitTimeoutMs });
    this.tracked = new Map();   // id -> 'pending' | 'done' | 'failed' (messages livrés mais pas encore acquittés)
    this.lastAcked = 0;
    this.ackInFlight = null;
    this.abort = new AbortController();
    this.stopped = false;
    this.started = false;
  }

  get headers() { return { Authorization: `Bearer ${this.memberToken}`, 'Content-Type': 'application/json' }; }
  _signal(ms) { return AbortSignal.any([this.abort.signal, AbortSignal.timeout(ms)]); }
  async _get(p) {
    const r = await this.fetchImpl(`${this.hubUrl}/api/rooms/${this.roomToken}${p}`, { headers: this.headers, signal: this._signal(this.waitTimeoutMs + 15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /** Plus grand id tel que tous les messages livrés <= id sont traités (un 'pending'/'failed' bloque l'ack). */
  watermark() {
    let w = 0;
    for (const id of [...this.tracked.keys()].sort((a, b) => a - b)) {
      if (this.tracked.get(id) !== 'done') break;
      w = id;
    }
    return w;
  }

  /** Ack serveur jusqu'au watermark ; best effort (réessayé à l'itération suivante). */
  async ack() {
    if (this.ackInFlight) { await this.ackInFlight; }
    const id = this.watermark();
    if (id <= this.lastAcked) return;
    this.ackInFlight = (async () => {
      try {
        const r = await this.fetchImpl(`${this.hubUrl}/api/rooms/${this.roomToken}/ack`, {
          method: 'POST', headers: this.headers, body: JSON.stringify({ up_to_id: id }), signal: this._signal(10000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.lastAcked = id;
        for (const k of [...this.tracked.keys()]) if (k <= id) this.tracked.delete(k);
      } catch (e) { if (!this.stopped) this.log(`ack #${id} échoué : ${e.message} (réessayé)`); }
    })();
    try { await this.ackInFlight; } finally { this.ackInFlight = null; }
  }

  _dispatch(msg) {
    this.tracked.set(msg.id, 'pending');
    Promise.resolve()
      .then(() => this.onMessage(msg))
      .then((ok) => ok !== false, (e) => { this.log(`onMessage #${msg.id} : ${e?.message || e}`); return false; })
      .then((ok) => {
        this.tracked.set(msg.id, ok ? 'done' : 'failed'); // 'failed' : bloque l'ack, sera re-livré par le serveur
        if (ok && !this.stopped) this.ack().catch(() => {});
      });
  }

  async start() {
    this.loop = this._run();
    return this;
  }

  async _run() {
    let backoff = this.backoffMinMs;
    while (!this.stopped) {
      try {
        await this.ack();
        this.started = true;
        const r = await this._get(`/messages/wait?timeout=${this.waitTimeoutMs}&auto_ack=false`);
        backoff = this.backoffMinMs;
        const msgs = (r.messages || []).filter((m) => Number.isFinite(m?.id)).sort((a, b) => a.id - b.id);
        const fresh = msgs.filter((m) => { const s = this.tracked.get(m.id); return s !== 'pending' && s !== 'done'; });
        fresh.forEach((m) => this._dispatch(m));
        // Que des messages déjà en cours / traités mais pas encore acquittés : éviter de boucler à vide.
        if (msgs.length && !fresh.length) await sleep(this.dupDelayMs);
      } catch (e) {
        if (this.stopped) break;
        this.log(`hub : ${e.message} ; nouvelle tentative dans ${backoff} ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, this.backoffMaxMs);
      }
    }
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
  }
}
