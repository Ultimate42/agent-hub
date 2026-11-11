#!/usr/bin/env bash
# Worker de nettoyage de voix NVIDIA RE-USE - lanceur Linux.
#
# UN SEUL FICHIER À LANCER. Le poser dans un dossier vide (ex. ~/reuse-worker), puis :
#     bash install-and-run.sh
#
# Au premier lancement il demande l'adresse du hub et le jeton de cette machine, les écrit dans
# reuse-worker.config.json (à côté), installe tout dans ce dossier (moteur, modèle), s'inscrit comme
# service utilisateur systemd, puis travaille en boucle : il réclame un job au hub, nettoie, renvoie,
# recommence. Il se met à jour seul et se relance seul.
#
#   --no-startup      ne pas s'inscrire au démarrage      --remove-startup  retirer l'inscription et sortir
#   Arrêter : créer un fichier nommé STOP dans le dossier (le supprimer pour repartir).
#   Journal : logs/worker.log      État : logs/state.json
#   --crash-test      essai complet sans hub ni jeton (reuse_worker.py posé à côté) : rapport logs/crash-test.json
#   --fingerprint     afficher l'empreinte du jeton de cette machine (le crée s'il n'existe pas) et sortir
#   Prérequis : python3 (>= 3.9), flac ou ffmpeg, pilote Vulkan de la carte (Mesa RADV pour AMD),
#   glibc >= 2.43 (Ubuntu 26.04 ou plus récent).
#
# Ce fichier reste volontairement court : toute la logique est dans app/reuse_worker.py, que le hub
# met à jour. Ici : premier téléchargement, relance, retour arrière.
set -u
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$BASE/$(basename "${BASH_SOURCE[0]}")"
CONFIG="$BASE/reuse-worker.config.json"
APP="$BASE/app"; PREV="$BASE/app.prev"
UNIT="reuse-worker.service"
mkdir -p "$BASE/logs"

say() { local line; line="$(date '+%Y-%m-%d %H:%M:%S') | LANCEUR | $*"; echo "$line"; echo "$line" >> "$BASE/logs/worker.log"; }

STARTUP=1; CRASH_TEST=0; FINGERPRINT=0
for arg in "$@"; do
  case "$arg" in
    --no-startup) STARTUP=0 ;;
    --crash-test) CRASH_TEST=1 ;;
    --fingerprint) FINGERPRINT=1 ;;
    --remove-startup)
      systemctl --user disable --now "$UNIT" 2>/dev/null; rm -f "$HOME/.config/systemd/user/$UNIT"
      systemctl --user daemon-reload 2>/dev/null; say "Inscription au démarrage retirée."; exit 0 ;;
  esac
done

PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || { say "python3 introuvable : l'installer (sudo apt install python3)."; exit 2; }

# Essai sans hub : aucun jeton, aucune inscription au démarrage. Code 0 = réussi.
if [ "$CRASH_TEST" = 1 ]; then
  SCRIPT="$APP/reuse_worker.py"; [ -f "$SCRIPT" ] || SCRIPT="$BASE/reuse_worker.py"
  [ -f "$SCRIPT" ] || { say "Essai impossible : poser reuse_worker.py à côté de ce script."; exit 2; }
  exec "$PYTHON" "$SCRIPT" --base "$BASE" --crash-test
fi

