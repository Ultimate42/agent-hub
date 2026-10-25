import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = '4193';
const PUSH_PORT = 4194;
const BASE = `http://localhost:${PORT}`;
const PUSH_ORIGIN = `http://127.0.0.1:${PUSH_PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-push-'));
const DB = path.join(DIR, 'hub.db');
const b64url = (b) => Buffer.from(b).toString('base64url');
let proc;
let pushServer;
const pushes = [];       // { path, headers, body }
let pushStatus = 201;    // what the fake push service answers

const rest = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const createRoom = async (name) => (await rest('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) })).data.room_token;
const join = async (room, name, role) =>
  (await rest(`/api/rooms/${room}/join`, { method: 'POST', body: JSON.stringify({ name, role }) })).data.member_token;
const postAs = (room, token, content) => rest(`/api/rooms/${room}/messages`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ content })
});

function appClient() {
  let cookie = null;
  const call = async (p, { method = 'GET', body } = {}) => {
    const r = await fetch(BASE + '/app/api' + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { call, cookie: () => cookie };
}

// A browser-side subscription: our own P-256 key pair + auth secret, endpoint on the fake push service
function fakeSubscription(name) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh, auth,
    json: { endpoint: `${PUSH_ORIGIN}/push/${name}`, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) } }
  };
}

// RFC 8291 decryption, written independently of the server code
function decrypt(body, sub) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = sub.ecdh.computeSecret(asPublic);
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const prkKey = hmac(sub.auth, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), sub.ecdh.getPublicKey(), asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, -16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return JSON.parse(plain.subarray(0, -1).toString());
}

function verifyVapid(header, audience) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, 'vapid authorization header');
  const [h, c, sig] = m[1].split('.');
  const pub = Buffer.from(m[2], 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, audience);
  assert.ok(claims.exp > Date.now() / 1000);
  return m[2];
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); }
  return false;
};
const settle = () => new Promise(r => setTimeout(r, 400));

describe('App Web Push', () => {
  let coachRoom, florent, coach, client, sub, threadId;

  before(async () => {
    pushServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(pushStatus).end();
      });
    });
    await new Promise(r => pushServer.listen(PUSH_PORT, '127.0.0.1', r));
    proc = spawn('node', ['src/index.js'], {
      env: { ...process.env, PORT, PUBLIC_URL: BASE, DB_PATH: DB, HUB_RATE_LIMIT_PER_MINUTE: '100000', HUB_PUSH_EXTRA_ORIGINS: PUSH_ORIGIN },
      stdio: 'pipe'
    });
    proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    coachRoom = await createRoom('Coach de vie');
    florent = await join(coachRoom, 'Florent', 'human');
    coach = await join(coachRoom, 'Coach', 'agent');
    client = appClient();
    threadId = (await client.call('/threads', { method: 'POST', body: { member_token: florent } })).data.thread.id;
    sub = fakeSubscription('florent-phone');
  });

  after(async () => {
    await new Promise((res) => { proc.once('exit', res); proc.kill('SIGTERM'); });
    pushServer.close();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  test('VAPID key is generated once and stored next to the DB (mode 600)', async () => {
    const { status, data } = await client.call('/push/key');
    assert.equal(status, 200);
    assert.equal(Buffer.from(data.public_key, 'base64url').length, 65);
    const file = path.join(DIR, 'vapid.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).publicKey, data.public_key);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test('refuses endpoints outside the push services (no SSRF) and bad keys', async () => {
    for (const endpoint of ['https://evil.example/x', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x', 'https://169.254.169.254/x']) {
      const r = await client.call('/push/subscribe', { method: 'POST', body: { ...sub.json, endpoint } });
      assert.equal(r.status, 400, endpoint);
    }
    const r = await client.call('/push/subscribe', { method: 'POST', body: { ...sub.json, keys: { p256dh: 'x', auth: 'y' } } });
    assert.equal(r.status, 400);
    const anon = appClient();
    assert.equal((await anon.call('/push/subscribe', { method: 'POST', body: sub.json })).status, 401);
  });

  test('agent message -> encrypted, VAPID-signed push with minimal content', async () => {
    assert.equal((await client.call('/push/subscribe', { method: 'POST', body: sub.json })).status, 201);
    const pubKey = (await client.call('/push/key')).data.public_key;
    pushes.length = 0;
    await postAs(coachRoom, coach, 'Ton bilan de la semaine est prêt, on en parle ?');
    assert.ok(await until(() => pushes.length === 1));
    const p = pushes[0];
    assert.equal(p.path, '/push/florent-phone');
    assert.equal(p.headers['content-encoding'], 'aes128gcm');
    assert.equal(p.headers.ttl, '86400');
    assert.equal(p.headers.urgency, 'high');
    assert.equal(p.headers.topic, `thread-${threadId}`);
    assert.equal(verifyVapid(p.headers.authorization, PUSH_ORIGIN), pubKey);
    const payload = decrypt(p.body, sub);
    assert.equal(payload.title, 'Coach de vie');
    assert.equal(payload.thread, threadId);
    assert.match(payload.body, /Coach/);
    assert.ok(!JSON.stringify(payload).includes('bilan'), 'no message text without HUB_PUSH_PREVIEW');
  });

  test("no push for the user's own messages", async () => {
    pushes.length = 0;
    await client.call(`/threads/${threadId}/messages`, { method: 'POST', body: { content: 'Oui, ce soir' } });
    await settle();
    assert.equal(pushes.length, 0);
  });

  test('no push while the app is visible; push again once it is hidden or closed', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?app=1`, { headers: { Origin: BASE, Cookie: client.cookie() } });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    pushes.length = 0;
    await postAs(coachRoom, coach, 'visible');
    await settle();
    assert.equal(pushes.length, 0, 'visible app gets it live');

    ws.send(JSON.stringify({ type: 'visibility', visible: false }));
    await settle();
    await postAs(coachRoom, coach, 'hidden');
    assert.ok(await until(() => pushes.length === 1), 'hidden app gets a push');

    ws.close();
    await settle();
    await postAs(coachRoom, coach, 'closed');
    assert.ok(await until(() => pushes.length === 2), 'closed app gets a push');
  });

  test('push service answering 410 removes the subscription', async () => {
    pushes.length = 0;
    pushStatus = 410;
    await postAs(coachRoom, coach, 'gone?');
    assert.ok(await until(() => pushes.length === 1));
    pushStatus = 201;
    await settle();
    await postAs(coachRoom, coach, 'after gone');
    await settle();
    assert.equal(pushes.length, 1);
  });

  test('unsubscribe and logout stop the pushes', async () => {
    assert.equal((await client.call('/push/subscribe', { method: 'POST', body: sub.json })).status, 201);
    assert.equal((await client.call('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.json.endpoint } })).data.unsubscribed, true);
    pushes.length = 0;
    await postAs(coachRoom, coach, 'after unsubscribe');
    await settle();
    assert.equal(pushes.length, 0);

    await client.call('/push/subscribe', { method: 'POST', body: sub.json });
    await client.call('/logout', { method: 'POST', body: {} });
    await postAs(coachRoom, coach, 'after logout');
    await settle();
    assert.equal(pushes.length, 0);
  });
});
