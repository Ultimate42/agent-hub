#!/usr/bin/env node
// Poste un message dans le salon depuis une session d'agent (contenu lu sur stdin ; le token reste dans son fichier).
// usage : node hub-post.mjs --hub URL --room ROOM_TOKEN_OU_FICHIER --token-file FICHIER [--reply-to ID] [--type message] < texte
import fs from 'node:fs';
import { readSecretFile } from './lib.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const hub = (arg('hub') || 'http://localhost:4030').replace(/\/$/, '');
let room = arg('room');
if (room && fs.existsSync(room)) room = readSecretFile(room);
const token = readSecretFile(arg('token-file'));
const content = fs.readFileSync(0, 'utf8').trim();
if (!room || !token || !content) { console.error('usage: hub-post.mjs --hub URL --room TOKEN|FILE --token-file FILE [--reply-to ID] < texte'); process.exit(2); }
const body = { content, type: arg('type') || 'message', ...(arg('reply-to') ? { reply_to: Number(arg('reply-to')) } : {}) };
const r = await fetch(`${hub}/api/rooms/${room}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
console.log(r.ok ? 'envoyé' : `échec HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
process.exit(r.ok ? 0 : 1);