# Écrit la config. Sans jeton fourni, il est créé ici : il ne quitte jamais ce dossier.
write_config() {  # $1 = adresse du hub, $2 = jeton (vide = en créer un)
  ( umask 077; HUB_URL="${1:-https://hub.example.com}" HUB_TOKEN="$2" "$PYTHON" -c '
import json, os, secrets, sys
token = os.environ["HUB_TOKEN"].strip() or secrets.token_urlsafe(32)
json.dump({"hub_url": os.environ["HUB_URL"].strip(), "token": token, "backend": "auto"}, open(sys.argv[1], "w"), indent=1)' "$CONFIG" ) \
    || { say "Config impossible à écrire : $CONFIG"; exit 2; }
  say "Config écrite : $CONFIG"
}

# Seule l'empreinte SHA-256 du jeton est affichée, à déclarer au hub sous la forme nom:sha256:...
# (elle ne permet pas de retrouver le jeton).
show_fingerprint() {
  local fp
  fp="$("$PYTHON" -c '
import hashlib, json, sys
token = str(json.load(open(sys.argv[1], encoding="utf-8-sig")).get("token") or "").strip()
if not token: sys.exit(1)
print("sha256:" + hashlib.sha256(token.encode()).hexdigest())' "$CONFIG" 2>/dev/null)" || { say "Config illisible ou sans jeton : $CONFIG"; exit 2; }
  say "Empreinte à déclarer au hub (ce n'est pas le jeton) : $fp"
}

# Empreinte du jeton de cette machine, sans rien lancer. Le jeton est créé s'il n'y a pas encore de config.
if [ "$FINGERPRINT" = 1 ]; then
  [ -f "$CONFIG" ] || write_config "" ""
  show_fingerprint
  exit 0
fi

if [ ! -f "$CONFIG" ]; then
  [ -t 0 ] || { say "Config absente : $CONFIG. Lancer ce script une fois à la main pour la créer."; exit 2; }
  echo; echo "Première installation du worker RE-USE."
  read -r -p "Adresse du hub (Entrée = https://hub.example.com) : " HUB_URL
  read -r -s -p "Jeton de cette machine (Entrée = en créer un ici) : " HUB_TOKEN; echo
  write_config "$HUB_URL" "$HUB_TOKEN"
  if [[ "$HUB_TOKEN" =~ ^[[:space:]]*$ ]]; then
    show_fingerprint
    say "Le worker réessaie seul chaque minute jusqu'à ce que le hub connaisse cette empreinte."
  fi
fi

# Service utilisateur systemd : relancé après un plantage et au démarrage de la machine (linger)
install_startup() {
  command -v systemctl >/dev/null 2>&1 || { say "systemd absent : pas d'inscription au démarrage."; return; }
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/$UNIT" <<UNITEOF
[Unit]
Description=Nettoyage de voix RE-USE piloté par le hub
After=network-online.target

[Service]
ExecStart=/usr/bin/env bash "$SELF" --no-startup
WorkingDirectory=$BASE
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
UNITEOF
  systemctl --user daemon-reload && systemctl --user enable "$UNIT" >/dev/null 2>&1 \
    && say "Inscrit au démarrage (service utilisateur $UNIT)." || say "Inscription au démarrage impossible. Le worker tourne quand même."
  loginctl enable-linger "$USER" 2>/dev/null || say "Sans « loginctl enable-linger $USER », le service ne démarre qu'à l'ouverture de session."
}

# Un seul lanceur à la fois par dossier
exec 9>"$BASE/.lock"
flock -n 9 || exit 0

[ "$STARTUP" = 1 ] && install_startup

# Premier téléchargement du programme (ensuite il se met à jour lui-même) : manifeste du hub,
# chaque fichier vérifié par son empreinte, mis en place seulement si tout est bon.
install_app() {
  rm -rf "$BASE/app.new"
  "$PYTHON" - "$CONFIG" "$BASE/app.new" <<'PYEOF'
import hashlib, json, os, re, sys, urllib.request
cfg = json.load(open(sys.argv[1], encoding='utf-8-sig'))
hub, dest = cfg['hub_url'].rstrip('/'), sys.argv[2]
def get(path):
    req = urllib.request.Request(hub + path, headers={'User-Agent': 'reuse-worker'})
    req.add_unredirected_header('Authorization', 'Bearer ' + cfg['token'])  # jamais recopié vers une redirection
    return urllib.request.urlopen(req, timeout=120).read()
manifest = json.loads(get('/api/reuse/worker/manifest'))
os.makedirs(dest)
for f in manifest['files']:
    if not re.fullmatch(r'[\w.-]+', f['name']):
        sys.exit('nom de fichier refusé : %r' % f['name'])
    data = get('/api/reuse/worker/files/' + f['name'])
    if hashlib.sha256(data).hexdigest() != f['sha256']:
        sys.exit('empreinte incorrecte pour ' + f['name'])
    open(os.path.join(dest, f['name']), 'wb').write(data)
if not os.path.exists(os.path.join(dest, 'reuse_worker.py')):
    sys.exit('le hub ne publie pas reuse_worker.py')
open(os.path.join(dest, 'version.txt'), 'w').write(manifest['version'])
PYEOF
  local rc=$?
  [ $rc = 0 ] && mv "$BASE/app.new" "$APP" && say "Programme installé (version $(cat "$APP/version.txt"))."
  return $rc
}

# Une version qui plante au démarrage est notée mauvaise et remplacée par la précédente
undo_version() {
  local bad; bad="$(cat "$APP/version.txt" 2>/dev/null || echo inconnue)"
  echo "$bad" >> "$BASE/bad-versions.txt"
  rm -rf "$BASE/app.bad"; mv "$APP" "$BASE/app.bad"
  if [ -d "$PREV" ]; then
    mv "$PREV" "$APP"
    say "La version $bad plante au démarrage : retour à la version $(cat "$APP/version.txt" 2>/dev/null). Fichiers fautifs gardés dans app.bad."
  else
    say "La version $bad plante au démarrage et il n'y a pas de version précédente : nouveau téléchargement dans 5 minutes."
    sleep "${REUSE_RETRY_LONG:-300}"
  fi
}

fails=0
while true; do
  [ -e "$BASE/STOP" ] && { say "Fichier STOP présent : arrêt. Le supprimer pour repartir."; break; }
  if [ ! -f "$APP/reuse_worker.py" ] && ! install_app; then
    say "Installation impossible pour l'instant. Nouvel essai dans 60 s."
    sleep "${REUSE_RETRY:-60}"; continue
  fi
  started=$(date +%s)
  "$PYTHON" "$APP/reuse_worker.py" --base "$BASE" --launcher "$SELF"
  code=$?
  case $code in
    0) break ;;                                   # arrêt demandé
    42) fails=0; continue ;;                      # mise à jour installée : relancer tout de suite
    43) say "Lanceur mis à jour : relance."; exec 9>&-; exec bash "$SELF" --no-startup ;;
    2) say "Config refusée (voir le message ci-dessus). Nouvel essai dans 5 minutes."; sleep "${REUSE_RETRY_LONG:-300}"; continue ;;
    3) say "Installation du moteur incomplète (voir ci-dessus). Nouvel essai dans 60 s."; sleep "${REUSE_RETRY:-60}"; continue ;;
  esac
  # Plantage. Une version n'est jugée mauvaise que si elle n'a jamais fini de démarrer (pas de app/.ok).
  if [ $(( $(date +%s) - started )) -lt 300 ] && [ ! -e "$APP/.ok" ]; then fails=$((fails + 1)); else fails=0; fi
  say "Le worker s'est arrêté (code $code). Relance dans 15 s."
  [ $fails -ge 3 ] && { undo_version; fails=0; }
  sleep "${REUSE_RESTART:-15}"
done
