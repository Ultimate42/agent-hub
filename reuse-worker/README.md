# Worker de nettoyage de voix NVIDIA RE-USE

Fait tourner NVIDIA NemotronLabs RE-USE (débruitage de voix, 9,6 M de paramètres) sur un PC distant, piloté par
le hub. Le PC ne fait que des requêtes HTTPS sortantes : aucun port ouvert, aucun Claude Code dessus.

```
manager (VPS) ──POST /api/reuse/jobs──► hub (file durable, baux) ◄──POST /api/reuse/next── PC GPU
                                                                 ◄──POST /api/reuse/next── poste client NVIDIA
```

Plusieurs PC peuvent tirer sur la même file : le premier libre prend le job suivant. C'est le répartiteur.

## Pourquoi ça tourne sur AMD

Le dépôt officiel de RE-USE dépend de `mamba-ssm`, dont le noyau de calcul est écrit pour CUDA, et son script
refuse le processeur (« CPU mode is not supported »). Le worker utilise donc **audio.cpp** (Apache-2.0), un
moteur C++ qui charge les mêmes poids NemotronLabs RE-USE (tenseurs F32 identiques, convertis en GGUF) et
calcule par **Vulkan** : toute carte AMD, NVIDIA ou Intel avec un pilote à jour, sous Windows ou Linux, sans
PyTorch, sans ROCm, sans CUDA. Sans carte utilisable il se replie sur le processeur (lent : ~94 fois le temps
réel mesuré sur 4 cœurs anciens).

Tout ce qui est téléchargé est épinglé par version et empreinte SHA-256 dans `reuse_worker.py` :
audio.cpp v0.9.4 (85 Mo), modèle `reuse-nemotronlabs-f32.gguf` (38 Mo), codec FLAC 1.5.0, Python 3.14.10
portable (Windows).

## Crash test sur le poste client (avant le PC GPU)

À faire exécuter par l'agent du poste client Windows (NVIDIA, DESKTOP-EXAMPLE). Aucun hub, aucun jeton, aucune
inscription au démarrage, aucun droit administrateur : l'essai ne touche que son dossier. À lancer quand aucun
nettoyage RE-USE ne tourne déjà sur la carte (sinon les temps sont faussés).

