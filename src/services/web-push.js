import crypto from 'crypto';

// Minimal Web Push sender (no dependency): VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291 / 8188).

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64url = (s) => Buffer.from(String(s), 'base64url');

export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

/** Throws if the pair is not a valid P-256 key pair (65-byte uncompressed public, 32-byte private). */
export function checkVapidKeys({ publicKey, privateKey }) {
  const pub = fromB64url(publicKey);
  const priv = fromB64url(privateKey);
  if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) throw new Error('Invalid VAPID key format');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(priv);
  if (!ecdh.getPublicKey().equals(pub)) throw new Error('VAPID public key does not match the private key');
}

function vapidSigningKey({ publicKey, privateKey }) {
  const pub = fromB64url(publicKey);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), d: privateKey }
  });
}

/** Authorization header for one push service origin (JWT valid 12 h). */
export function vapidAuthorization(endpoint, vapid, now = Date.now()) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: vapid.subject
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: vapidSigningKey(vapid), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${vapid.publicKey}`;
}

const hkdf = (salt, ikm, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

/**
 * Encrypt a payload for one subscription (single aes128gcm record).
 * @param {Buffer|string} payload  at most ~3.9 KB
 * @param {{p256dh: string, auth: string}} keys  from PushSubscription.toJSON().keys
 */
export function encryptPayload(payload, keys, { salt = crypto.randomBytes(16), ecdh } = {}) {
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Invalid subscription keys');

  const local = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last record
  const recordSize = 4096;
  if (plain.length + 16 > recordSize) throw new Error('Push payload too large');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/**
 * Send one push message. Resolves with the push service HTTP status (201 expected; 404/410 = gone).
 * @param {{endpoint: string, p256dh: string, auth: string}} sub
 * @param {{publicKey, privateKey, subject}} vapid
 * @param {object} opts { ttl (s), urgency, topic (<= 32 url-safe chars, replaces a pending message) }
 */
export async function sendPush(sub, payload, vapid, { ttl = 86400, urgency = 'high', topic, timeoutMs = 10000 } = {}) {
  const headers = {
    Authorization: vapidAuthorization(sub.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency
  };
  if (topic) headers.Topic = topic;
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers,
    body: encryptPayload(payload, sub),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  });
  await res.arrayBuffer().catch(() => {});
  return res.status;
}
