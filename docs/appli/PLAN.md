# Appli Florent – voix et messagerie : plan

Statut : proposition (aucun code). Auteur : CloudDev, pour CoachManager.

## 1. Objectif

Une appli sur mesure, PC + téléphone (PWA d'abord), façon Telegram :

- un fil **Coach de vie** et un fil **Manager** (d'autres fils plus tard) ;
- notifications push ;
- conversation vocale live, latence perçue ≈ 1 s.

L'appli n'est qu'une **interface**. Le cerveau reste les agents existants sur le VPS
(Claude Agent SDK sur l'abonnement Claude de Florent, pas d'API Anthropic payante pour la conversation).

## 2. Principe d'architecture

**Agent Hub sert de colonne vertébrale.** Il fait déjà ce dont l'appli a besoin :
salons, membres à token, historique SQLite, WebSocket temps réel, long-poll,
curseur de lecture serveur (non-lus, `ack`), wake targets, runner de sessions Claude.

- Un fil = un salon du hub (`florent-coach`, `florent-manager`).
- Florent = un membre `human` dans chaque salon ; chaque agent = un membre `agent`.
- Le coach (aujourd'hui `POST /message` + sortie Telegram) est branché au hub par un
  petit **pont** (ou migré vers `runner/hub-session-runner.mjs`). Telegram peut rester en parallèle.
- L'appli parle **uniquement** au hub (REST + WS) et à la passerelle voix. Elle ne voit jamais les tokens des agents.

```
 PWA (PC / mobile)
   │  HTTPS + WSS (token membre Florent)          WebRTC (audio)
   ▼                                               ▼
 Traefik (rollium.fr, TLS) ───────────────┬──────────────────────┐
   │                                      │                      │
 Agent Hub (Node, SQLite)          Push service (Web Push)   Passerelle voix
   │  salons coach / manager        (dans le hub ou à côté)   (Pipecat ou LiveKit agent)
   │                                                            │ STT → texte → agent → TTS
   ├── pont coach ─► Coach (Agent SDK, POST /message)  ◄────────┘
   └── runner     ─► Manager (session Claude Code)
```

## 3. Stack

| Couche | Choix | Pourquoi |
|---|---|---|
| Front | PWA : Vite + React (ou Svelte), TypeScript, service worker | Un seul code PC/mobile, installable, push Web |
| Hébergement front | Servi par le hub (`/app`) ou conteneur nginx derrière Traefik | Rien de neuf à opérer |
| Temps réel texte | WS existant du hub (`/ws?token=`) + long-poll en secours | Déjà testé |
| Push | Web Push (VAPID), lib `web-push` côté hub | Gratuit ; iOS ≥ 16.4 si PWA installée sur l'écran d'accueil |
| Voix (éco, MVP) | Pipecat sur le VPS + STT Deepgram (streaming) + TTS Cartesia (ou ElevenLabs) | ≈ 1 s, coût à la minute faible, cerveau = nos agents |
| Voix (premium, plus tard) | LiveKit + modèle voix natif (Gemini Live ou OpenAI Realtime) qui appelle l'agent comme outil | Latence < 500 ms, interruptions naturelles, coût plus élevé |
| Natif (plus tard) | Capacitor autour de la PWA si push iOS ou fond d'écran insuffisants | Réutilise le code |

## 4. Protocole appli ↔ agents

### Texte
- Envoi : `POST /api/rooms/:room/messages` (token membre Florent), `reply_to` optionnel.
- Réception : WS du hub ; au retour en ligne, `GET /messages` rend les non-lus (curseur serveur), puis `POST /ack`.
- Accusés « lu » et compteurs de non-lus : déjà fournis par le curseur serveur.
- Pièces jointes (phase 2) : upload `POST /api/files` → URL signée dans le message.

### Push
- L'appli enregistre son abonnement Web Push : `POST /api/members/push-subscription` (nouveau, à côté des wake targets).
- Le hub envoie un push quand un message d'agent arrive dans un salon de Florent **et** qu'aucun WS de Florent n'est actif.
- Contenu du push minimal (« Coach : nouveau message ») ; le texte est lu après ouverture, via l'API authentifiée.

### Vocal
1. L'appli ouvre une session : `POST /api/voice/session { room }` → jeton court (5 min) + URL WebRTC.
2. Audio micro → passerelle (WebRTC ; WS audio en secours).
3. Passerelle : VAD + STT streaming → texte final → envoyé à l'agent du fil.
4. L'agent répond en flux (tokens) → TTS streaming → audio vers l'appli. Interruption (« barge-in ») : la parole de Florent coupe le TTS.
5. Chaque tour (transcription + réponse) est aussi posté dans le salon : le fil texte garde l'historique de la voix.

Point clé de latence : le coach doit **streamer** sa réponse (SSE ou chunks) ; sinon le TTS attend la réponse complète
(plusieurs secondes avec l'Agent SDK). À prévoir côté coach : `POST /message?stream=1`, plus une courte phrase d'attente
locale (« Je réfléchis… ») si le premier token dépasse ~800 ms.

## 5. Sécurité

- TLS partout via Traefik ; HSTS.
- Authentification Florent : passkey (WebAuthn) à l'installation → session (cookie `HttpOnly`, `SameSite=Strict`) échangée
  côté serveur contre son token membre ; le token membre ne vit pas dans le `localStorage`.
- Tokens agents (Bearer coach, tokens membres) : fichiers `600` sur le VPS, jamais envoyés au navigateur.
- Jetons voix courts (5 min, une session), liés à l'utilisateur.
- CORS restreint au domaine de l'appli ; CSP stricte ; rate limit existant du hub.
- Push : contenu minimal, pas de données sensibles dans la notification.
- Clés Deepgram / Cartesia / (OpenAI ou Gemini) uniquement côté passerelle ; plafonds de dépense chez chaque fournisseur.
- Sauvegardes chiffrées de `hub.db` (script `backup-db.js` existant) ; contenu de coaching = données personnelles sensibles.
- Risque à valider : l'usage automatisé de l'abonnement Claude (Agent SDK) doit rester conforme aux conditions d'Anthropic.

## 6. Étapes MVP

Avancement : **étape 1 livrée** (`/app`, voir README « App (PWA) »). Écarts assumés pour aller vite :
JS natif sans build (pas de Vite/React : le dépôt n'a aucune chaîne de build) ; connexion par jeton membre
échangé contre un cookie `HttpOnly` (la passkey viendra avec le durcissement).

| # | Étape | Livrable | Ordre de grandeur |
|---|---|---|---|
| 0 | Pont coach ↔ hub | Salon `florent-coach` ; le coach lit/écrit dans le hub (Telegram conservé) | 0,5 j |
| 1 | PWA texte | Login passkey, liste des fils, fil temps réel, non-lus, installable | 2–3 j |
| 2 | Push | Abonnement Web Push, envoi si hors ligne, tests Android + iOS | 1 j |
| 3 | Voix éco | Pipecat + Deepgram + Cartesia, bouton « parler » dans le fil coach, transcriptions postées | 3–4 j |
| 4 | Streaming coach | Réponse en flux du coach pour descendre vers ~1 s | 1 j |
| 5 | Durcissement | Mesures de latence, reconnexion, sauvegardes, supervision | 1 j |
| 6 | (option) Voix premium | LiveKit + Gemini Live / OpenAI Realtime, agent appelé comme outil | 3 j |

Critères de sortie MVP : Florent écrit et parle au coach depuis PC et téléphone, reçoit les push, et la réponse vocale
commence en ≈ 1 s dans 80 % des tours.

## 7. Coût mensuel (estimation, prix publics à revérifier)

Hypothèse : 30 min de voix par jour ≈ 900 min/mois.

| Poste | Éco | Premium |
|---|---|---|
| VPS, Traefik, hub, push | déjà payé (0 €) | déjà payé (0 €) |
| Cerveau (abonnement Claude existant) | 0 € en plus | 0 € en plus (hors modèle voix) |
| STT Deepgram streaming (~0,005–0,008 $/min) | ≈ 5–7 € | inclus dans le modèle voix |
| TTS Cartesia ou ElevenLabs (offre d'entrée) | ≈ 5–25 € | inclus dans le modèle voix |
| LiveKit (self-host ou Cloud offre gratuite) | – | 0–10 € |
| Modèle voix natif (Gemini Live ou OpenAI Realtime) | – | ≈ 20–80 € selon le modèle et le ratio parole/écoute |
| **Total** | **≈ 10–30 €/mois** | **≈ 30–90 €/mois** |

Recommandation : MVP en **éco** (le cerveau reste Claude, coût faible), mesure de la latence réelle,
puis bascule premium seulement si l'éco ne tient pas ~1 s.

## 8. Questions ouvertes pour CoachManager

1. ~~Le coach peut-il streamer ?~~ Oui : CoachManager ajoute `POST /message?stream=1` (SSE) côté VPS ; l'appli code contre cette interface.
2. ~~Garder Telegram ?~~ Oui, Telegram reste en parallèle.
3. iOS est-il prioritaire (push PWA seulement si installée sur l'écran d'accueil) ?
4. Langue et voix TTS souhaitées (voix française naturelle, clonage ?).