1. Créer `C:\reuse-test` et y poser deux fichiers de ce dossier : `install-and-run.ps1` et `reuse_worker.py`.
2. Lancer, puis relever le code de sortie :

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\reuse-test\install-and-run.ps1 -CrashTest; echo "code=$LASTEXITCODE"
   ```

   Il installe Python portable, le moteur, le modèle et le codec (environ 150 Mo, empreintes vérifiées), liste
   les cartes, nettoie 2 s de parole sur la carte puis sur le processeur et compare, puis nettoie 10 s par la
   chaîne complète d'un vrai job (FLAC, moteur, FLAC). Durée attendue : 3 à 10 minutes, surtout l'étape
   processeur.

**Réussi** si les quatre conditions sont vraies : `code=0` ; dans `C:\reuse-test\logs\crash-test.json`,
`"ok": true` ; `"backend": "vulkan"` avec le nom de la carte NVIDIA dans `device` ; `selftest.correlation`
au moins 0,98. La valeur `rtf` (secondes de calcul par seconde d'audio) est le chiffre à comparer aux 9 à 13
de la chaîne actuelle du poste client.

**À renvoyer** (texte seulement, jamais de son) : le code de sortie, le contenu de `logs\crash-test.json`, et
les 40 dernières lignes de `logs\worker.log`. En cas d'échec, `error` et `note` du rapport disent pourquoi
(pilote sans Vulkan, téléchargement bloqué, carte qui rend un son faux).

Nettoyage : supprimer `C:\reuse-test`. Une fois le hub déployé, le second essai est l'installation normale
ci-dessous avec le jeton `dev-box` et un morceau court soumis à la file.

Linux : `bash install-and-run.sh --crash-test`, mêmes critères, rapport dans `logs/crash-test.json`.

## Installation sur le PC (une fois)

1. Créer le jeton de la machine côté hub (voir « Déploiement côté hub »).
2. Poser `install-and-run.ps1` (Windows) ou `install-and-run.sh` (Linux) dans un dossier vide, par exemple
   `C:\reuse-worker`.
3. Le lancer : clic droit › « Exécuter avec PowerShell », ou
   `powershell -ExecutionPolicy Bypass -File install-and-run.ps1` (Linux : `bash install-and-run.sh`).
4. Répondre aux deux questions (adresse du hub, jeton). C'est fini.

Le script écrit `reuse-worker.config.json` à côté de lui, installe tout **dans ce dossier** (rien ailleurs,
aucun droit administrateur), s'inscrit au démarrage, puis travaille. Pour préparer la config à la main, copier
`reuse-worker.config.example.json` en `reuse-worker.config.json`.

Au premier démarrage avec une carte graphique, un **autotest** nettoie 2 s de parole sur la carte puis sur le
processeur et compare : si la carte ne rend pas le même son (pilote défaillant), elle n'est pas utilisée et le
hub le voit. Le verdict est mémorisé par carte.

| Fichier | Rôle |
|---|---|
| `reuse-worker.config.json` | adresse du hub, jeton, réglages (jamais dans le dépôt) |
| `logs/worker.log` | journal lisible (5 Mo × 4) |
| `logs/state.json` | état courant : version, carte, job, dernière erreur |
| `STOP` | créer ce fichier vide pour arrêter ; le supprimer pour repartir |
| `app/`, `app.prev/` | programme courant et version précédente (retour arrière) |
| `runtime/` | Python portable, moteur, modèle |
| `work/` | job en cours (reprise après coupure) |

Réglages optionnels de la config : `"backend": "auto" | "vulkan" | "cpu"`, `"device": 0` (numéro de carte,
listé dans le journal), `"threads": 8`, `"low_priority": false`, `"audiocpp_cli": "chemin"` (moteur compilé
sur place).

Désinstaller : `install-and-run.ps1 -RemoveStartup` (Linux : `--remove-startup`), puis supprimer le dossier.

## Ce qui se passe sans intervention

- **Redémarrage du PC, plantage, fermeture** : sous Windows une tâche planifiée de l'utilisateur relance le
  script s'il ne tourne pas (vérification toutes les 5 minutes, à partir de l'ouverture de session) ; sous
  Linux un service utilisateur systemd (`Restart=always`).
- **Coupure en plein job** : au redémarrage le hub rend le même job à la même machine tant que son bail tient ;
  un résultat déjà calculé est envoyé sans recalcul. Si le PC reste éteint, le bail expire (10 min sans signe
  de vie) et une autre machine prend le job.
- **Hub ou réseau coupé** : le calcul continue, le résultat part au retour du réseau.
- **Mise à jour** : à chaque démarrage puis à chaque échange avec le hub, le worker compare sa version à celle
  publiée. Il télécharge la nouvelle, vérifie l'empreinte SHA-256 de chaque fichier et la syntaxe, garde
  l'ancienne dans `app.prev`, puis se relance. Une version qui plante trois fois au démarrage est annulée :
  retour à la précédente, et elle n'est plus réessayée tant que le hub n'en publie pas une autre. La
  vérification de mise à jour passe avant tout le reste : publier un correctif répare donc une machine bloquée.
  Quand la file est pleine, la mise à jour se fait entre deux jobs, sans attendre que la file soit vide.
- **Résultat refusé par le hub** (trop gros, par exemple) : la machine rend le job en comptant l'essai, au lieu
  de le recalculer sans fin ; au bout de trois essais le job passe en échec.
- **Moteur en panne sur une machine** : elle attend de plus en plus longtemps entre deux essais au lieu
  d'épuiser les trois essais de chaque job.

## Piloter à distance (jeton admin)

```bash
H=https://hub.example.com; A="Authorization: Bearer $HUB_REUSE_ADMIN_TOKEN"
# soumettre un morceau (FLAC mono, sortie de project-audio/pipeline/01_prepare_reuse.sh)
curl -X POST -H "$A" --data-binary @extrait01_000.flac "$H/api/reuse/jobs?batch=extrait01&name=extrait01_000.flac"
curl -H "$A" "$H/api/reuse/jobs?batch=extrait01"            # avancement, vitesse mesurée, temps restant
curl -H "$A" -o extrait01_000_clean.flac "$H/api/reuse/jobs/12/output"
curl -H "$A" "$H/api/reuse/workers"                         # machines : en ligne, carte, version, état, vitesse
curl -X POST -H "$A" -H 'Content-Type: application/json' -d '{"pause":true}'  "$H/api/reuse/workers/gpu-box/order"
curl -X POST -H "$A" -H 'Content-Type: application/json' -d '{"pause":false}' "$H/api/reuse/workers/gpu-box/order"
curl -X POST -H "$A" -H 'Content-Type: application/json' -d '{"update":true}' "$H/api/reuse/workers/gpu-box/order"
curl -X POST -H "$A" "$H/api/reuse/jobs/12/retry"           # ou /cancel
curl -X DELETE -H "$A" "$H/api/reuse/batches/extrait01"     # libère le disque du hub une fois les sorties récupérées
```

Options d'un job : `priority=5` (passe devant), `chunk_s` et `overlap_s` (découpage interne du modèle ; par
défaut 5 s avec recouvrement de 2,5 s, le réglage du script officiel de NVIDIA pour les longs fichiers).

La pause laisse finir le job en cours puis n'en donne plus. `update` force une revérification des fichiers et
un redémarrage, une seule fois.

**Publier une nouvelle version du worker** : remplacer les fichiers de ce dossier sur le serveur du hub. La
version est l'empreinte du contenu ; aucun numéro à incrémenter, aucun redémarrage du hub. Les machines la
prennent en moins d'une minute (à la fin du job en cours). `GET /api/reuse/workers` montre `up_to_date` et, si
une machine a dû revenir en arrière, `info.rolled_back_from`.

## Ce que le hub garantit

- Un job n'est donné qu'à une machine à la fois ; trois essais, puis `failed` avec la raison (`error`).
- Un résultat n'est accepté que s'il est un nettoyage fidèle : FLAC mono, fréquence au moins égale à l'entrée et
  jamais sous 24 kHz, durée égale à 50 ms près, empreinte du transfert vérifiée, différent de l'entrée.
- Soumettre deux fois le même morceau ne crée pas de doublon ; un même nom avec un son différent est refusé.

## Déploiement côté hub

Variables d'environnement du service (jamais dans le dépôt) :

```
HUB_REUSE_ADMIN_TOKEN=<32 caractères aléatoires>                 # le manager
HUB_REUSE_WORKER_TOKENS=gpu-box:<jeton>,dev-box:<jeton>            # un jeton par machine, révocable en retirant l'entrée
# optionnels : HUB_REUSE_DIR (audio en file, défaut <dossier de la base>/reuse), HUB_REUSE_WORKER_DIR (défaut ce dossier),
#              HUB_REUSE_MAX_FILE_SIZE (32 Mo par fichier), HUB_REUSE_MAX_STORAGE (6 Go en tout), HUB_REUSE_LEASE_SECONDS (600)
```

Sans ces variables, toutes les routes `/api/reuse/*` répondent 404. Générer un jeton :
`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.

Si un reverse proxy limite la taille des requêtes, autoriser 32 Mo sur `/api/reuse/`. Le hub garde les sources
et les résultats sur disque (environ 230 Mo par heure d'audio) jusqu'au `DELETE` du lot ; au-delà de 6 Go en
tout, il refuse les nouveaux morceaux (507) plutôt que de remplir le disque ; un résultat qui ferait dépasser
ce plafond est refusé de la même façon, sans compter d'essai (la machine le garde et le renvoie une fois la
place faite). Le jeton est vérifié avant la lecture du corps : sans jeton valide, rien n'est gardé en mémoire.

Au démarrage, le hub nettoie ce dossier : fichiers `<id>.in.flac` / `<id>.out.flac` sans job correspondant et
écritures interrompues sont supprimés (journal « orphan files removed »), et un job en attente dont la source a
disparu passe en échec. Un seul hub par dossier `HUB_REUSE_DIR` : un second hub, avec une autre base, y
verrait des orphelins.

## Limites connues

- Linux : les binaires audio.cpp v0.9.4 demandent glibc 2.43 (Ubuntu 26.04 ou plus récent).
- Le lanceur Windows n'a été exécuté que sous PowerShell 7 pour Linux (installation, boucle, mise à jour,
  retour arrière) : la tâche planifiée et l'installation de Python portable restent à voir sur un vrai Windows.
- La mise à jour est protégée par HTTPS, le jeton et les empreintes, pas par une signature : qui contrôle le
  serveur du hub contrôle le code exécuté sur les PC.
- Le lanceur lui-même (`install-and-run.*`) est mis à jour après contrôle de syntaxe, sans retour arrière
  automatique : le garder minimal.
- Sortie en 16 bits (ce qu'écrit audio.cpp), à la fréquence de l'entrée.
