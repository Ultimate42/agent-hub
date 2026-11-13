#!/usr/bin/env python3
"""Worker de nettoyage de voix NVIDIA RE-USE, piloté par le hub (file /api/reuse).

Bibliothèque standard seule (Python >= 3.9). Lancé en boucle par install-and-run.ps1 / .sh.
Le PC ne fait que des requêtes HTTPS sortantes : il réclame un job, télécharge le FLAC, le nettoie
avec audio.cpp (poids NemotronLabs RE-USE, GPU via Vulkan : AMD, NVIDIA ou Intel ; repli CPU),
renvoie le FLAC nettoyé, recommence. Il se met à jour seul depuis le hub.

Codes de sortie (lus par le lanceur) :
  0  arrêt demandé (fichier STOP)        2  config absente ou refusée        3  moteur pas encore installable
  42 mise à jour installée, relancer     43 le lanceur lui-même a été mis à jour, le relancer
  autre  plantage (le lanceur relance ; trois plantages au démarrage = retour à la version précédente)
"""
import argparse
import base64
import array
import hashlib
import json
import logging
import logging.handlers
import os
import platform
import py_compile
import re
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

EXIT_STOP, EXIT_NOT_READY, EXIT_UPDATED, EXIT_LAUNCHER_UPDATED = 0, 3, 42, 43
IS_WINDOWS = os.name == 'nt'
LAUNCHERS = ('install-and-run.ps1', 'install-and-run.sh')

# --------------------------------------------------------------------------------------------
# Ce que le worker installe : versions et empreintes épinglées (rien n'est exécuté sans vérification)
# --------------------------------------------------------------------------------------------
AUDIOCPP_VERSION = 'v0.9.4'
AUDIOCPP_URL = 'https://github.com/0xShug0/audio.cpp/releases/download/' + AUDIOCPP_VERSION + '/'
AUDIOCPP_ASSETS = {  # système -> (fichier, sha256). Le paquet Vulkan contient aussi le calcul sur processeur (repli).
    'windows': ('audio-v0.9.4-bin-windows-x64-vulkan-portable.zip', '295ca309160e59ec3ce3cff0e07edb6709e28d43b4c0a5ad76760938ae6a4e5c'),
    'linux': ('audio-v0.9.4-bin-ubuntu-x64-vulkan-portable.tar.gz', '82808683beb5da2987abbdca5ba3b93622eb93568eda8d92acf1f7314a26dbab'),
}
# Poids NemotronLabs RE-USE (licence OpenMDW-1.1), tenseurs F32 identiques à ceux de NVIDIA
MODEL_NAME = 'reuse-nemotronlabs-f32.gguf'
MODEL_URL = 'https://huggingface.co/audio-cpp/RE-USE-GGUF/resolve/2619b5cc7dcbc0235915104a293d7b94b3b8a1fc/' + MODEL_NAME
MODEL_SHA256 = '81f47a42fe9e67e123b9a2c16803193d4d28438432ef4a0a063692615f0913f3'
# Extrait de parole officiel de NVIDIA, pour l'autotest GPU contre CPU
SELFTEST_URL = 'https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE/resolve/31f82f2efad1095034492f236e8dac9239ba713b/noisy_audio/mic_test2.wav'
SELFTEST_SHA256 = 'e6433420a00163f30a339fc83a191517a82597cf2141cbd310233470e83ce0d7'
SELFTEST_SECONDS = 2.0
SELFTEST_MIN_CORRELATION = 0.98
FLAC_WIN_URL = 'https://github.com/xiph/flac/releases/download/1.5.0/flac-1.5.0-win.zip'
FLAC_WIN_SHA256 = '53f1500f0d6e7c61379d7fee50d4a9f7f504c650009506d9ba015530d76c0dde'

# Découpage par défaut = réglage officiel de NVIDIA pour les longs fichiers (inference_chunk.sh :
# morceaux de 5 s, recouvrement de moitié). Le hub peut imposer d'autres valeurs par job.
DEFAULT_CHUNK_S = 5.0
DEFAULT_OVERLAP_S = 2.5
MIN_RATE = 24000
MAX_LENGTH_DRIFT_S = 0.05

log = logging.getLogger('reuse')


class JobLost(Exception):
    """Le hub a repris le job (bail perdu, job annulé) : on abandonne sans rien renvoyer."""


class Refused(Exception):
    """Le hub a refusé définitivement une requête (4xx) : inutile de réessayer."""
    def __init__(self, status, message):
        super().__init__('%s (HTTP %s)' % (message, status))
        self.status = status


# --------------------------------------------------------------------------------------------
# Petits outils
# --------------------------------------------------------------------------------------------
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, data):
    tmp = Path(str(path) + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return default


def rmtree(path):
    shutil.rmtree(path, ignore_errors=True)


def safe_file_name(name):
    """Nom de fichier publié par le hub, selon la même règle que lui : lettres ASCII, chiffres, « _ . - »,
    120 caractères au plus, sans point en tête (ni dossier, ni lecteur « C: », ni flux « a:b » de Windows)."""
    return isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}', name) is not None


# Contrôle de syntaxe d'un lanceur PowerShell. Le chemin passe par une variable d'environnement, jamais dans le
# texte de la commande : aucun caractère du chemin ($, accent grave, apostrophe, guillemet) ne peut y être interprété.
PS_CHECK_VAR = 'REUSE_PS1_TO_CHECK'
PS_CHECK = ('$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:%s,[ref]$null,[ref]$e);'
            'if($e.Count){exit 1}' % PS_CHECK_VAR)


def fmt_duration(seconds):
    seconds = int(round(seconds))
    if seconds < 90:
        return '%d s' % seconds
    if seconds < 5400:
        return '%d min %02d s' % divmod(seconds, 60)
    return '%d h %02d min' % divmod(seconds // 60, 60)


def download(url, dest, expected_sha256, what, headers=None):
    """Télécharge vers dest (repris depuis zéro à chaque essai), vérifie l'empreinte avant de mettre en place."""
    dest = Path(dest)
    if dest.exists() and sha256_file(dest) == expected_sha256:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(dest) + '.part')
    delay = 5
    for attempt in range(1, 7):
        try:
            log.info('Téléchargement : %s', what)
            req = urllib.request.Request(url, headers=dict({'User-Agent': 'reuse-worker'}, **(headers or {})))
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, 'wb') as f:
                shutil.copyfileobj(r, f, 1 << 20)
            got = sha256_file(tmp)
            if got != expected_sha256:
                raise ValueError('empreinte inattendue pour %s (%s…)' % (what, got[:12]))
            os.replace(tmp, dest)
            return dest
        except (OSError, ValueError) as e:  # URLError hérite de OSError
            log.warning('Téléchargement de %s : essai %d raté (%s)', what, attempt, e)
            if attempt == 6:
                raise RuntimeError('impossible de télécharger %s : %s' % (what, e))
            time.sleep(delay)
            delay = min(delay * 2, 120)


def safe_extract(archive, dest):
    """Décompresse zip ou tar.gz en refusant tout chemin qui sortirait du dossier."""
    dest = Path(dest)
    root = dest.resolve()
    dest.mkdir(parents=True, exist_ok=True)

    def check(name):
        target = (dest / name).resolve()
        if root != target and root not in target.parents:
            raise RuntimeError('archive suspecte : chemin %r hors du dossier' % name)

    if str(archive).endswith('.zip'):
        with zipfile.ZipFile(archive) as z:
            for name in z.namelist():
                check(name)
            z.extractall(dest)
    else:
        with tarfile.open(archive) as t:
            members = t.getmembers()
            for m in members:
                check(m.name)
                if m.issym() or m.islnk():
                    check(os.path.join(os.path.dirname(m.name), m.linkname))
            if hasattr(tarfile, 'data_filter'):
                t.extractall(dest, filter='data')
            else:
                t.extractall(dest)


# --------------------------------------------------------------------------------------------
# WAV (lecture PCM 16/24/32 bits et flottant 32 bits ; écriture PCM 16 ou 24 bits)
# --------------------------------------------------------------------------------------------
def wav_layout(data):
    """En-tête d'un WAV -> (code de format, canaux, fréquence, bits, début des données, taille des données)."""
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise ValueError('pas un fichier WAV')
    pos, fmt = 12, None
    while pos + 8 <= len(data):
        tag, size = data[pos:pos + 4], struct.unpack('<I', data[pos + 4:pos + 8])[0]
        if tag == b'fmt ':
            body = data[pos + 8:pos + 8 + size]
            code, channels, rate, _, _, bits = struct.unpack('<HHIIHH', body[:16])
            if code == 0xFFFE and len(body) >= 26:  # WAVE_FORMAT_EXTENSIBLE : le vrai code est plus loin
                code = struct.unpack('<H', body[24:26])[0]
            fmt = (code, channels, rate, bits)
        elif tag == b'data':
            if fmt is None:
                break
            size = min(size, len(data) - pos - 8)   # taille annoncée parfois fausse (écriture en flux)
            width = fmt[3] // 8 * fmt[1]
            if (fmt[0], fmt[3]) not in ((1, 16), (1, 24), (1, 32), (3, 32)) or width == 0:
                raise ValueError('format WAV non géré (code %d, %d bits)' % (fmt[0], fmt[3]))
            return fmt + (pos + 8, size - size % width)
        pos += 8 + size + (size & 1)
    raise ValueError('WAV incomplet')


def wav_frames(path):
    """(fréquence, canaux, nombre d'échantillons par canal, code de format) sans décoder le son."""
    data = Path(path).read_bytes()
    code, channels, rate, bits, _, size = wav_layout(data)
    return rate, channels, size // (bits // 8 * channels), code


def read_wav(path, step=1):
    """-> (fréquence, canaux, échantillons flottants entrelacés dans [-1, 1]).

    step > 1 : ne garde qu'une trame sur step (sondage rapide d'un long fichier, premier canal seulement)."""
    data = Path(path).read_bytes()
    code, channels, rate, bits, start, size = wav_layout(data)
    pcm = data[start:start + size]
    del data
    if bits == 24:  # 24 bits -> 32 bits en ajoutant un octet de poids faible nul (opérations sur octets, rapides)
        wide = bytearray(len(pcm) // 3 * 4)
        wide[1::4], wide[2::4], wide[3::4] = pcm[0::3], pcm[1::3], pcm[2::3]
        pcm, bits = bytes(wide), 32
    values = array.array('f' if code == 3 else ('h' if bits == 16 else 'i'))
    values.frombytes(pcm)
    del pcm
    if sys.byteorder == 'big':
        values.byteswap()
    if step > 1:
        values = values[::step * channels]
    if code == 3:
        return rate, channels, values
    scale = 1.0 / (1 << (bits - 1))
    return rate, channels, array.array('f', (v * scale for v in values))


def write_wav(path, rate, samples, bits=24):
    """Écrit un WAV PCM mono (16 ou 24 bits) depuis des flottants, en écrêtant à [-1, 1]."""
    peak = (1 << (bits - 1)) - 1
    ints = array.array('h' if bits == 16 else 'i', (int(round(max(-1.0, min(1.0, v)) * peak)) for v in samples))
    if sys.byteorder == 'big':
        ints.byteswap()
    raw = ints.tobytes()
    if bits == 24:  # garder les 3 octets de poids faible de chaque entier 32 bits
        packed = bytearray(len(ints) * 3)
        packed[0::3], packed[1::3], packed[2::3] = raw[0::4], raw[1::4], raw[2::4]
        raw = bytes(packed)
    header = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + len(raw), b'WAVE', b'fmt ', 16, 1, 1, rate,
                         rate * bits // 8, bits // 8, bits, b'data', len(raw))
    Path(path).write_bytes(header + raw)


def flac_info(path):
    """(fréquence, canaux, nombre d'échantillons) lus dans l'en-tête STREAMINFO."""
    with open(path, 'rb') as f:
        head = f.read(42)
    if len(head) < 42 or head[:4] != b'fLaC' or head[4] & 0x7F != 0:
        raise ValueError('pas un fichier FLAC')
    hi, lo = struct.unpack('>II', head[18:26])
    return hi >> 12, ((hi >> 9) & 7) + 1, ((hi & 0xF) << 32) | lo


def correlation(a, b):
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / (na * nb) if na > 0 and nb > 0 else 0.0


# --------------------------------------------------------------------------------------------
# Hub
# --------------------------------------------------------------------------------------------
class Hub:
    def __init__(self, url, token):
        self.base = url.rstrip('/')
        self.token = token
        self.ctx = ssl.create_default_context()

    def request(self, method, path, body=None, raw=None, headers=None, timeout=60, dest=None):
        """-> (statut, json ou None). Les erreurs réseau et 5xx lèvent OSError ; les 4xx sont renvoyés tels quels."""
        h = {'User-Agent': 'reuse-worker'}
        data = None
        if raw is not None:
            data, h['Content-Type'] = raw, 'audio/flac'
        elif body is not None:
            data, h['Content-Type'] = json.dumps(body).encode(), 'application/json'
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        # urllib recopie les en-têtes ordinaires sur la cible d'une redirection, quel que soit l'hôte :
        # le jeton n'est donc jamais posé que sur la requête faite au hub lui-même.
        req.add_unredirected_header('Authorization', 'Bearer ' + self.token)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as r:
                if dest is not None:
                    with open(dest, 'wb') as f:
                        shutil.copyfileobj(r, f, 1 << 20)
                    return r.status, None
                text = r.read().decode('utf-8', 'replace')
                return r.status, (json.loads(text) if text.strip().startswith('{') else None)
        except urllib.error.HTTPError as e:
            text = e.read().decode('utf-8', 'replace')
            if e.code >= 500 or e.code == 429:
                raise OSError('le hub répond %d' % e.code)
            try:
                return e.code, json.loads(text)
            except ValueError:
                return e.code, {'error': text[:200]}
        except (socket.timeout, ssl.SSLError, ConnectionError, ValueError) as e:
            raise OSError(str(e))

    def retrying(self, what, fn, tries=8):
        """Rejoue fn tant que le réseau ou le hub flanche (attente croissante), puis lève OSError."""
        delay = 5
        for attempt in range(1, tries + 1):
            try:
                return fn()
            except OSError as e:
                if attempt == tries:
                    raise
                log.warning('%s : hub injoignable (%s), nouvel essai dans %d s', what, e, delay)
                time.sleep(delay)
                delay = min(delay * 2, 120)


# --------------------------------------------------------------------------------------------
# Moteur : audio.cpp + modèle + codec FLAC
# --------------------------------------------------------------------------------------------
class Engine:
    def __init__(self, base, config):
        self.runtime = base / 'runtime'
        self.config = config
        self.system = 'windows' if IS_WINDOWS else 'linux'
        self.cli = None          # exécutable audiocpp_cli
        self.backend = 'cpu'     # 'vulkan' ou 'cpu'
        self.device = None       # index du GPU Vulkan
        self.device_name = 'processeur'
        self.gpus = None         # cartes Vulkan vues au démarrage (None : pas regardé, backend cpu imposé)
        self.note = ''           # pourquoi on est en repli, s'il y a lieu
        self.model = self.runtime / 'models' / MODEL_NAME
        self.flac = None
        self.ffmpeg = None
        self.pidfile = self.runtime / 'engine.pid'

    def kill_orphan(self):
        """Si le worker a été tué en plein calcul, son moteur tourne encore : on l'arrête (après avoir vérifié que
        ce numéro de processus est bien un moteur audio.cpp) pour ne pas calculer deux fois sur la carte."""
        try:
            pid = int(self.pidfile.read_text())
        except (OSError, ValueError):
            return
        try:
            if IS_WINDOWS:
                listing = subprocess.run(['tasklist', '/FI', 'PID eq %d' % pid, '/FO', 'CSV', '/NH'], stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW, timeout=30).stdout
                if b'audiocpp' in listing.lower():
                    subprocess.run(['taskkill', '/PID', str(pid), '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW, timeout=30)
                    log.info('Moteur resté en marche après une coupure : arrêté.')
            elif b'audiocpp' in Path('/proc/%d/cmdline' % pid).read_bytes():
                os.kill(pid, 9)
                log.info('Moteur resté en marche après une coupure : arrêté.')
        except (OSError, subprocess.SubprocessError):
            pass
        self.pidfile.unlink(missing_ok=True)

    # ---- installation -----------------------------------------------------------------
    def check_platform(self):
        if platform.machine().lower() not in ('amd64', 'x86_64'):
            raise RuntimeError('processeur %s non pris en charge (x86-64 seulement)' % platform.machine())
        if not IS_WINDOWS:
            lib, ver = platform.libc_ver()
            try:
                too_old = lib == 'glibc' and tuple(int(x) for x in ver.split('.')[:2]) < (2, 43)
            except ValueError:
                too_old = False
            if too_old and not self.config.get('audiocpp_cli'):
                raise RuntimeError('glibc %s trop ancienne : les binaires audio.cpp %s demandent glibc 2.43 (Ubuntu 26.04 ou plus '
                                   'récent). Sinon compiler audio.cpp et indiquer "audiocpp_cli" dans la config.' % (ver, AUDIOCPP_VERSION))

    def install_audiocpp(self):
        if self.config.get('audiocpp_cli'):   # moteur fourni à la main (compilé sur place)
            return Path(self.config['audiocpp_cli'])
        name, digest = AUDIOCPP_ASSETS[self.system]
        home = self.runtime / ('audiocpp-%s' % AUDIOCPP_VERSION)
        exe = 'audiocpp_cli.exe' if IS_WINDOWS else 'audiocpp_cli'
        found = [p for p in home.rglob(exe) if p.parent.name != 'tools'] if (home / '.ok').exists() else []
        if not found:
            archive = download(AUDIOCPP_URL + name, self.runtime / 'downloads' / name, digest, 'moteur audio.cpp %s (85 Mo)' % AUDIOCPP_VERSION)
            rmtree(home)
            safe_extract(archive, home)
            found = [p for p in home.rglob(exe) if p.parent.name != 'tools']
            if not found:
                raise RuntimeError('audiocpp_cli introuvable dans %s' % name)
            if not IS_WINDOWS:
                os.chmod(found[0], 0o755)
            (home / '.ok').write_text('ok')
            archive.unlink()
        return found[0]

    def install_codec(self):
        """flac (ou ffmpeg) pour décoder l'entrée et encoder la sortie."""
        self.flac = shutil.which('flac')
        self.ffmpeg = shutil.which('ffmpeg')
        if IS_WINDOWS and not self.flac and not self.ffmpeg:
            home = self.runtime / 'flac-1.5.0'
            exe = home / 'flac-1.5.0-win' / 'Win64' / 'flac.exe'
            if not exe.exists():
                archive = download(FLAC_WIN_URL, self.runtime / 'downloads' / 'flac-1.5.0-win.zip', FLAC_WIN_SHA256, 'codec FLAC 1.5.0')
                rmtree(home)
                safe_extract(archive, home)
                archive.unlink()
            self.flac = str(exe)
        if not self.flac and not self.ffmpeg:
            raise RuntimeError('ni « flac » ni « ffmpeg » trouvé : installer le paquet flac (sudo apt install flac)')

    def call_cli(self, args, timeout, stop=None):
        """Exécute audiocpp_cli ; -> sortie texte. Lève RuntimeError si échec, JobLost si stop est levé."""
        flags, kwargs = 0, {}
        low = self.config.get('low_priority', True)   # ne pas gêner l'usage du PC
        if IS_WINDOWS:
            flags = subprocess.CREATE_NO_WINDOW | (subprocess.BELOW_NORMAL_PRIORITY_CLASS if low else 0)
        elif low:
            kwargs['preexec_fn'] = lambda: os.nice(10)
        # Lancé depuis son propre dossier : audio.cpp y cherche ses bibliothèques de calcul
        proc = subprocess.Popen([str(self.cli)] + [str(a) for a in args], cwd=str(Path(self.cli).parent), stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=flags, **kwargs)
        self.pidfile.write_text(str(proc.pid))
        out = []
        reader = threading.Thread(target=lambda: out.extend(proc.stdout), daemon=True)
        reader.start()
        deadline = time.time() + timeout
        while proc.poll() is None:
            if stop is not None and stop.is_set():
                proc.kill()
                proc.wait()
                raise JobLost('calcul interrompu')
            if time.time() > deadline:
                proc.kill()
                proc.wait()
                raise RuntimeError('calcul trop long (plus de %s), arrêté' % fmt_duration(timeout))
            time.sleep(0.5)
        reader.join(5)
        self.pidfile.unlink(missing_ok=True)
        text = b''.join(out).decode('utf-8', 'replace')
        if proc.returncode != 0:
            raise RuntimeError('audio.cpp a échoué (code %s) : %s' % (proc.returncode, ' | '.join(text.strip().splitlines()[-3:])[:300]))
        return text

    def list_gpus(self):
        text = self.call_cli(['--list-devices', '--json'], 120)
        start = text.find('{"schema_version"')
        if start < 0:
            return []
        devices = json.loads(text[start:text.rfind('}') + 1]).get('devices', [])
        gpus = [d for d in devices if d.get('backend') == 'vulkan' and d.get('type') != 'cpu']
        # Carte dédiée d'abord, puis la plus grosse mémoire (un PC a souvent aussi un GPU intégré)
        gpus.sort(key=lambda d: (d.get('type') == 'gpu', (d.get('memory') or {}).get('total_bytes') or 0), reverse=True)
        return gpus

    def setup(self):
        self.runtime.mkdir(parents=True, exist_ok=True)
        self.kill_orphan()
        self.check_platform()
        self.install_codec()
        if self.config.get('model'):   # modèle fourni à la main (autre variante GGUF de RE-USE)
            self.model = Path(self.config['model'])
            if not self.model.exists():
                raise RuntimeError('modèle introuvable : %s' % self.model)
        else:
            download(MODEL_URL, self.model, MODEL_SHA256, 'modèle NVIDIA NemotronLabs RE-USE (38 Mo)')
        self.cli = self.install_audiocpp()
        wanted = str(self.config.get('backend', 'auto')).lower()
        if wanted not in ('auto', 'vulkan', 'cpu'):
            raise RuntimeError('"backend" doit valoir auto, vulkan ou cpu dans la config')
        if wanted != 'cpu':
            gpus = self.list_gpus()
            self.gpus = list(gpus)
            for d in gpus:
                log.info('Carte graphique vue : n° %s, %s (%.1f Go)', d.get('index'), d.get('description') or d.get('name'),
                         ((d.get('memory') or {}).get('total_bytes') or 0) / 1e9)
            if self.config.get('device') is not None:
                gpus = [d for d in gpus if d.get('index') == int(self.config['device'])]
            if gpus:
                self.backend, self.device = 'vulkan', gpus[0].get('index', 0)
                self.device_name = gpus[0].get('description') or gpus[0].get('name') or 'GPU'
                self.selftest()
            else:
                self.note = 'aucune carte graphique Vulkan détectée (pilote graphique à jour ?)'
            if self.backend == 'cpu':
                if wanted == 'vulkan':
                    raise RuntimeError('la config impose le GPU mais il est inutilisable : %s' % self.note)
                log.warning('GPU inutilisable : %s. Repli sur le processeur (beaucoup plus lent).', self.note)
        log.info('Moteur prêt : %s', self.describe())

    def describe(self):
        return 'GPU %s via Vulkan' % self.device_name if self.backend == 'vulkan' else 'processeur (CPU)'

    # ---- autotest GPU ---------------------------------------------------------------------
    def selftest(self):
        """Le GPU doit rendre le même son que le CPU sur un extrait de parole ; sinon on n'utilise pas le GPU.

        Un pilote ou un backend défaillant produit du son faux sans erreur : c'est le seul contrôle qui le voit.
        Un succès est mémorisé par (moteur, carte) ; un échec est retenté au bout d'un jour (pilote mis à jour,
        carte qui était occupée par un jeu)."""
        key = '%s|%s|%s' % (AUDIOCPP_VERSION, self.device_name, MODEL_SHA256[:12])
        memo = self.runtime / 'selftest.json'
        known = read_json(memo, {}) or {}
        if known.get('key') == key and (known.get('ok') or time.time() - known.get('at', 0) < 86400):
            if not known.get('ok'):
                self.fallback_cpu(known.get('reason', 'autotest raté'))
            return
        work = self.runtime / 'selftest'
        rmtree(work)
        work.mkdir(parents=True)
        result = {'key': key, 'ok': False, 'at': int(time.time())}
        # Un téléchargement raté n'est pas un verdict sur la carte : l'erreur remonte, le lanceur réessaiera
        clip = download(SELFTEST_URL, self.runtime / 'downloads' / 'mic_test2.wav', SELFTEST_SHA256, 'extrait de test NVIDIA')
        rate, channels, samples = read_wav(clip)
        mono = samples[0::channels][:int(SELFTEST_SECONDS * rate)]
        write_wav(work / 'in.wav', rate, mono, bits=16)
        try:
            log.info('Autotest : même extrait de %.0f s sur le GPU puis sur le processeur (une seule fois, 1 à 3 min)', SELFTEST_SECONDS)
            t0 = time.time()
            self.enhance_wav(work / 'in.wav', work / 'gpu.wav', 0, 0, 900)
            gpu_s = time.time() - t0
            t0 = time.time()
            self.enhance_wav(work / 'in.wav', work / 'cpu.wav', 0, 0, 3600, backend='cpu')
            cpu_s = time.time() - t0
            _, _, gpu = read_wav(work / 'gpu.wav')
            _, _, cpu = read_wav(work / 'cpu.wav')
            corr = correlation(gpu, cpu)
            level = (sum(v * v for v in gpu) / max(1, len(gpu))) ** 0.5
            result.update(correlation=round(corr, 5), gpu_s=round(gpu_s, 1), cpu_s=round(cpu_s, 1))
            if len(gpu) != len(mono):
                result['reason'] = 'autotest : le GPU rend %d échantillons au lieu de %d' % (len(gpu), len(mono))
            elif level < 1e-4:
                result['reason'] = 'autotest : le GPU rend du silence'
            elif corr < SELFTEST_MIN_CORRELATION:
                result['reason'] = 'autotest : le GPU ne rend pas le même son que le processeur (corrélation %.3f)' % corr
            else:
                result['ok'] = True
                log.info('Autotest réussi : GPU et processeur concordent (corrélation %.4f) ; GPU %.1f s, processeur %.1f s', corr, gpu_s, cpu_s)
        except (RuntimeError, OSError, ValueError) as e:
            result['reason'] = 'autotest : %s' % e
        write_json(memo, result)
        rmtree(work)
        if not result['ok']:
            self.fallback_cpu(result['reason'])

    def fallback_cpu(self, reason):
        self.note = reason
        self.backend, self.device, self.device_name = 'cpu', None, 'processeur'

    # ---- nettoyage ------------------------------------------------------------------------
    def enhance_wav(self, src, dst, chunk_s, overlap_s, timeout, backend=None, stop=None):
        backend = backend or self.backend
        args = ['--task', 's2s', '--family', 'reuse', '--model', self.model, '--backend', backend,
                '--threads', int(self.config.get('threads') or max(1, min(16, (os.cpu_count() or 4) - 1))),
                '--audio', src, '--out', dst]
        if backend == 'vulkan' and self.device is not None:
            args += ['--device', self.device]
        if chunk_s and chunk_s > 0:
            args += ['--request-option', 'audio_chunk_duration_sec=%g' % chunk_s,
                     '--request-option', 'audio_chunk_overlap_sec=%g' % min(overlap_s, chunk_s * 0.9)]
        self.call_cli(args, timeout, stop)
        if not Path(dst).exists():
            raise RuntimeError('audio.cpp n\'a rien écrit')

    def decode(self, flac, wav):
        if self.flac:
            cmd = [self.flac, '--silent', '--force', '--decode', '-o', str(wav), str(flac)]
        else:
            cmd = [self.ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(flac), str(wav)]
        self.tool(cmd, 'décodage FLAC')

    def encode(self, wav, flac):
        if self.flac:
            cmd = [self.flac, '--silent', '--force', '--best', '-o', str(flac), str(wav)]
        else:
            cmd = [self.ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(wav), '-c:a', 'flac', '-compression_level', '8', str(flac)]
        self.tool(cmd, 'encodage FLAC')

    @staticmethod
    def tool(cmd, what):
        flags = subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=flags, timeout=900)
        if r.returncode != 0:
            raise RuntimeError('%s raté : %s' % (what, r.stdout.decode('utf-8', 'replace').strip()[-200:]))

    def clean(self, src_flac, dst_flac, workdir, params, stop):
        """FLAC brut -> FLAC nettoyé, même fréquence, même longueur à l'échantillon près. -> (secondes de calcul, niveau)."""
        rate, channels, n = flac_info(src_flac)
        if channels != 1:
            raise RuntimeError('entrée non mono')
        chunk_s = float(params.get('chunk_s', DEFAULT_CHUNK_S))
        overlap_s = float(params.get('overlap_s', DEFAULT_OVERLAP_S))
        for old in workdir.glob('run-*'):   # restes d'un calcul interrompu
            rmtree(old)
        run = workdir / ('run-%d' % os.getpid())
        run.mkdir()
        in_wav, out_wav, fixed_wav = (run / x for x in ('in.wav', 'out.wav', 'fixed.wav'))
        self.decode(src_flac, in_wav)
        if wav_frames(in_wav)[:3] != (rate, 1, n):
            raise RuntimeError('décodage incohérent : %s au lieu de %d Hz mono, %d échantillons' % (wav_frames(in_wav)[:3], rate, n))
        seconds = n / rate
        # Garde-fou contre un calcul bloqué : très large pour le GPU, plus encore pour un repli CPU
        timeout = 600 + seconds * float(self.config.get('max_rtf') or (20 if self.backend == 'vulkan' else 300))
        t0 = time.time()
        self.enhance_wav(in_wav, out_wav, chunk_s, overlap_s, timeout, stop=stop)
        compute_s = time.time() - t0
        out_rate, out_channels, frames, code = wav_frames(out_wav)
        if out_rate != rate or out_channels != 1:
            raise RuntimeError('sortie en %d Hz / %d canaux au lieu de %d Hz mono' % (out_rate, out_channels, rate))
        if abs(frames - n) > MAX_LENGTH_DRIFT_S * rate:
            raise RuntimeError('sortie de %.3f s pour une entrée de %.3f s' % (frames / rate, seconds))
        probe = read_wav(out_wav, step=20)[2]
        if any(v != v or abs(v) > 100 for v in probe):
            raise RuntimeError('sortie invalide (valeurs non numériques)')
        level = (sum(v * v for v in probe) / max(1, len(probe))) ** 0.5
        # Chemin lent seulement si nécessaire : longueur à recaler, ou WAV flottant que l'outil flac ne sait pas encoder
        if frames != n or (code == 3 and self.flac):
            cleaned = read_wav(out_wav)[2]
            cleaned = cleaned[:n] if len(cleaned) >= n else cleaned + array.array('f', [0.0] * (n - len(cleaned)))
            write_wav(fixed_wav, rate, cleaned, bits=24)
            del cleaned
            out_wav.unlink()
            out_wav = fixed_wav
        self.encode(out_wav, dst_flac)
        if flac_info(dst_flac) != (rate, 1, n):
            raise RuntimeError('FLAC de sortie incohérent : %s' % (flac_info(dst_flac),))
        rmtree(run)
        return compute_s, level


# --------------------------------------------------------------------------------------------
# Générations GPU (image, 3D) : catalogue publié par le hub, installation paresseuse sous <dossier>/gpu
# --------------------------------------------------------------------------------------------
GPU_CATALOG = 'gpu-catalog.json'
GPU_KEEP_LOADED_S = 600          # moteur image gardé chargé entre deux travaux (réglable : "gpu_keep_loaded_s", 0 = jamais)
GPU_DEFAULT_MAX_GB = 30.0        # plafond du dossier gpu (réglable : "gpu_max_gb" dans la config)
GPU_KEEP_FREE_GB = 10.0          # place laissée libre sur le disque après un téléchargement (réglable : "gpu_keep_free_gb")
PNG_MAGIC = b'\x89PNG\r\n\x1a\n'


def png_size(path):
    """(largeur, hauteur) d'un PNG, ou None."""
    with open(path, 'rb') as f:
        head = f.read(24)
    if len(head) < 24 or head[:8] != PNG_MAGIC or head[12:16] != b'IHDR':
        return None
    return struct.unpack('>II', head[16:24])


def is_glb(path):
    """glTF binaire 2.0 dont l'en-tête annonce exactement la taille du fichier."""
    with open(path, 'rb') as f:
        head = f.read(12)
    return len(head) == 12 and head[:4] == b'glTF' and struct.unpack('<II', head[4:12]) == (2, os.path.getsize(path))


def glb_stats(path):
    """Ce que dit un GLB de lui-même (morceau JSON) : sommets, triangles, textures, boîte englobante. Un maillage fait de
    bruit (flux tombé en NaN, trellis.cpp #50) se voit à ses chiffres : quasi vide, ou boîte dégénérée. None si illisible."""
    try:
        with open(path, 'rb') as f:
            head = f.read(20)
            if len(head) < 20 or head[:4] != b'glTF' or head[16:20] != b'JSON':
                return None
            doc = json.loads(f.read(struct.unpack('<I', head[12:16])[0]))
    except (OSError, ValueError, struct.error):
        return None
    acc = doc.get('accessors') or []
    vertices = triangles = 0
    lo, hi = [float('inf')] * 3, [float('-inf')] * 3
    for mesh in doc.get('meshes') or []:
        for prim in mesh.get('primitives') or []:
            pos = (prim.get('attributes') or {}).get('POSITION')
            if isinstance(pos, int) and pos < len(acc):
                a = acc[pos]
                vertices += int(a.get('count') or 0)
                for i in range(3):
                    if len(a.get('min') or []) == 3 and len(a.get('max') or []) == 3:
                        lo[i], hi[i] = min(lo[i], a['min'][i]), max(hi[i], a['max'][i])
            ind = prim.get('indices')
            if isinstance(ind, int) and ind < len(acc):
                triangles += int(acc[ind].get('count') or 0) // 3
    out = {'vertices': vertices, 'triangles': triangles, 'meshes': len(doc.get('meshes') or []),
           'textures': len(doc.get('images') or []), 'materials': len(doc.get('materials') or [])}
    if vertices and all(abs(v) != float('inf') for v in lo + hi):
        out['bbox_size'] = [round(hi[i] - lo[i], 4) for i in range(3)]
    return out


def folder_bytes(path):
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def build_command(template, values):
    """Ligne de commande depuis le modèle du catalogue. Un élément « {nom} » est remplacé en entier par la valeur
    (jamais de découpage ni de shell : un prompt reste un seul argument, quoi qu'il contienne) ;
    « {if:nom=--x} » ne donne --x que si la valeur est vraie, « {unless:nom=--x} » que si elle est fausse."""
    args = []
    for item in template:
        m = re.fullmatch(r'\{opt:([\w.-]+)=([^{}]+)\}', item)   # « {opt:threads=-t} » : -t <valeur>, seulement si elle est donnée
        if m:
            v = values.get(m.group(1))
            if v not in (None, '', 0, False):
                args += [m.group(2), ('%g' % v) if isinstance(v, float) else str(v)]
            continue
        m = re.fullmatch(r'\{(if|unless):([\w.-]+)=([^{}]+)\}', item)
        if m:
            on = bool(values.get(m.group(2)))
            if on == (m.group(1) == 'if'):
                args.append(m.group(3))
            continue
        m = re.fullmatch(r'\{([\w:.-]+)\}', item)
        if m:
            if m.group(1) not in values:
                raise RuntimeError('catalogue : valeur %s manquante pour la ligne de commande' % m.group(1))
            v = values[m.group(1)]
            args.append(('%g' % v) if isinstance(v, float) else str(v))
        else:
            args.append(item)
    return args


def download_resume(url, dest, expected_sha256, size, what, stop=None, progress=None):
    """Gros fichier : reprend là où un essai précédent s'est arrêté (en-tête Range), vérifie l'empreinte à la fin.
    Un fichier déjà vérifié porte un témoin <fichier>.ok (taille, date) : pas de re-hachage de 7 Go à chaque job."""
    dest = Path(dest)
    mark = Path(str(dest) + '.ok')
    if dest.exists():
        st = dest.stat()
        if mark.exists() and mark.read_text().strip() == '%s %d %d' % (expected_sha256, st.st_size, st.st_mtime_ns):
            return dest
        if st.st_size == size and sha256_file(dest) == expected_sha256:
            mark.write_text('%s %d %d' % (expected_sha256, st.st_size, st.st_mtime_ns))
            return dest
        dest.unlink()
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(dest) + '.part')
    delay = 5
    for attempt in range(1, 9):
        try:
            have = tmp.stat().st_size if tmp.exists() else 0
            if have > size:
                tmp.unlink()
                have = 0
            if have < size:
                log.info('Téléchargement : %s (%.1f Go%s)', what, size / 1e9, ', reprise à %.0f %%' % (100.0 * have / size) if have else '')
                headers = {'User-Agent': 'reuse-worker'}
                if have:
                    headers['Range'] = 'bytes=%d-' % have
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as r:
                    mode = 'ab' if have and getattr(r, 'status', 200) == 206 else 'wb'
                    if mode == 'wb':
                        have = 0
                    with open(tmp, mode) as f:
                        last = 0
                        for block in iter(lambda: r.read(1 << 20), b''):
                            f.write(block)
                            have += len(block)
                            if stop is not None and stop.is_set():
                                raise JobLost('téléchargement interrompu')
                            if progress and have - last > (64 << 20):
                                last = have
                                progress(have / size)
            got = sha256_file(tmp)
            if got != expected_sha256:
                tmp.unlink()
                raise ValueError('empreinte inattendue pour %s (%s…)' % (what, got[:12]))
            os.replace(tmp, dest)
            st = dest.stat()
            mark.write_text('%s %d %d' % (expected_sha256, st.st_size, st.st_mtime_ns))
            return dest
        except (OSError, ValueError) as e:
            log.warning('Téléchargement de %s : essai %d raté (%s)', what, attempt, e)
            if attempt == 8:
                raise RuntimeError('impossible de télécharger %s : %s' % (what, e))
            time.sleep(delay)
            delay = min(delay * 2, 120)


def available_ram():
    """Mémoire disponible (octets, cache de fichiers récupérable compris), ou None si inconnue."""
    try:
        if IS_WINDOWS:
            import ctypes

            class MemoryStatus(ctypes.Structure):
                _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong), ('ullTotalPhys', ctypes.c_ulonglong),
                            ('ullAvailPhys', ctypes.c_ulonglong), ('ullTotalPageFile', ctypes.c_ulonglong),
                            ('ullAvailPageFile', ctypes.c_ulonglong), ('ullTotalVirtual', ctypes.c_ulonglong),
                            ('ullAvailVirtual', ctypes.c_ulonglong), ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]
            status = MemoryStatus()
            status.dwLength = ctypes.sizeof(MemoryStatus)
            return int(status.ullAvailPhys) if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else None
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemAvailable:'):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, AttributeError):
        return None
    return None


def prefetch(files, stop=None, progress=None, block=16 << 20, ram=available_ram):
    """Lit les poids une fois, du début à la fin, par grands blocs et d'un seul lecteur, avant le moteur.

    sd.cpp lit chaque tenseur depuis plusieurs fils à la fois, à des endroits différents des fichiers : sur un disque
    mécanique ce va-et-vient plafonne à 15-25 Mo/s (mesuré sur gpu-box : 11 Go en 7 à 11 min). Une lecture séquentielle
    remplit le cache de Windows ; le moteur lit ensuite en mémoire. Sauté si la mémoire libre ne peut pas tout garder
    (on relirait pour rien). -> {prefetch_s, prefetch_mb_s} ou {prefetch: raison}."""
    files = [Path(f) for f in files]
    total = sum(f.stat().st_size for f in files)
    free = ram()
    if free is not None and total > 0.8 * free:
        return {'prefetch': 'sauté : %.1f Go de poids pour %.1f Go de mémoire libre' % (total / 1e9, free / 1e9)}
    t0, done = time.time(), 0
    buf = bytearray(block)
    view = memoryview(buf)
    for f in files:
        with open(f, 'rb', buffering=0) as handle:
            while True:
                n = handle.readinto(view)
                if not n:
                    break
                done += n
                if stop is not None and stop.is_set():
                    raise JobLost('calcul interrompu')
                if progress and done % (256 << 20) < block:
                    elapsed = max(time.time() - t0, 1e-6)
                    progress(done / max(total, 1), 'lecture des poids (%.0f Mo/s)' % (done / elapsed / 1e6))
    elapsed = max(time.time() - t0, 1e-6)
    return {'prefetch_s': round(elapsed, 1), 'prefetch_mb_s': round(done / elapsed / 1e6, 1)}


def kill_orphan(pidfile, markers):
    """Moteur resté en marche après la mort du worker : arrêté, après avoir vérifié son nom (jamais un autre programme)."""
    try:
        pid = int(Path(pidfile).read_text())
    except (OSError, ValueError):
        return
    try:
        if IS_WINDOWS:
            listing = subprocess.run(['tasklist', '/FI', 'PID eq %d' % pid, '/FO', 'CSV', '/NH'], stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW, timeout=30).stdout.lower()
            if any(m in listing for m in markers):
                subprocess.run(['taskkill', '/PID', str(pid), '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW, timeout=30)
                log.info('Moteur GPU resté en marche après une coupure : arrêté.')
        elif any(m in Path('/proc/%d/cmdline' % pid).read_bytes().lower() for m in markers):
            os.kill(pid, 9)
            log.info('Moteur GPU resté en marche après une coupure : arrêté.')
    except (OSError, subprocess.SubprocessError):
        pass
    Path(pidfile).unlink(missing_ok=True)


class ServerUnavailable(Exception):
    """Le moteur résident n'a pas pu servir ce travail : le lancement classique (un processus par travail) prend le relais."""


class EngineTrace:
    """Lit la sortie d'un moteur (stable-diffusion.cpp, trellis.cpp) au fil de l'eau : phases chronométrées, carte et
    plan mémoire réellement choisis, lignes utiles gardées pour le hub. Sans cela, un calcul retombé sur le processeur
    ou des poids relus du disque à chaque travail ne se voient qu'à la lenteur."""
    KEEP = re.compile(r'ggml_vulkan|vulkan\d|auto-fit|devices?:|free\s+-?\d+ MiB|RAM\s+free|params\s+-?\d+ MiB|--backend|using CPU|'
                      r'no GPU|buffer size|completed, taking|completed in|memory-mapped|out of memory|tiling|model manager|'
                      r'offload|staged|\bWARN|\bERROR|failed|error|^\s*\[\d+/\d+\]', re.I)
    STAGE = re.compile(r'^\s*\[(\d+)/(\d+)\]\s*(.+)')   # étapes de trellis.cpp : « [5/7] FlexiDualGrid shape decode -> mesh »
    BAR = re.compile(r'\|\s*(\d+)/(\d+)\s*-\s*([\d.]+)\s*(s/it|it/s|[KMG]B/s)')
    TAKING = (('load_s', r'loading tensors completed, taking ([\d.]+)s'), ('encode_s', r'get_learned_condition completed, taking ([\d.]+)s'),
              ('sampling_s', r'sampling completed, taking ([\d.]+)s'), ('decode_s', r'decode_first_stage completed, taking ([\d.]+)s'),
              ('total_s', r'generate_image completed in ([\d.]+)s'))
    MAX_LINES = 80

    def __init__(self, steps=None, clock=time.time):
        self.steps = steps
        self.clock = clock
        self.t0 = clock()
        self.partial = ''
        self.lines = []
        self.meta = {}
        self.phase = 'démarrage'
        self.progress = 0.0
        self.step = None
        self.step_rate = None
        self.first_step_at = None
        self.last_step_at = None

    def feed(self, data):
        text = self.partial + data.decode('utf-8', 'replace')
        parts = re.split(r'[\r\n]', text)
        self.partial = parts.pop()
        for line in parts:
            self.line(line)
        if len(self.partial) > 4096:
            self.line(self.partial)
            self.partial = ''
        bar = list(self.BAR.finditer(self.partial))   # barre en cours de dessin (pas encore de fin de ligne)
        if bar:
            self.bar(bar[-1])

    def close(self):
        if self.partial:
            self.line(self.partial)
            self.partial = ''

    def keep(self, line):
        line = line.strip()[:240]
        if line and (not self.lines or self.lines[-1] != line):
            self.lines.append('%5.0fs %s' % (self.clock() - self.t0, line))
            if len(self.lines) > self.MAX_LINES:   # le début (cartes, plan) et la fin (temps) comptent le plus
                del self.lines[self.MAX_LINES // 2]

    def line(self, line):
        bars = list(self.BAR.finditer(line))
        if bars:
            self.bar(bars[-1])
            return
        if not self.KEEP.search(line):
            return
        self.keep(line)
        m = self.STAGE.match(line)
        if m and int(m.group(2)):
            a, b = int(m.group(1)), int(m.group(2))
            self.phase = '%d/%d %s' % (a, b, m.group(3).strip()[:80])
            self.progress = max(self.progress, 0.3 + 0.65 * (a - 1) / b)
        low = line.lower()
        m = re.search(r'ggml_vulkan: \d+ = ([^|(\r\n]+)', line)
        if m and 'device' not in self.meta:
            self.meta['device'] = m.group(1).strip()[:120]
        if 'using cpu' in low or 'no gpu devices' in low:
            self.meta['backend'] = 'cpu'
        m = re.search(r'--backend "([^"]*)"', line)
        if m and self.meta.get('backend') != 'cpu':
            self.meta['backend'] = m.group(1)[:120]
        m = re.search(r'(vulkan\d+)\s+(.*?)\s+free\s+(-?\d+) MiB, budget\s+(-?\d+) MiB', line, re.I)
        if m:
            self.meta.setdefault('vram_free_mib', int(m.group(3)))
            self.meta.setdefault('vram_budget_mib', int(m.group(4)))
        m = re.search(r'RAM\s+free\s+(-?\d+) MiB', line)
        if m:
            self.meta.setdefault('ram_free_mib', int(m.group(1)))
        for key, pattern in self.TAKING:
            m = re.search(pattern, line)
            if m:
                self.meta[key] = round(float(m.group(1)), 1)
                self.phase = {'load_s': 'encodage du texte', 'encode_s': 'étapes', 'sampling_s': 'décodage'}.get(key, self.phase)

    def bar(self, m):
        a, b, rate, unit = int(m.group(1)), int(m.group(2)), float(m.group(3)), m.group(4)
        if not b:
            return
        now = self.clock()
        if unit.endswith('B/s'):
            self.phase = 'chargement des poids'
            self.progress = max(self.progress, 0.05 + 0.25 * a / b) if self.step is None else self.progress
        elif self.steps and b == self.steps:
            self.step = a
            self.step_rate = (rate if unit == 's/it' else (1.0 / rate if rate else None))
            if self.first_step_at is None:
                self.first_step_at = now
            self.last_step_at = now
            self.phase = 'étape %d/%d' % (a, b)
            self.progress = 0.35 + 0.55 * a / b
        else:   # tuiles du décodeur, autre barre
            self.phase = 'décodage' if self.step else self.phase
            if self.step:
                self.progress = max(self.progress, 0.9 + 0.08 * a / b)

    def stage(self):
        if self.step_rate and self.step is not None and self.phase.startswith('étape'):
            return '%s (%.1f s par étape)' % (self.phase, self.step_rate)
        return self.phase

    def summary(self):
        meta = dict(self.meta)
        if self.step_rate:
            meta['s_per_step'] = round(self.step_rate, 2)
        if self.first_step_at is not None:
            meta.setdefault('before_steps_s', round(self.first_step_at - self.t0, 1))
        return meta


class Gpu:
    """Image et 3D : moteurs et modèles du catalogue, installés au premier job qui en a besoin, tout sous <dossier>/gpu.

    gpu/engines/<moteur>-<empreinte>/   binaires décompressés        gpu/models/<modèle>/   poids (GGUF, safetensors)
    gpu/downloads/                       archives en cours            gpu/logs/              dernière sortie de chaque moteur
    Rien ailleurs : ni registre, ni service, ni Python en plus. Le plafond du dossier (gpu_max_gb) est vérifié avant
    tout téléchargement ; les versions que le catalogue ne cite plus sont supprimées d'abord."""

    def __init__(self, base, config, app, engine=None):
        self.root = base / 'gpu'
        self.config = config
        self.engine = engine   # cartes vues par le moteur RE-USE (mémoire vidéo), None pour l'essai --gpu-test
        self.system = 'windows' if IS_WINDOWS else 'linux'
        self.catalog = read_json(app / GPU_CATALOG, {}) or {}
        self.pidfile = self.root / 'engine.pid'
        self.status = {}   # type -> état lisible (« prêt », « pas installé », « échec : … »)
        self.last_trace = None   # EngineTrace du dernier lancement de moteur
        self.server = None       # moteur résident (sd-server) : {proc, port, key, trace, last_used, thread, log}
        self.server_pidfile = self.root / 'server.pid'
        self.server_refused = set()   # configurations dont le moteur résident n'a pas démarré : sd-cli directement

    def vram(self):
        """Mémoire de la carte qui calculera (octets), 0 sans carte Vulkan, None si inconnue (pas encore regardé)."""
        cards = getattr(self.engine, 'gpus', None)
        if cards is None:
            return None
        if self.config.get('gpu_device') is not None:
            cards = [d for d in cards if str(d.get('index')) == str(self.config['gpu_device'])]
        return max([(d.get('memory') or {}).get('total_bytes') or 0 for d in cards] or [0])

    def types(self, reasons=None):
        """Types que cette machine propose au hub (annoncés à chaque échange, info.gpu). reasons : dict rempli des
        types écartés et pourquoi (journal de démarrage)."""
        if self.config.get('gpu') is False or platform.machine().lower() not in ('amd64', 'x86_64'):
            return []
        out = []
        vram = self.vram()
        for t, spec in sorted((self.catalog.get('types') or {}).items()):
            engine = (self.catalog.get('engines') or {}).get(spec.get('engine')) or {}
            if not engine.get(self.system):
                continue
            if spec.get('experimental') and not self.config.get(spec.get('flag') or ('enable_' + t)):
                continue
            # Une carte trop petite raterait chaque travail après avoir téléchargé les poids : le type n'est pas proposé
            need = float(((spec.get('models') or {}).get(spec.get('default_model')) or {}).get('min_vram_gb') or 0)
            if need and vram is not None and vram < need * 1e9:
                if reasons is not None:
                    reasons[t] = 'carte de %.1f Go, %.0f Go demandés' % (vram / 1e9, need)
                continue
            out.append(t)
        return out

    def installed(self, kind):
        spec = (self.catalog.get('types') or {}).get(kind) or {}
        asset = ((self.catalog.get('engines') or {}).get(spec.get('engine')) or {}).get(self.system)
        model = (spec.get('models') or {}).get(spec.get('default_model')) or {}
        return bool(asset) and (self.engine_dir(spec['engine'], asset) / '.ok').exists() and all(
            (self.root / 'models' / spec['default_model'] / (f['name'] + '.ok')).exists() for f in model.get('files') or [])

    def describe(self):
        return ', '.join('%s : %s' % (t, self.status.get(t) or ('installé' if self.installed(t) else 'pas encore installé'))
                         for t in self.types())

    def max_bytes(self):
        try:
            return float(self.config.get('gpu_max_gb') or GPU_DEFAULT_MAX_GB) * 1e9
        except (TypeError, ValueError):
            return GPU_DEFAULT_MAX_GB * 1e9

    def keep_free_bytes(self):
        try:
            return max(0.0, float(self.config.get('gpu_keep_free_gb', GPU_KEEP_FREE_GB))) * 1e9
        except (TypeError, ValueError):
            return GPU_KEEP_FREE_GB * 1e9

    def engine_dir(self, name, asset):
        return self.root / 'engines' / ('%s-%s' % (name, asset['sha256'][:12]))

    def prune(self):
        """Supprime ce que le catalogue ne cite plus (ancienne version d'un moteur, modèle retiré)."""
        keep_engines = {self.engine_dir(n, e[self.system]).name for n, e in (self.catalog.get('engines') or {}).items() if e.get(self.system)}
        keep_models = {}
        for spec in (self.catalog.get('types') or {}).values():
            for mid, m in (spec.get('models') or {}).items():
                keep_models[mid] = {f['name'] for f in m.get('files') or []}
        for d in (self.root / 'engines').glob('*') if (self.root / 'engines').exists() else []:
            if d.name not in keep_engines:
                log.info('GPU : ancienne version de moteur supprimée (%s).', d.name)
                rmtree(d)
        for d in (self.root / 'models').glob('*') if (self.root / 'models').exists() else []:
            if d.name not in keep_models:
                log.info('GPU : modèle retiré du catalogue supprimé (%s).', d.name)
                rmtree(d)
                continue
            for f in d.iterdir():
                stem = f.name[:-3] if f.name.endswith('.ok') else (f.name[:-5] if f.name.endswith('.part') else f.name)
                if stem not in keep_models[d.name]:
                    f.unlink(missing_ok=True)
        rmtree(self.root / 'downloads')

    def ensure(self, kind, model_id, stop=None, progress=None):
        """-> (exécutable, {rôle: chemin}, dossier du modèle, variables d'environnement). Installe ce qui manque."""
        spec = (self.catalog.get('types') or {}).get(kind)
        if not spec or kind not in self.types():
            raise RuntimeError('type %s non proposé par cette machine' % kind)
        model = (spec.get('models') or {}).get(model_id)
        if not model:
            raise RuntimeError('modèle %s absent du catalogue publié' % model_id)
        ename = spec['engine']
        engine = self.catalog['engines'][ename]
        asset = engine[self.system]
        home = self.engine_dir(ename, asset)
        mdir = self.root / 'models' / model_id
        files = model.get('files') or []
        for f in files:
            if not safe_file_name(f['name']):
                raise RuntimeError('catalogue : nom de fichier refusé %r' % f['name'])
        # Place nécessaire avant de télécharger quoi que ce soit (archive + moteur décompressé comptés trois fois)
        missing = [f for f in files if not (mdir / (f['name'] + '.ok')).exists()]
        need = sum(int(f['size']) for f in missing) + (0 if (home / '.ok').exists() else 3 * int(asset.get('size') or 0))
        if need:
            self.root.mkdir(parents=True, exist_ok=True)
            self.prune()
            used = folder_bytes(self.root)
            partial = sum((mdir / (f['name'] + '.part')).stat().st_size for f in missing if (mdir / (f['name'] + '.part')).exists())
            if used - partial + need > self.max_bytes():
                raise RuntimeError('dossier gpu plafonné à %.0f Go : il en faudrait %.1f (%.1f déjà pris). Monter "gpu_max_gb" dans la config '
                                   'ou libérer de la place.' % (self.max_bytes() / 1e9, (used - partial + need) / 1e9, used / 1e9))
            # Le plafond ne dit rien du disque lui-même : ne jamais le remplir (Windows, autres logiciels de la machine)
            free = shutil.disk_usage(str(self.root)).free
            keep = self.keep_free_bytes()
            if need - partial + keep > free:
                raise RuntimeError('disque presque plein : %.1f Go à télécharger, %.1f Go libres, %.0f Go à laisser libres '
                                   '("gpu_keep_free_gb" dans la config).' % ((need - partial) / 1e9, free / 1e9, keep / 1e9))
        total = float(sum(int(f['size']) for f in missing)) or 1.0
        done = [0.0]
        if not (home / '.ok').exists():
            self.status[kind] = 'installation du moteur'
            archive = download(asset['url'], self.root / 'downloads' / Path(asset['url']).name, asset['sha256'], engine.get('label', ename))
            rmtree(home)
            safe_extract(archive, home)
            archive.unlink()
            found = [p for p in home.rglob(asset['exe'])]
            if not found:
                rmtree(home)
                raise RuntimeError('%s introuvable dans l\'archive de %s' % (asset['exe'], ename))
            if not IS_WINDOWS:
                for p in home.rglob('*'):
                    if p.is_file():
                        os.chmod(p, 0o755)
            (home / '.ok').write_text(str(found[0].relative_to(home)))
        exe = home / (home / '.ok').read_text().strip()
        paths = {}
        for f in files:
            def step(frac, f=f):
                if progress:
                    progress((done[0] + frac * int(f['size'])) / total, 'téléchargement %s' % f['name'])
            if f in missing:
                self.status[kind] = 'téléchargement de %s' % f['name']
            paths[f['role']] = download_resume(f['url'], mdir / f['name'], f['sha256'], int(f['size']), '%s (%s)' % (f['name'], model_id), stop, step)
            if f in missing:
                done[0] += int(f['size'])
        self.status[kind] = 'prêt (%s)' % model_id
        return exe, paths, mdir, dict(engine.get('env') or {})

    def run(self, job, input_path, workdir, stop, progress):
        """Calcule un job ; -> (fichier produit, secondes de calcul, méta)."""
        kind, model_id = job['kind'], job['model']
        spec = self.catalog['types'][kind]
        model = spec['models'][model_id]
        exe, paths, mdir, env_extra = self.ensure(kind, model_id, stop, lambda frac, stage: progress(0.3 * frac, stage))
        ext = spec.get('output', 'png')
        out = workdir / ('out.' + ext)
        out.unlink(missing_ok=True)
        values = dict(job.get('params') or {})
        # Un réglage ajouté au catalogue après la mise en file du travail prend sa valeur par défaut
        for name, ps in (model.get('params') or {}).items():
            if name not in values and 'default' in ps and ps['default'] != 'random' and not ps.get('needs_input'):
                values[name] = ps['default']
            if isinstance(ps.get('cli'), dict) and values.get(name) in ps['cli']:   # nom lisible -> syntaxe du moteur
                values[name] = ps['cli'][values[name]]
        values.update(prompt=job.get('prompt') or '', output=str(out), models_dir=str(mdir))
        values.update({'file:' + role: str(p) for role, p in paths.items()})
        template = list(model['command'])
        if input_path is not None:
            values['input'] = str(input_path)
            template += model.get('command_input') or []
        args = [str(exe)] + build_command(template, values)
        env = dict(os.environ, **{k: str(v) for k, v in env_extra.items()})
        if self.config.get('gpu_device') is not None:   # carte imposée (numéro Vulkan de ggml)
            env['GGML_VK_VISIBLE_DEVICES'] = str(int(self.config['gpu_device']))
        flags, kwargs = self.spawn_options()
        steps = values.get('steps') if isinstance(values.get('steps'), int) else None
        server = model.get('server')
        if server and self.keep_loaded_s() > 0:
            try:
                compute_s, meta = self.run_server(server, exe, values, env, input_path, out, steps, stop, progress, float(model.get('timeout_s') or 1800))
                self.check_output(ext, out, values)
                return out, compute_s, meta
            except ServerUnavailable as e:
                log.warning('Moteur résident indisponible (%s) : lancement classique de %s pour ce travail.', e, exe.name)
        logs = self.root / 'logs'
        logs.mkdir(parents=True, exist_ok=True)
        log_path = logs / ('last-%s.log' % kind)
        timeout = float(model.get('timeout_s') or 1800)
        t0 = time.time()
        trace = EngineTrace(steps)
        self.last_trace = trace
        self.warm(values, trace, stop, progress)
        progress(0.3, 'lancement du moteur')
        with open(log_path, 'wb') as out_log:
            proc = subprocess.Popen(args, cwd=str(exe.parent), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                    env=env, creationflags=flags, **kwargs)
            self.pidfile.write_text(str(proc.pid))
            tail = bytearray()

            def reader():
                for block in iter(lambda: proc.stdout.read1(4096) if hasattr(proc.stdout, 'read1') else proc.stdout.read(4096), b''):
                    out_log.write(block)
                    tail.extend(block)
                    trace.feed(block)
                    if len(tail) > 65536:
                        del tail[:len(tail) - 65536]
            th = threading.Thread(target=reader, daemon=True)
            th.start()
            try:
                while proc.poll() is None:
                    if stop is not None and stop.is_set():
                        raise JobLost('calcul interrompu')
                    if time.time() - t0 > timeout:
                        raise RuntimeError('calcul trop long (plus de %s), arrêté' % fmt_duration(timeout))
                    progress(max(0.3, trace.progress), trace.stage())
                    time.sleep(1)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                th.join(5)
                trace.close()
                self.pidfile.unlink(missing_ok=True)
        compute_s = time.time() - t0
        log.info('Moteur %s : %s', exe.name, json.dumps(trace.summary(), ensure_ascii=False))
        text = bytes(tail).decode('utf-8', 'replace')
        if proc.returncode != 0:
            raise RuntimeError('%s a échoué (code %s) : %s' % (exe.name, proc.returncode, ' | '.join(text.strip().splitlines()[-3:])[-300:]))
        if not out.exists():
            raise RuntimeError('%s n\'a rien écrit' % exe.name)
        meta = trace.summary()
        self.check_output(ext, out, values)
        return out, compute_s, meta

    @staticmethod
    def check_output(ext, out, values):
        if ext == 'png':
            size = png_size(out)
            if not size:
                raise RuntimeError('la sortie n\'est pas un PNG')
            want = (values.get('width'), values.get('height'))
            if None not in want and tuple(size) != tuple(want):
                raise RuntimeError('image de %dx%d au lieu de %dx%d' % (size + want))
        elif ext == 'glb' and not is_glb(out):
            raise RuntimeError('la sortie n\'est pas un fichier GLB valide')

    def warm(self, values, trace, stop, progress):
        """Lecture séquentielle des poids avant un chargement (voir prefetch) ; durée et débit remontés au hub."""
        if self.config.get('gpu_prefetch') is False:
            return
        files = sorted({v for k, v in values.items() if k.startswith('file:')})
        if not files:
            return
        try:
            info = prefetch(files, stop, lambda frac, stage: progress(0.3 * frac, stage))
        except OSError as e:   # un fichier illisible : le moteur le dira mieux
            info = {'prefetch': 'raté : %s' % e}
        trace.meta.update(info)
        log.info('Poids lus avant le moteur : %s', json.dumps(info, ensure_ascii=False))

    def spawn_options(self):
        flags, kwargs = 0, {}
        if IS_WINDOWS:
            flags = subprocess.CREATE_NO_WINDOW | (subprocess.BELOW_NORMAL_PRIORITY_CLASS if self.config.get('low_priority', True) else 0)
        elif self.config.get('low_priority', True):
            kwargs['preexec_fn'] = lambda: os.nice(10)
        return flags, kwargs

    # ---- moteur résident : les poids (11 Go) chargés une fois pour une série de travaux ------------------
    def keep_loaded_s(self):
        try:
            return max(0.0, float(self.config.get('gpu_keep_loaded_s', GPU_KEEP_LOADED_S)))
        except (TypeError, ValueError):
            return float(GPU_KEEP_LOADED_S)

    def local(self, method, path, body=None, timeout=30):
        """Requête au moteur résident, sur 127.0.0.1 seulement, sans proxy. -> (statut, json ou None)."""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request('http://127.0.0.1:%d%s' % (self.server['port'], path), data=data, method=method,
                                     headers={'Content-Type': 'application/json'} if data else {})
        try:
            with opener.open(req, timeout=timeout) as r:
                text = r.read()
                return r.status, (json.loads(text) if text[:1] in (b'{', b'[') else None)
        except urllib.error.HTTPError as e:
            text = e.read()
            try:
                return e.code, json.loads(text)
            except ValueError:
                return e.code, {'error': text[:300].decode('utf-8', 'replace')}

    def start_server(self, spec, exe, values, env, key, timeout, stop, progress):
        exe_dir = Path(exe).parent
        name = spec['exe'][:-4] if not IS_WINDOWS and spec['exe'].endswith('.exe') else spec['exe']
        server_exe = exe_dir / name
        if not server_exe.exists():
            raise ServerUnavailable('%s absent du paquet' % spec['exe'])
        probe = socket.socket()
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
        probe.close()
        args = [str(server_exe)] + build_command(spec['command'], dict(values, port=port))
        flags, kwargs = self.spawn_options()
        logs = self.root / 'logs'
        logs.mkdir(parents=True, exist_ok=True)
        out_log = open(logs / 'server-image.log', 'wb')
        proc = subprocess.Popen(args, cwd=str(exe_dir), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                env=env, creationflags=flags, **kwargs)
        self.server_pidfile.write_text(str(proc.pid))
        box = {'trace': None, 'written': 0}

        def reader():
            for block in iter(lambda: proc.stdout.read1(4096) if hasattr(proc.stdout, 'read1') else proc.stdout.read(4096), b''):
                if box['written'] < (50 << 20):   # journal borné : un moteur résident peut parler des heures
                    out_log.write(block)
                    out_log.flush()
                    box['written'] += len(block)
                t = box['trace']
                if t is not None:
                    t.feed(block)
            out_log.close()
        th = threading.Thread(target=reader, daemon=True)
        self.server = {'proc': proc, 'port': port, 'key': key, 'box': box, 'thread': th, 'last_used': time.time()}
        return th

    def stop_server(self, why=''):
        srv, self.server = self.server, None
        if not srv:
            return
        if srv['proc'].poll() is None:
            srv['proc'].kill()
            try:
                srv['proc'].wait(30)
            except subprocess.TimeoutExpired:
                pass
        srv['thread'].join(5)
        self.server_pidfile.unlink(missing_ok=True)
        if why:
            log.info('Moteur image résident arrêté (%s) : carte libérée.', why)

    def idle(self):
        """Appelé par la boucle du worker : décharge le moteur résident après gpu_keep_loaded_s sans travail."""
        if self.server and (self.server['proc'].poll() is not None or time.time() - self.server['last_used'] > self.keep_loaded_s()):
            self.stop_server('%s sans travail' % fmt_duration(self.keep_loaded_s()) if self.server['proc'].poll() is None else 'il s\'était arrêté')

    def run_server(self, spec, exe, values, env, input_path, out, steps, stop, progress, timeout):
        """Un travail sur le moteur résident (sd-server, API sdapi). Démarré au besoin : le premier travail d'une série paie
        le chargement des poids, les suivants non. -> (secondes, méta)."""
        # Même ligne de commande (fichiers, attention, tuiles, fils) et même environnement = même moteur ; sinon il est relancé
        key = json.dumps([str(exe), build_command(spec['command'], dict(values, port=0)), sorted((k, v) for k, v in env.items() if k.startswith('GGML'))])
        if key in self.server_refused:
            raise ServerUnavailable('a déjà refusé de démarrer avec cette configuration')
        if self.server and (self.server['key'] != key or self.server['proc'].poll() is not None):
            self.stop_server('configuration changée' if self.server['key'] != key else 'il s\'était arrêté')
        trace = EngineTrace(steps)
        self.last_trace = trace
        t0 = time.time()
        fresh = self.server is None
        if fresh:
            self.warm(values, trace, stop, progress)
            th = self.start_server(spec, exe, values, env, key, timeout, stop, progress)
            self.server['box']['trace'] = trace
            th.start()
            progress(0.3, 'chargement du moteur')
            while True:   # prêt quand l'API répond : les poids sont alors chargés
                if stop is not None and stop.is_set():
                    self.stop_server()
                    raise JobLost('calcul interrompu')
                if self.server['proc'].poll() is not None:
                    self.server_refused.add(key)
                    self.stop_server()
                    raise ServerUnavailable('arrêté au démarrage : %s' % ' | '.join(trace.lines[-3:])[-300:])
                if time.time() - t0 > timeout:
                    self.stop_server()
                    raise RuntimeError('moteur résident pas prêt après %s' % fmt_duration(timeout))
                try:
                    if self.local('GET', '/sdapi/v1/options', timeout=5)[0] == 200:
                        break
                except OSError:
                    pass
                progress(max(0.3, trace.progress), trace.stage())
                time.sleep(1)
            trace.meta['server_start_s'] = round(time.time() - t0, 1)
        else:
            self.server['box']['trace'] = trace
            trace.meta['server_reused'] = True
        # sd-server lit des réglages cachés dans le texte (<sd_cpp_extra_args>, chemins de fichiers compris) : jamais d'un client
        clean = lambda text: re.sub(r'(?i)sd_cpp_extra_args', '', str(text or ''))
        body = {'prompt': clean(values.get('prompt')), 'negative_prompt': clean(values.get('negative_prompt')),
                'width': values.get('width'), 'height': values.get('height'), 'steps': values.get('steps'),
                'cfg_scale': values.get('cfg_scale'), 'seed': values.get('seed'), 'sampler_name': values.get('sampler', ''),
                'batch_size': 1}
        route = '/sdapi/v1/txt2img'
        if input_path is not None:
            body['init_images'] = [base64.b64encode(Path(input_path).read_bytes()).decode()]
            body['denoising_strength'] = values.get('strength')
            route = '/sdapi/v1/img2img'
        answer = {}

        def call():
            try:
                answer['r'] = self.local('POST', route, body, timeout=timeout)
            except OSError as e:
                answer['e'] = e
        caller = threading.Thread(target=call, daemon=True)
        t1 = time.time()
        caller.start()
        while caller.is_alive():
            if stop is not None and stop.is_set():
                self.stop_server('travail annulé')   # sd-server ne sait pas interrompre une génération
                raise JobLost('calcul interrompu')
            if self.server['proc'].poll() is not None:
                break
            progress(max(0.35, trace.progress), trace.stage() if trace.step is not None else 'calcul')
            caller.join(1)
        caller.join(5)
        self.server['last_used'] = time.time()
        if self.server['proc'].poll() is not None:
            lines = ' | '.join(trace.lines[-3:])[-300:]
            self.stop_server()
            raise RuntimeError('le moteur résident s\'est arrêté pendant le calcul : %s' % lines)
        if 'e' in answer:
            self.stop_server()
            raise RuntimeError('moteur résident injoignable : %s' % answer['e'])
        status, data = answer.get('r', (0, None))
        images = (data or {}).get('images') or []
        if status != 200 or not images:
            raise RuntimeError('le moteur résident a refusé (HTTP %s) : %s' % (status, str((data or {}).get('error') or (data or {}).get('message') or data)[:300]))
        out.write_bytes(base64.b64decode(images[0]))
        meta = trace.summary()
        meta['generate_s'] = round(time.time() - t1, 1)
        meta.setdefault('backend', 'vulkan')
        log.info('Moteur résident : %s', json.dumps(meta, ensure_ascii=False))
        return time.time() - t0, meta


# --------------------------------------------------------------------------------------------
# Worker
# --------------------------------------------------------------------------------------------
class Worker:
    def __init__(self, base, launcher):
        self.base = base
        self.app = Path(__file__).resolve().parent
        self.launcher = Path(launcher) if launcher else None
        self.config = read_json(base / 'reuse-worker.config.json')
        if not isinstance(self.config, dict) or not self.config.get('hub_url') or not self.config.get('token'):
            raise SystemExit('Config absente ou incomplète : %s (voir reuse-worker.config.example.json)' % (base / 'reuse-worker.config.json'))
        if not str(self.config['hub_url']).startswith('https://') and not self.config.get('allow_http'):
            raise SystemExit('hub_url doit commencer par https:// (le jeton ne circule jamais en clair)')
        self.local_config = dict(self.config)   # le fichier du PC ; le hub peut poser par-dessus quelques réglages (REMOTE_SETTINGS)
        self.remote_settings = {}
        self.hub = Hub(self.config['hub_url'], self.config['token'])
        self.version = (self.app / 'version.txt').read_text().strip() if (self.app / 'version.txt').exists() else 'dev'
        self.engine = Engine(base, self.config)
        self.gpu = Gpu(base, self.config, self.app, self.engine)
        self.work = base / 'work'
        self.state = {'state': 'démarrage', 'job': None, 'last_error': None}
        self.paused_logged = False
        self.refused_version = None
        self.engine_failures = 0

    # ---- état lisible ---------------------------------------------------------------------
    def bad_versions(self):
        try:
            return set((self.base / 'bad-versions.txt').read_text().split())
        except OSError:
            return set()

    def info(self):
        return {
            'version': self.version, 'backend': self.engine.backend + ((' (repli : %s)' % self.engine.note) if self.engine.note else ''),
            'device': self.engine.device_name, 'os': '%s %s' % (platform.system(), platform.release()), 'host': socket.gethostname(),
            'state': self.state['state'], 'job': self.state['job'], 'last_error': self.state['last_error'],
            'rolled_back_from': self.refused_version,   # version publiée que cette machine refuse (elle a planté ici)
            'update_ack': (read_json(self.base / 'update-ack.json', {}) or {}).get('order'),
            'gpu': ','.join(self.gpu.types()),        # types de génération proposés (le hub n'en donne pas d'autres)
            'gpu_state': self.gpu.describe() or None,
            'tests': ','.join(GPU_TEST_KINDS),         # essais GPU que cette version sait faire sur ordre du hub
        }

    def set_state(self, state, job=None):
        self.state.update(state=state, job=job)
        info = self.info()
        info['updated_at'] = time.strftime('%Y-%m-%d %H:%M:%S')
        try:
            write_json(self.base / 'logs' / 'state.json', info)
        except OSError:
            pass

    def report(self):
        """Dit au hub où on en est, sans réclamer de job (pour qu'une panne d'installation se voie à distance)."""
        try:
            self.hub.request('POST', '/api/reuse/worker/status', body={'info': self.info()}, timeout=30)
        except OSError:
            pass

    # ---- mise à jour automatique ----------------------------------------------------------
    def update(self, published, order=0):
        """Installe la version publiée par le hub si elle diffère (ou si un ordre le demande). Ne revient pas si mise à jour."""
        if self.app != self.base / 'app':
            return   # lancé hors de son dossier d'installation (développement) : jamais de remplacement de fichiers
        if not order:
            if published in (self.version, 'none', None):
                self.refused_version = None   # le hub publie de nouveau la version en place
                return
            if published in self.bad_versions():
                if self.refused_version != published:
                    self.refused_version = published
                    log.warning('La version %s publiée par le hub a planté au démarrage ici : je reste en %s jusqu\'à la prochaine publication.', published, self.version)
                return
        try:
            status, manifest = self.hub.request('GET', '/api/reuse/worker/manifest')
            if status != 200 or not manifest or not manifest.get('files'):
                raise OSError('manifeste indisponible (HTTP %s)' % status)
            log.info('Mise à jour : version %s -> %s%s', self.version, manifest['version'], ' (ordre du hub)' if order else '')
            new = self.base / 'app.new'
            rmtree(new)
            new.mkdir(parents=True)
            for f in manifest['files']:
                name = f['name']
                if not safe_file_name(name):
                    raise ValueError('nom de fichier refusé : %r' % (name,))
                status, _ = self.hub.request('GET', '/api/reuse/worker/files/' + name, dest=new / name, timeout=120)
                if status != 200 or sha256_file(new / name) != f['sha256']:
                    raise ValueError('fichier %s : empreinte incorrecte, mise à jour abandonnée' % name)
                if name.endswith('.py'):
                    py_compile.compile(str(new / name), cfile=str(new / (name + 'c.check')), doraise=True)
                    (new / (name + 'c.check')).unlink(missing_ok=True)
            if not (new / 'reuse_worker.py').exists():
                raise ValueError('le manifeste ne contient pas reuse_worker.py')
            (new / 'version.txt').write_text(manifest['version'])
        except (OSError, ValueError, py_compile.PyCompileError) as e:
            log.warning('Mise à jour impossible pour l\'instant (%s). Je continue en %s.', (str(e).strip().splitlines() or ['?'])[-1], self.version)
            rmtree(self.base / 'app.new')
            return
        if order:  # acquitté avant de relancer : un ordre n'est exécuté qu'une fois, même si la nouvelle version échoue
            write_json(self.base / 'update-ack.json', {'order': order})
        prev = self.base / 'app.prev'
        try:
            rmtree(prev)
            os.replace(self.app, prev)          # l'ancienne version reste là pour le retour arrière
            try:
                os.replace(new, self.app)
            except OSError:
                os.replace(prev, self.app)      # on remet l'ancienne en place
                raise
        except OSError as e:
            log.warning('Mise à jour impossible pour l\'instant (fichiers occupés : %s). Je continue en %s.', e, self.version)
            rmtree(new)
            return
        launcher_changed = self.update_launcher(self.app)
        log.info('Version %s installée, redémarrage.', manifest['version'])
        logging.shutdown()
        sys.exit(EXIT_LAUNCHER_UPDATED if launcher_changed else EXIT_UPDATED)

    def update_launcher(self, new):
        """Remplace le lanceur s'il a changé, après contrôle de syntaxe ; l'ancien est gardé en .prev."""
        if not self.launcher or self.launcher.name not in LAUNCHERS:
            return False
        fresh = new / self.launcher.name
        if not fresh.exists() or not self.launcher.exists() or sha256_file(fresh) == sha256_file(self.launcher):
            return False
        try:
            if self.launcher.suffix == '.ps1':
                shell = shutil.which('powershell') or shutil.which('pwsh')
                ok = bool(shell) and subprocess.run([shell, '-NoProfile', '-NonInteractive', '-Command', PS_CHECK], timeout=120,
                                                    env=dict(os.environ, **{PS_CHECK_VAR: str(fresh)}), stdin=subprocess.DEVNULL,
                                                    creationflags=subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0).returncode == 0
            else:
                ok = subprocess.run(['bash', '-n', str(fresh)], timeout=60).returncode == 0
            if not ok:
                raise ValueError('erreur de syntaxe')
            shutil.copy2(self.launcher, str(self.launcher) + '.prev')
            tmp = Path(str(self.launcher) + '.new')
            shutil.copy2(fresh, tmp)
            if not IS_WINDOWS:
                os.chmod(tmp, 0o755)
            os.replace(tmp, self.launcher)
            log.info('Lanceur %s mis à jour (ancien gardé en .prev).', self.launcher.name)
            return True
        except (OSError, ValueError, subprocess.SubprocessError) as e:
            log.warning('Nouveau lanceur refusé (%s) : l\'ancien reste en place.', e)
            return False

    # ---- un job ---------------------------------------------------------------------------
    def process(self, job):
        jid = job['id']
        seconds = job['samples'] / job['rate']
        jobdir = self.work / ('job-%d' % jid)
        for other in self.work.glob('job-*'):   # restes d'un autre job : plus à nous
            if other != jobdir:
                rmtree(other)
        jobdir.mkdir(parents=True, exist_ok=True)
        src, dst, meta = jobdir / 'in.flac', jobdir / 'out.flac', jobdir / 'done.json'
        label = '%s (%s, essai %d)' % (job['name'], fmt_duration(seconds), job['attempt'])
        self.set_state('nettoyage', job['name'])

        stop = threading.Event()   # levé si le hub reprend le job
        finished = threading.Event()

        def beat():
            # Dès le début puis régulièrement : garde le bail et dit au hub que cette machine travaille
            period = max(10, min(60, job.get('lease_s', 600) // 5))
            while True:
                try:
                    status, _ = self.hub.request('POST', '/api/reuse/jobs/%d/heartbeat' % jid, body={'info': self.info()}, timeout=30)
                    if status in (404, 409):
                        stop.set()
                        return
                except OSError:
                    pass  # réseau coupé : on continue le calcul, le résultat sera envoyé au retour
                if finished.wait(period):
                    return

        threading.Thread(target=beat, daemon=True).start()
        try:
            # Un job sur lequel le worker lui-même plante à répétition est rendu au hub au lieu d'être repris sans fin
            starts = (read_json(jobdir / 'starts.json', {}) or {}).get('n', 0) + 1
            write_json(jobdir / 'starts.json', {'n': starts})
            if starts > 3:
                raise RuntimeError('le worker s\'est arrêté %d fois sur ce job' % (starts - 1))
            done = read_json(meta)
            if done and done.get('in_sha256') == job['sha256'] and dst.exists() and sha256_file(dst) == done.get('out_sha256'):
                log.info('Reprise : %s était déjà nettoyé avant la coupure, envoi du résultat.', label)
            else:
                if not (src.exists() and sha256_file(src) == job['sha256']):
                    log.info('Job %d : téléchargement de %s', jid, label)

                    def fetch():
                        status, body = self.hub.request('GET', '/api/reuse/jobs/%d/input' % jid, dest=src, timeout=300)
                        if status in (404, 409):
                            raise JobLost((body or {}).get('error', 'job repris'))
                        if status != 200:
                            raise Refused(status, (body or {}).get('error', 'téléchargement refusé'))
                        if sha256_file(src) != job['sha256']:
                            raise OSError('fichier reçu abîmé')
                    self.hub.retrying('Téléchargement', fetch)
                log.info('Job %d : nettoyage sur %s', jid, self.engine.describe())
                try:
                    compute_s, level = self.engine.clean(src, dst, jobdir, job.get('params') or {}, stop)
                except (OSError, subprocess.SubprocessError) as e:   # disque plein, outil bloqué : une panne locale, pas le réseau
                    raise RuntimeError('panne locale pendant le nettoyage : %s' % e)
                done = {'in_sha256': job['sha256'], 'out_sha256': sha256_file(dst), 'compute_s': round(compute_s, 1)}
                write_json(meta, done)
                log.info('Job %d : nettoyé en %s (%.2f s de calcul par seconde d\'audio)', jid, fmt_duration(compute_s), compute_s / max(seconds, 0.001))
                if level < 1e-4:
                    log.warning('Job %d : la sortie est presque silencieuse (normal seulement si l\'entrée ne contient pas de voix).', jid)

            payload = dst.read_bytes()

            def send():
                status, body = self.hub.request('POST', '/api/reuse/jobs/%d/result?compute_s=%s&backend=%s' % (jid, done['compute_s'], self.engine.backend),
                                                raw=payload, headers={'X-Sha256': done['out_sha256']}, timeout=600)
                if status == 200:
                    return
                if status in (404, 409):
                    raise JobLost((body or {}).get('error', 'job repris'))
                if status == 400:
                    raise OSError('envoi abîmé en route')
                raise Refused(status, (body or {}).get('error', 'résultat refusé'))
            self.hub.retrying('Envoi du résultat', send, tries=12)
            log.info('Job %d : résultat accepté par le hub.', jid)
            self.state['last_error'] = None
            self.engine_failures = 0
            rmtree(jobdir)
        except JobLost as e:
            log.warning('Job %d abandonné : le hub l\'a repris ou annulé (%s).', jid, e)
            rmtree(jobdir)
        except Refused as e:
            log.error('Job %d : %s. Le hub le remettra en file.', jid, e)
            self.state['last_error'] = 'job %d : %s' % (jid, e)
            rmtree(jobdir)
            # Un refus que le hub n'a pas compté lui-même (résultat trop gros, par exemple) laisse le bail à cette
            # machine : sans ce signalement, elle reprendrait le même job et le recalculerait sans fin.
            # Si le hub l'a déjà remis en file (422), il répond 409 et rien ne change.
            self.give_back(jid, e)
        except OSError as e:
            # Hub injoignable trop longtemps : on garde le travail fait, il repartira à la reconnexion
            log.error('Job %d en attente : %s. Le travail fait est gardé dans %s.', jid, e, jobdir)
            self.state['last_error'] = 'job %d : %s' % (jid, e)
        except (RuntimeError, ValueError) as e:
            log.error('Job %d raté : %s', jid, e)
            self.state['last_error'] = 'job %d : %s' % (jid, e)
            self.engine_failures += 1
            rmtree(jobdir)
            self.give_back(jid, e)
        finally:
            finished.set()
            self.set_state('en attente')

    # ---- un job GPU (image, 3D) --------------------------------------------------------
    def process_gpu(self, job):
        """Même déroulé qu'un nettoyage : bail entretenu, reprise après coupure, résultat vérifié, rendu en cas d'échec."""
        jid, kind = job['id'], job['kind']
        route = '/api/gpu/jobs/'
        jobdir = self.work / ('gpu-%d' % jid)
        for other in self.work.glob('gpu-*'):
            if other != jobdir:
                rmtree(other)
        jobdir.mkdir(parents=True, exist_ok=True)
        meta_file = jobdir / 'done.json'
        label = '%s %s (%s, essai %d)' % (kind, jid, job.get('model'), job.get('attempt', 1))
        self.set_state('génération %s' % kind, '%s %d' % (kind, jid))
        stop, finished = threading.Event(), threading.Event()
        now = {'progress': 0.0, 'stage': 'préparation'}
        self.gpu.last_trace = None   # journal du moteur de CE travail (rempli par Gpu.run)

        def progress(frac, stage):
            now.update(progress=round(max(0.0, min(1.0, frac)), 3), stage=stage)

        def beat():
            # Plus fréquent qu'un nettoyage : l'avancement se voit côté client et une annulation arrête la carte vite
            period = max(5, min(15, job.get('lease_s', 600) // 5))
            while True:
                try:
                    status, _ = self.hub.request('POST', '%s%d/heartbeat' % (route, jid), body=self.gpu_beat(now), timeout=30)
                    if status in (404, 409):
                        stop.set()
                        return
                except OSError:
                    pass
                if finished.wait(period):
                    return

        threading.Thread(target=beat, daemon=True).start()
        try:
            if kind not in self.gpu.types():
                raise RuntimeError('type %s non proposé par cette machine' % kind)
            starts = (read_json(jobdir / 'starts.json', {}) or {}).get('n', 0) + 1
            write_json(jobdir / 'starts.json', {'n': starts})
            if starts > 3:
                raise RuntimeError('le worker s\'est arrêté %d fois sur ce job' % (starts - 1))
            done = read_json(meta_file)
            out = jobdir / (done or {}).get('file', '-')
            if done and out.exists() and sha256_file(out) == done.get('sha256'):
                log.info('Reprise : %s était déjà calculé avant la coupure, envoi du résultat.', label)
            else:
                src = None
                if job.get('input'):
                    fmt = job['input'].get('format')
                    if fmt not in ('png', 'jpg', 'webp'):
                        raise RuntimeError('format d\'entrée inattendu : %r' % fmt)
                    src = jobdir / ('in.' + fmt)
                    if not (src.exists() and sha256_file(src) == job['input']['sha256']):
                        def fetch():
                            status, body = self.hub.request('GET', '%s%d/input' % (route, jid), dest=src, timeout=300)
                            if status in (404, 409):
                                raise JobLost((body or {}).get('error', 'job repris'))
                            if status != 200:
                                raise Refused(status, (body or {}).get('error', 'téléchargement refusé'))
                            if sha256_file(src) != job['input']['sha256']:
                                raise OSError('image reçue abîmée')
                        self.hub.retrying('Téléchargement de l\'image d\'entrée', fetch)
                log.info('Job %s : %s', label, (job.get('prompt') or '')[:120])
                try:
                    out, compute_s, meta = self.gpu.run(job, src, jobdir, stop, progress)
                except (OSError, subprocess.SubprocessError) as e:
                    raise RuntimeError('panne locale pendant la génération : %s' % e)
                done = {'file': out.name, 'sha256': sha256_file(out), 'compute_s': round(compute_s, 1), 'meta': meta}
                write_json(meta_file, done)
                log.info('Job %s : calculé en %s.', label, fmt_duration(compute_s))
            payload = out.read_bytes()
            self.final_beat(route, jid, now)   # journal complet du moteur, avant le résultat
            backend = str((done.get('meta') or {}).get('backend') or 'vulkan')
            query = urllib.parse.urlencode({'compute_s': done['compute_s'], 'backend': backend, 'meta': json.dumps(done.get('meta') or {})})

            def send():
                status, body = self.hub.request('POST', '%s%d/result?%s' % (route, jid, query), raw=payload, timeout=600,
                                                headers={'X-Sha256': done['sha256'], 'Content-Type': 'application/octet-stream'})
                if status == 200:
                    return
                if status in (404, 409):
                    raise JobLost((body or {}).get('error', 'job repris'))
                if status == 400:
                    raise OSError('envoi abîmé en route')
                raise Refused(status, (body or {}).get('error', 'résultat refusé'))
            self.hub.retrying('Envoi du résultat', send, tries=12)
            log.info('Job %s : résultat accepté par le hub.', label)
            self.state['last_error'] = None
            rmtree(jobdir)
        except JobLost as e:
            log.warning('Job %s abandonné : le hub l\'a repris ou annulé (%s).', label, e)
            rmtree(jobdir)
        except Refused as e:
            log.error('Job %s : %s.', label, e)
            self.state['last_error'] = 'job %s : %s' % (label, e)
            rmtree(jobdir)
            self.final_beat(route, jid, now)
            self.give_back(jid, e, route)
        except OSError as e:
            log.error('Job %s en attente : %s. Le travail fait est gardé dans %s.', label, e, jobdir)
            self.state['last_error'] = 'job %s : %s' % (label, e)
        except (RuntimeError, ValueError, KeyError) as e:
            log.error('Job %s raté : %s', label, e)
            self.state['last_error'] = 'job %s : %s' % (label, e)
            self.gpu.status[kind] = 'échec : %s' % str(e)[:120]
            rmtree(jobdir)
            self.final_beat(route, jid, now)
            self.give_back(jid, e, route)
        finally:
            finished.set()
            self.set_state('en attente')

    def gpu_beat(self, now):
        """Corps d'un signe de vie GPU : avancement, étape lisible, et lignes utiles du moteur (carte, plan mémoire, temps)."""
        body = dict(now, info=self.info())
        trace = getattr(self.gpu, 'last_trace', None)
        if trace is not None:
            body['log'] = list(trace.lines)
            body['meta'] = trace.summary()
        return body

    def final_beat(self, route, jid, now):
        if getattr(self.gpu, 'last_trace', None) is None:
            return
        try:
            self.hub.request('POST', '%s%d/heartbeat' % (route, jid), body=self.gpu_beat(now), timeout=30)
        except OSError:
            pass

    def give_back(self, jid, reason, route='/api/reuse/jobs/'):
        """Rend le job au hub en comptant l'essai (au bout du dernier, le hub le déclare en échec)."""
        try:
            self.hub.request('POST', '%s%d/fail' % (route, jid), body={'error': str(reason)[:300]}, timeout=30)
        except OSError:
            pass

    def single_instance(self):
        """Verrou tenu tant que ce processus vit : jamais deux workers dans le même dossier (lanceur relancé
        alors que l'ancien worker tourne encore)."""
        self.lock = open(self.base / '.worker.lock', 'a+')
        try:
            if IS_WINDOWS:
                import msvcrt
                self.lock.seek(0)
                msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    # ---- boucle principale ----------------------------------------------------------------
    def run(self):
        self.work.mkdir(exist_ok=True)
        if not self.single_instance():
            log.warning('Un autre worker tourne déjà dans ce dossier : je lui laisse la place.')
            return EXIT_NOT_READY
        log.info('Worker RE-USE version %s, dossier %s', self.version, self.base)
        # 1. se mettre à jour avant tout (si le hub répond) : même une version dont le moteur ne démarre plus
        #    passe par ici, donc publier un correctif suffit à la réparer
        try:
            status, body = self.hub.request('POST', '/api/reuse/worker/status', body={'info': self.info()}, timeout=60)
            if status == 403:
                raise SystemExit('Le hub refuse le jeton : vérifier "token" dans reuse-worker.config.json.')
            if status == 200 and body:
                self.apply_orders(body.get('orders') or {}, tests=False)   # un essai attendra que le moteur soit prêt
        except OSError as e:
            log.warning('Hub injoignable au démarrage (%s) : je continue avec la version installée.', e)
        # 2. moteur
        self.set_state('installation')
        try:
            self.engine.setup()
        except (RuntimeError, OSError) as e:   # téléchargement, pilote, outil manquant : pas une faute de cette version
            log.error('Installation du moteur incomplète : %s', e)
            self.state['last_error'] = 'installation : %s' % e
            self.report()
            return EXIT_NOT_READY
        kill_orphan(self.gpu.pidfile, (b'sd-cli', b'trellis-cli'))
        kill_orphan(self.gpu.server_pidfile, (b'sd-server',))
        try:
            comfy_kill_orphan(comfy_layout(self.base, comfy_spec(self.app)))   # essai ComfyUI coupé par un arrêt du worker
        except (RuntimeError, KeyError):
            pass
        skipped = {}
        if self.gpu.types(skipped):
            log.info('Générations GPU proposées : %s', self.gpu.describe())
        for t, why in sorted(skipped.items()):
            log.info('Génération %s non proposée ici : %s.', t, why)
        (self.app / '.ok').write_text(time.strftime('%Y-%m-%d %H:%M:%S'))   # cette version démarre : le lanceur ne reviendra pas en arrière
        self.set_state('en attente')
        job = None
        orders = {}
        errors = 0
        while True:
            self.gpu.idle()
            if (self.base / 'STOP').exists():
                self.gpu.stop_server('arrêt du worker')
                log.info('Fichier STOP présent : arrêt. Le supprimer pour relancer.')
                return EXIT_STOP
            if job:
                if job.get('kind', 'reuse') == 'reuse':
                    self.process(job)
                else:
                    self.process_gpu(job)
                job = None
                # Ordres reçus avec ce job (mise à jour publiée ou forcée) : appliqués entre deux jobs, sinon une
                # file jamais vide retarderait indéfiniment un correctif du worker
                self.apply_orders(orders)
                if self.engine_failures:
                    # Moteur en panne ici : attendre de plus en plus avant de reprendre un job, pour ne pas
                    # épuiser les essais de toute la file alors qu'une autre machine pourrait la traiter
                    pause = min(900, 30 * 2 ** (self.engine_failures - 1))
                    log.warning('%d échec(s) de calcul de suite : pause de %s avant le prochain job.', self.engine_failures, fmt_duration(pause))
                    self.set_state('pause après échec')
                    time.sleep(pause)
                continue
            t0 = time.time()
            try:
                status, body = self.hub.request('POST', '/api/reuse/next', body={'wait': 25, 'info': self.info()}, timeout=60)
                if status == 403:
                    raise SystemExit('Le hub refuse le jeton : vérifier "token" dans reuse-worker.config.json.')
                if status != 200 or body is None:
                    raise OSError((body or {}).get('error', 'réponse inattendue (HTTP %s)' % status))
                if errors:
                    log.info('Hub de nouveau joignable.')
                errors = 0
            except OSError as e:
                errors += 1
                if errors in (1, 10) or errors % 120 == 0:
                    log.warning('Hub injoignable (%s). Je réessaie sans m\'arrêter.', e)
                time.sleep(min(60, 5 * errors))
                continue
            orders = body.get('orders') or {}
            job = body.get('job')
            self.note_pause(orders)
            if job:
                continue           # une mise à jour attendra la fin du job
            self.apply_orders(orders)
            if time.time() - t0 < 5:
                time.sleep(10)     # réponse immédiate sans job : ne pas marteler le hub

    def note_pause(self, orders):
        paused = bool(orders.get('paused'))
        if paused != self.paused_logged:
            log.info('Ordre du hub : %s.', 'pause (aucun nouveau job)' if paused else 'reprise')
            self.paused_logged = paused
        self.state['state'] = 'en pause' if paused else 'en attente'

    def apply_orders(self, orders, tests=True):
        self.note_pause(orders)
        self.apply_settings(orders.get('settings'))
        order = int(orders.get('update') or 0)
        acked = (read_json(self.base / 'update-ack.json', {}) or {}).get('order')
        self.update(orders.get('worker_version'), order if order and order != acked else 0)
        test = orders.get('gpu_test')
        if tests and isinstance(test, dict) and test.get('id') and not orders.get('paused'):
            self.run_remote_test(test)

    def apply_settings(self, settings):
        """Réglages posés par le hub par-dessus le fichier du PC. Seules les clés de REMOTE_SETTINGS, du bon type, sont prises ;
        une clé que le hub retire revient à la valeur du fichier. Le même dict est lu par Gpu et Engine : modifié sur place."""
        if not isinstance(settings, dict):
            return
        kept = {}
        for k, v in settings.items():
            kinds = REMOTE_SETTINGS.get(k)
            if kinds and isinstance(v, kinds) and not (bool not in kinds and isinstance(v, bool)):
                kept[k] = v
        if kept == self.remote_settings:
            return
        before = {k: self.config.get(k) for k in set(kept) | set(self.remote_settings)}
        merged = dict(self.local_config, **kept)
        self.config.clear()
        self.config.update(merged)
        self.remote_settings = kept
        changes = ['%s : %s -> %s' % (k, before[k], self.config.get(k)) for k in sorted(before) if before[k] != self.config.get(k)]
        log.info('Réglages du hub appliqués (%s)%s.', ', '.join(changes) or 'aucun changement effectif',
                 '' if kept else ' : retour au fichier de config')
        if self.gpu.server and before.get('gpu_keep_loaded_s') != self.config.get('gpu_keep_loaded_s'):
            self.gpu.idle()

    def run_remote_test(self, test):
        """Essai GPU demandé par le hub (POST /api/reuse/workers/:nom/tests), entre deux travaux : même code que --gpu-test.
        Avancement envoyé toutes les 20 s (le hub peut annuler), rapport final remonté et écrit dans logs/gpu-test.json."""
        tid, kind = int(test['id']), str(test.get('kind'))
        route = '/api/reuse/worker/tests/%d' % tid
        now = {'progress': 0.0, 'stage': 'préparation'}
        stop, finished = threading.Event(), threading.Event()

        def post(body, timeout=30):
            status, answer = self.hub.request('POST', route, body=body, timeout=timeout)
            if status in (404, 409) or (status == 200 and (answer or {}).get('cancel')):
                stop.set()
            return status

        try:   # d'abord dire « je commence » : le hub ne redonnera plus cet essai, même si ce worker redémarre
            if post({'status': 'running', 'stage': 'préparation', 'progress': 0, 'info': self.info()}) != 200:
                log.warning('Essai GPU %d refusé par le hub (annulé ou déjà fini) : ignoré.', tid)
                return
        except OSError as e:
            log.warning('Essai GPU %d : hub injoignable (%s), il sera redonné.', tid, e)
            return
        if kind not in GPU_TEST_KINDS:
            post({'status': 'failed', 'report': {'ok': False, 'error': 'essai %r inconnu de cette version' % kind}})
            return
        log.info('Essai GPU %d (%s) demandé par le hub : %s', tid, kind, json.dumps(test.get('params') or {}))
        self.set_state('essai %s' % kind, 'essai %d' % tid)
        self.gpu.stop_server('essai GPU demandé')   # la carte entière pour l'essai

        def progress(frac, stage):
            now.update(progress=round(max(0.0, min(1.0, frac)), 3), stage=str(stage)[:200])

        def beat():
            while not finished.wait(20):
                try:
                    post({'status': 'running', 'stage': now['stage'], 'progress': now['progress'], 'info': self.info()})
                except OSError:
                    pass
        threading.Thread(target=beat, daemon=True).start()
        # 3D : image d'objet livrée avec le worker (tasse rendue maison, sans licence tierce) : l'essai ne dépend pas du moteur image
        bundled = self.app / GPU_TEST_OBJECT
        try:
            report = gpu_test_report(self.base, dict(self.config), kind, test.get('params') or {},
                                     bundled if kind == '3d' and bundled.exists() else None, stop, progress)
        finally:
            finished.set()
        report['test_id'] = tid
        write_json(self.base / 'logs' / 'gpu-test.json', report)
        log.info('ESSAI GPU %d %s : %s', tid, 'REUSSI' if report.get('ok') else 'RATE', json.dumps(report, ensure_ascii=False)[:2000])
        if stop.is_set() and not report.get('ok'):
            report.setdefault('error', 'annulé par le hub')
        out = Path(report['output']) if report.get('output') else None
        if out is not None and out.suffix in ('.png', '.glb') and out.exists() and out.stat().st_size <= (96 << 20):
            try:   # le fichier lui-même (image, GLB), pour le regarder : avant le rapport final, le hub le rattache à l'essai
                data = out.read_bytes()
                status, answer = self.hub.request('POST', '%s/output?ext=%s' % (route, out.suffix[1:]), raw=data, timeout=300,
                                                  headers={'X-Sha256': hashlib.sha256(data).hexdigest(), 'Content-Type': 'application/octet-stream'})
                report['output_sent'] = status == 200
                if status != 200:
                    log.warning('Fichier de l\'essai %d refusé par le hub (HTTP %s : %s).', tid, status, (answer or {}).get('error'))
            except OSError as e:
                report['output_sent'] = False
                log.warning('Fichier de l\'essai %d non envoyé (%s).', tid, e)
        try:
            self.hub.retrying('Envoi du rapport d\'essai', lambda: post({'status': 'done' if report.get('ok') else 'failed', 'report': report,
                                                                          'info': self.info()}, timeout=60), tries=5)
        except (OSError, Refused) as e:
            log.warning('Rapport de l\'essai %d non remis (%s) : il reste dans logs/gpu-test.json.', tid, e)
        self.set_state('en attente')


CRASH_TEST_SECONDS = float(os.environ.get('REUSE_CRASH_TEST_SECONDS') or 10.0)   # variable : tests seulement


def crash_test(base):
    """Essai complet sans hub ni jeton : installe le moteur, liste les cartes, autotest GPU contre processeur,
    puis nettoie 10 s de parole par la même chaîne qu'un vrai job (FLAC -> moteur -> FLAC).
    Écrit logs/crash-test.json (aucun son, aucun secret) et rend 0 si tout est bon."""
    config = read_json(base / 'reuse-worker.config.json', {}) or {}
    engine = Engine(base, {k: v for k, v in config.items() if k not in ('token', 'hub_url')})
    report = {'ok': False, 'at': time.strftime('%Y-%m-%d %H:%M:%S'), 'audiocpp': AUDIOCPP_VERSION,
              'system': '%s %s %s' % (platform.system(), platform.release(), platform.machine()),
              'python': platform.python_version(), 'wanted_backend': str(config.get('backend', 'auto')).lower()}
    work = base / 'work' / 'crash-test'
    try:
        (engine.runtime / 'selftest.json').unlink(missing_ok=True)   # autotest refait : on veut des mesures de ce jour
        engine.setup()
        report.update(backend=engine.backend, device=engine.device_name, note=engine.note or None)
        if report['wanted_backend'] != 'cpu':
            report['gpus'] = [{'index': d.get('index'), 'name': d.get('description') or d.get('name'), 'type': d.get('type'),
                               'memory_gb': round(((d.get('memory') or {}).get('total_bytes') or 0) / 1e9, 1)} for d in engine.list_gpus()]
            memo = read_json(engine.runtime / 'selftest.json', {}) or {}
            report['selftest'] = {k: memo.get(k) for k in ('ok', 'correlation', 'gpu_s', 'cpu_s', 'reason')}
        rmtree(work)
        work.mkdir(parents=True)
        clip = download(SELFTEST_URL, engine.runtime / 'downloads' / 'mic_test2.wav', SELFTEST_SHA256, 'extrait de test NVIDIA')
        rate, channels, samples = read_wav(clip)
        mono = samples[0::channels][:int(CRASH_TEST_SECONDS * rate)]
        write_wav(work / 'in.wav', rate, mono, bits=16)
        engine.encode(work / 'in.wav', work / 'in.flac')
        log.info('Essai : nettoyage de %.1f s de parole sur %s', len(mono) / rate, engine.describe())
        compute_s, level = engine.clean(work / 'in.flac', work / 'out.flac', work, {}, None)
        seconds = len(mono) / rate
        report.update(clip_s=round(seconds, 2), rate=rate, compute_s=round(compute_s, 1), rtf=round(compute_s / seconds, 3),
                      out_level=round(level, 5), out_matches_length=flac_info(work / 'out.flac') == (rate, 1, len(mono)))
        on_gpu = engine.backend == 'vulkan' or report['wanted_backend'] == 'cpu'
        report['ok'] = bool(on_gpu and report['out_matches_length'] and level >= 1e-4)
        if not on_gpu:
            report['error'] = 'le calcul est retombé sur le processeur : %s' % engine.note
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as e:
        report['error'] = str(e)[:400]
    rmtree(work)
    write_json(base / 'logs' / 'crash-test.json', report)
    log.info('ESSAI %s : %s', 'REUSSI' if report['ok'] else 'RATE', json.dumps(report, ensure_ascii=False))
    return 0 if report['ok'] else 1


# --------------------------------------------------------------------------------------------
# ComfyUI : banc d'essai seulement (catalogue « benchmarks.comfyui »), jamais un type de travail
# --------------------------------------------------------------------------------------------
# gpu/comfyui/python/        Python embarqué officiel (python.org), pip installé depuis sa roue épinglée
# gpu/comfyui/<source>/      ComfyUI à la version épinglée (archive GitHub vérifiée par SHA-256)
# gpu/comfyui/data/          --base-directory : models/, output/, temp/, user/ (base SQLite comprise)
# gpu/comfyui/tmp, cache/    TEMP de pip et du moteur, caches MIOpen / Hugging Face / torch : rien dans le profil Windows
# Supprimer gpu/comfyui (essai comfyui_remove) retire tout.

class ComfyTrace(EngineTrace):
    """Sortie de ComfyUI : barres tqdm (« 3/8 [00:40<01:07, 13.40s/it] »), temps d'exécution, choix de précision et de
    chargement (partiel = la mémoire vidéo ne suffit pas), erreurs HIP."""
    KEEP = re.compile(r'Total VRAM|pytorch version|Device:|Set vram state|attention|weight dtype|manual cast|loaded (completely|partially)|'
                      r'Requested to load|Prompt executed|out of memory|HIP|hipError|MIOpen|rocBLAS|Traceback|Error|\bWARN|Exception|'
                      r'Starting server|To see the GUI|TORCH ', re.I)
    BAR = re.compile(r'\|\s*(\d+)/(\d+)\s*\[[^\]]*?,\s*([\d.]+)(s/it|it/s)\]')
    TAKING = (('executed_s', r'Prompt executed in ([\d.]+) seconds'),)


def comfy_spec(app=None):
    catalog = read_json((app or Path(__file__).resolve().parent) / GPU_CATALOG, {}) or {}
    spec = (catalog.get('benchmarks') or {}).get('comfyui')
    if not spec:
        raise RuntimeError('banc ComfyUI absent du catalogue publié')
    return spec


def comfy_layout(base, spec):
    root = base / 'gpu' / spec.get('dir', 'comfyui')
    return {'root': root, 'python': root / 'python', 'src': root / spec['source']['root'], 'data': root / 'data',
            'tmp': root / 'tmp', 'cache': root / 'cache', 'downloads': root / 'downloads', 'pid': root / 'comfyui.pid',
            'exe': root / 'python' / ('python.exe' if IS_WINDOWS else 'bin/python3')}


def comfy_marker(spec, step):
    """Témoin d'une étape d'installation : change avec ce que le catalogue épingle pour elle (nouvelle version = refaite)."""
    part = {'python': spec['python'], 'pip': [spec['pip'], spec.get('setuptools')], 'source': spec['source'], 'torch': spec['torch'],
            'requirements': [spec['source'], spec['torch']]}[step]
    return hashlib.sha256(json.dumps(part, sort_keys=True).encode()).hexdigest()[:16]


def comfy_done(lay, spec, step):
    try:
        return (lay['root'] / ('.ok-' + step)).read_text().strip() == comfy_marker(spec, step)
    except OSError:
        return False


def comfy_need_bytes(lay, spec):
    """Octets encore à poser sur le disque pour l'essai (poids manquants, environnement Python s'il n'est pas prêt)."""
    need = 0
    for f in spec.get('files') or []:
        dest = lay['data'] / 'models' / f['dir'] / f['name']
        if not Path(str(dest) + '.ok').exists():
            part = Path(str(dest) + '.part')
            need += int(f['size']) - (part.stat().st_size if part.exists() else 0)
    if not all(comfy_done(lay, spec, s) for s in ('python', 'pip', 'source', 'torch', 'requirements')):
        need += int(float(spec.get('env_gb') or 5) * 1e9)
    return max(0, need)


def write_pth(python_dir, src_dir):
    """Python embarqué : son fichier ._pth fixe sys.path (PYTHONPATH ignoré, dossier du script non ajouté). On y met le
    dossier de ComfyUI et « import site » (site-packages, donc pip et ses paquets)."""
    pths = sorted(Path(python_dir).glob('python3*._pth'))
    if not pths:
        raise RuntimeError('Python embarqué sans fichier ._pth')
    pth = pths[0]
    lines = [l.strip() for l in pth.read_text().splitlines() if l.strip() and not l.strip().startswith('#')]
    lines = [l for l in lines if l != 'import site']
    rel = os.path.relpath(str(src_dir), str(python_dir))
    if rel not in lines:
        lines.append(rel)
    pth.write_text('\n'.join(lines + ['import site']) + '\n')
    return pth


def comfy_workflow(spec, values):
    """Graphe API du catalogue, valeurs posées : « {nom} » est remplacé en entier (nombre ou texte), rien d'autre n'est évalué."""
    def fill(v):
        if isinstance(v, str):
            m = re.fullmatch(r'\{(\w+)\}', v)
            if m:
                if m.group(1) not in values:
                    raise RuntimeError('workflow : valeur %s manquante' % m.group(1))
                return values[m.group(1)]
            return v
        if isinstance(v, list):
            return [fill(x) for x in v]
        if isinstance(v, dict):
            return {k: fill(x) for k, x in v.items()}
        return v
    return fill(spec['workflow'])


def png_stats(path, sample=4099):
    """Moyenne et écart des octets de l'image décompressée (échantillon) : une image noire ou unie (NaN en fp16) a un écart nul."""
    import zlib
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    pos, idat = 8, bytearray()
    while pos + 8 <= len(data):
        n, kind = struct.unpack('>I4s', data[pos:pos + 8])
        if kind == b'IDAT':
            idat += data[pos + 8:pos + 8 + n]
        pos += 12 + n
    try:
        raw = zlib.decompress(bytes(idat))
    except zlib.error:
        return None
    vals = raw[::max(1, len(raw) // sample)] if raw else b''
    if not vals:
        return None
    mean = sum(vals) / len(vals)
    return {'mean': round(mean, 1), 'std': round((sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5, 1)}


def run_logged(args, log_path, env, timeout, stop=None, cwd=None, what='commande'):
    """Lance une commande d'installation, sortie ajoutée au journal ; -> sortie (fin). Lève RuntimeError si elle échoue."""
    flags = subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0
    t0 = time.time()
    tail = bytearray()
    with open(log_path, 'ab') as out:
        out.write(('\n=== %s : %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), ' '.join(str(a) for a in args))).encode('utf-8', 'replace'))
        proc = subprocess.Popen([str(a) for a in args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                env=env, cwd=cwd, creationflags=flags)

        def reader():
            for block in iter(lambda: proc.stdout.read(4096), b''):
                out.write(block)
                tail.extend(block)
                if len(tail) > 16384:
                    del tail[:len(tail) - 16384]
        th = threading.Thread(target=reader, daemon=True)
        th.start()
        try:
            while proc.poll() is None:
                if stop is not None and stop.is_set():
                    raise JobLost('%s interrompue' % what)
                if time.time() - t0 > timeout:
                    raise RuntimeError('%s trop longue (plus de %s), arrêtée' % (what, fmt_duration(timeout)))
                time.sleep(1)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            th.join(5)
            proc.stdout.close()
    text = bytes(tail).decode('utf-8', 'replace')
    if proc.returncode != 0:
        last = [l for l in text.strip().splitlines() if l.strip()][-3:]
        raise RuntimeError('%s a échoué (code %s) : %s' % (what, proc.returncode, ' | '.join(last)[-400:]))
    return text


def comfy_env(lay, spec):
    """Environnement du Python de l'essai : tout fichier temporaire ou cache reste sous gpu/comfyui."""
    env = dict(os.environ)
    for k in ('PYTHONPATH', 'PYTHONHOME', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_CONFIG_FILE'):
        env.pop(k, None)
    env.update({k: str(v) for k, v in (spec.get('env') or {}).items()})
    for d in ('tmp', 'cache'):
        lay[d].mkdir(parents=True, exist_ok=True)
    c = lay['cache']
    env.update(TEMP=str(lay['tmp']), TMP=str(lay['tmp']), TMPDIR=str(lay['tmp']), PIP_NO_CACHE_DIR='1', PIP_DISABLE_PIP_VERSION_CHECK='1',
               PIP_CONFIG_FILE=os.devnull, PYTHONNOUSERSITE='1', HF_HOME=str(c / 'hf'), TORCH_HOME=str(c / 'torch'), XDG_CACHE_HOME=str(c),
               MIOPEN_USER_DB_PATH=str(c / 'miopen'), MIOPEN_CUSTOM_CACHE_DIR=str(c / 'miopen'), TRITON_CACHE_DIR=str(c / 'triton'))
    return env


def comfy_install(base, spec, gpu, stop, progress, report):
    """Installe ce qui manque, étape par étape (témoins .ok-<étape>), après contrôle du plafond et de la place libre."""
    lay = comfy_layout(base, spec)
    root = lay['root']
    root.mkdir(parents=True, exist_ok=True)
    need = comfy_need_bytes(lay, spec)
    used = folder_bytes(gpu.root) if gpu.root.exists() else 0
    free = shutil.disk_usage(str(root)).free
    report['disk'] = {'need_gb': round(need / 1e9, 1), 'gpu_folder_gb': round(used / 1e9, 1), 'cap_gb': round(gpu.max_bytes() / 1e9, 1),
                      'free_gb': round(free / 1e9, 1), 'keep_free_gb': round(gpu.keep_free_bytes() / 1e9, 1),
                      'comfyui_max_gb': spec.get('max_gb')}
    if need and used + need > gpu.max_bytes():
        raise RuntimeError('dossier gpu plafonné à %.0f Go : l\'essai ComfyUI en demande %.1f de plus (%.1f déjà pris). Relever "gpu_max_gb" '
                           '(réglage du hub ou config) ou retirer ComfyUI (essai comfyui_remove).' % (gpu.max_bytes() / 1e9, need / 1e9, used / 1e9))
    if need and need + gpu.keep_free_bytes() > free:
        raise RuntimeError('disque presque plein : %.1f Go à poser, %.1f Go libres, %.0f Go à laisser libres ("gpu_keep_free_gb").'
                           % (need / 1e9, free / 1e9, gpu.keep_free_bytes() / 1e9))
    env = comfy_env(lay, spec)
    logs = gpu.root / 'logs'
    logs.mkdir(parents=True, exist_ok=True)
    ilog = logs / 'comfyui-install.log'
    py = lay['exe']
    timings = report.setdefault('install_s', {})

    def step(name, frac, label, fn):
        if comfy_done(lay, spec, name):
            return
        progress(frac, label)
        t0 = time.time()
        fn()
        (root / ('.ok-' + name)).write_text(comfy_marker(spec, name))
        timings[name] = round(time.time() - t0, 1)

    def python():
        if not IS_WINDOWS:
            raise RuntimeError('le banc ComfyUI n\'est prévu que sous Windows (roues ROCm win_amd64 du catalogue)')
        archive = download(spec['python']['url'], lay['downloads'] / Path(spec['python']['url']).name, spec['python']['sha256'], 'Python embarqué')
        rmtree(lay['python'])
        safe_extract(archive, lay['python'])
        write_pth(lay['python'], lay['src'])

    def pip():
        wheel = download(spec['pip']['url'], lay['downloads'] / Path(spec['pip']['url']).name, spec['pip']['sha256'], 'pip')
        wheels = [wheel]
        if spec.get('setuptools'):
            wheels.append(download(spec['setuptools']['url'], lay['downloads'] / Path(spec['setuptools']['url']).name, spec['setuptools']['sha256'], 'setuptools'))
        run_logged([py, str(wheel) + '/pip', 'install', '--no-index', '--no-warn-script-location'] + [str(w) for w in wheels], ilog, env, 600, stop,
                   what='installation de pip')

    def source():
        archive = download(spec['source']['url'], lay['downloads'] / ('comfyui-' + spec['source']['sha256'][:12] + '.zip'), spec['source']['sha256'], 'ComfyUI')
        rmtree(lay['src'])
        safe_extract(archive, lay['root'])
        if not (lay['src'] / 'main.py').exists():
            raise RuntimeError('archive ComfyUI sans %s/main.py' % spec['source']['root'])

    def torch():
        # Sans isolation de construction : le paquet « rocm » (source seulement) se construit avec le setuptools déjà installé
        run_logged([py, '-s', '-m', 'pip', 'install', '--no-warn-script-location', '--no-build-isolation', '--index-url', spec['torch']['index_url']]
                   + list(spec['torch']['packages']),
                   ilog, env, 3600, stop, what='installation de PyTorch ROCm')

    def requirements():
        pins = [re.sub(r'\[[^\]]*\]', '', p) for p in spec['torch']['packages']]   # torch reste celui d'AMD : jamais remplacé par PyPI
        (root / 'constraints.txt').write_text('\n'.join(pins) + '\n')
        run_logged([py, '-s', '-m', 'pip', 'install', '--no-warn-script-location', '-r', lay['src'] / 'requirements.txt', '-c', root / 'constraints.txt'],
                   ilog, env, 3600, stop, what='installation des dépendances de ComfyUI')

    step('python', 0.01, 'installation de Python', python)
    step('pip', 0.02, 'installation de pip', pip)
    step('source', 0.03, 'téléchargement de ComfyUI', source)
    step('torch', 0.05, 'installation de PyTorch ROCm (environ 1,5 Go)', torch)
    step('requirements', 0.15, 'installation des dépendances de ComfyUI', requirements)
    files = spec.get('files') or []
    total = float(sum(int(f['size']) for f in files)) or 1.0
    done = 0.0
    for f in files:
        dest = lay['data'] / 'models' / f['dir'] / f['name']
        mark = Path(str(dest) + '.ok')
        reuse = gpu.root / 'models' / f['reuse'] if f.get('reuse') else None
        if not mark.exists() and reuse is not None and Path(str(reuse) + '.ok').exists() and not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.link(reuse, dest)          # même fichier que le moteur image (même empreinte) : rien de plus sur le disque
            except OSError:
                shutil.copyfile(reuse, dest)
        download_resume(f['url'], dest, f['sha256'], int(f['size']), '%s (ComfyUI)' % f['name'], stop,
                        lambda frac, f=f: progress(0.2 + 0.3 * (done + frac * int(f['size'])) / total, 'téléchargement de %s' % f['name']))
        done += int(f['size'])
    return lay, env


def comfy_kill_orphan(lay):
    """ComfyUI resté en marche après la mort du worker : arrêté, seulement si ce numéro est bien le Python de gpu/comfyui."""
    try:
        pid = int(lay['pid'].read_text())
    except (OSError, ValueError):
        return
    try:
        if pid != os.getpid():
            if IS_WINDOWS:
                shell = shutil.which('powershell') or shutil.which('pwsh')
                path = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id %d -ErrorAction SilentlyContinue).Path' % pid],
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
                                      timeout=60).stdout.decode('utf-8', 'replace').strip() if shell else ''
                if path and Path(path).resolve() == lay['exe'].resolve():
                    subprocess.run(['taskkill', '/PID', str(pid), '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW, timeout=30)
                    log.info('ComfyUI resté en marche après une coupure : arrêté.')
            elif str(lay['root']).encode() in Path('/proc/%d/cmdline' % pid).read_bytes():
                os.kill(pid, 9)
                log.info('ComfyUI resté en marche après une coupure : arrêté.')
    except (OSError, subprocess.SubprocessError):
        pass
    lay['pid'].unlink(missing_ok=True)


def comfy_local(port, method, path, body=None, timeout=30):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), data=data, method=method,
                                 headers={'Content-Type': 'application/json'} if data else {})
    try:
        with opener.open(req, timeout=timeout) as r:
            text = r.read()
            return r.status, (json.loads(text) if text[:1] in (b'{', b'[') else None)
    except urllib.error.HTTPError as e:
        text = e.read()
        try:
            return e.code, json.loads(text)
        except ValueError:
            return e.code, {'error': text[:300].decode('utf-8', 'replace')}


def comfy_bench(lay, env, spec, gpu, values, runs, stop, progress, report):
    """ComfyUI lancé sur 127.0.0.1 sans interface, le workflow de référence joué runs fois (graine différente à chaque fois,
    sinon ComfyUI ressert son cache), mesures par passage, puis arrêt : la carte est rendue."""
    probe = socket.socket()
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
    probe.close()
    lay['data'].mkdir(parents=True, exist_ok=True)
    args = [str(lay['exe']), '-s', str(lay['src'] / 'main.py')] + build_command(spec['args'], {'port': port, 'base': str(lay['data'])})
    flags, kwargs = gpu.spawn_options()
    logs = gpu.root / 'logs'
    out_log = open(logs / 'comfyui.log', 'wb')
    t0 = time.time()
    proc = subprocess.Popen(args, cwd=str(lay['src']), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            env=env, creationflags=flags, **kwargs)
    lay['pid'].write_text(str(proc.pid))
    box = {'trace': ComfyTrace(int(values['steps'])), 'all': ComfyTrace()}

    def reader():
        for block in iter(lambda: proc.stdout.read1(4096) if hasattr(proc.stdout, 'read1') else proc.stdout.read(4096), b''):
            out_log.write(block)
            out_log.flush()
            box['trace'].feed(block)
            box['all'].feed(block)
        out_log.close()
    th = threading.Thread(target=reader, daemon=True)
    th.start()
    gpu.last_trace = box['all']
    try:
        start_timeout = float(spec.get('start_timeout_s') or 900)
        while True:
            if stop is not None and stop.is_set():
                raise JobLost('essai interrompu')
            if proc.poll() is not None:
                raise RuntimeError('ComfyUI s\'est arrêté au démarrage (code %s) : %s' % (proc.returncode, ' | '.join(box['all'].lines[-4:])[-400:]))
            if time.time() - t0 > start_timeout:
                raise RuntimeError('ComfyUI pas prêt après %s' % fmt_duration(start_timeout))
            try:
                status, stats = comfy_local(port, 'GET', '/system_stats', timeout=5)
                if status == 200:
                    break
            except OSError:
                pass
            progress(0.5, 'démarrage de ComfyUI')
            time.sleep(2)
        report['start_s'] = round(time.time() - t0, 1)
        dev = ((stats or {}).get('devices') or [{}])[0]
        report['comfyui_system'] = {k: (stats or {}).get('system', {}).get(k) for k in ('comfyui_version', 'pytorch_version', 'python_version', 'os')}
        report['device'] = {k: dev.get(k) for k in ('name', 'type', 'vram_total', 'vram_free')}
        timeout = float(spec.get('timeout_s') or 3600)
        out_runs = []
        for i in range(runs):
            trace = ComfyTrace(int(values['steps']))
            box['trace'] = trace
            wf = comfy_workflow(spec, dict(values, seed=int(values['seed']) + i))
            t1 = time.time()
            status, answer = comfy_local(port, 'POST', '/prompt', {'prompt': wf, 'client_id': 'reuse-bench'}, timeout=60)
            pid = (answer or {}).get('prompt_id')
            if status != 200 or not pid:
                raise RuntimeError('ComfyUI refuse le workflow (HTTP %s) : %s' % (status, json.dumps(answer, ensure_ascii=False)[:400]))
            entry = None
            while entry is None:
                if stop is not None and stop.is_set():
                    raise JobLost('essai interrompu')
                if proc.poll() is not None:
                    raise RuntimeError('ComfyUI s\'est arrêté pendant le calcul (code %s) : %s' % (proc.returncode, ' | '.join(box['all'].lines[-4:])[-400:]))
                if time.time() - t1 > timeout:
                    raise RuntimeError('passage %d trop long (plus de %s)' % (i + 1, fmt_duration(timeout)))
                progress(0.55 + 0.4 * (i + max(0.0, min(1.0, (trace.progress - 0.35) / 0.55))) / runs, 'passage %d/%d : %s' % (i + 1, runs, trace.stage()))
                time.sleep(1)
                status, hist = comfy_local(port, 'GET', '/history/%s' % pid, timeout=30)
                if status == 200 and isinstance(hist, dict) and pid in hist:
                    entry = hist[pid]
            st = entry.get('status') or {}
            run = {'run': i + 1, 'seed': int(values['seed']) + i, 'wall_s': round(time.time() - t1, 1), **trace.summary()}
            if st.get('status_str') != 'success':
                msgs = [m for m in st.get('messages') or [] if m and m[0] == 'execution_error']
                err = (msgs[0][1] if msgs else {}) or {}
                raise RuntimeError('passage %d raté : %s %s' % (i + 1, err.get('exception_type', ''), str(err.get('exception_message', st))[:300]))
            images = [im for node in (entry.get('outputs') or {}).values() for im in node.get('images') or []]
            if not images:
                raise RuntimeError('passage %d : aucune image produite' % (i + 1))
            im = images[0]
            path = lay['data'] / 'output' / (im.get('subfolder') or '') / im['filename']
            size = png_size(path) if path.exists() else None
            if tuple(size or ()) != (int(values['width']), int(values['height'])):
                raise RuntimeError('passage %d : image %s au lieu de %dx%d' % (i + 1, size, values['width'], values['height']))
            run['image'] = png_stats(path)
            kept = gpu.root.parent / 'logs' / ('gpu-test-comfyui-%d.png' % (i + 1))
            shutil.copyfile(path, kept)
            report['output'] = str(kept)
            out_runs.append(run)
        report['runs'] = out_runs
        _, stats = comfy_local(port, 'GET', '/system_stats', timeout=10)
        dev = ((stats or {}).get('devices') or [{}])[0]
        report['device']['vram_free_after'] = dev.get('vram_free')
    finally:
        if proc.poll() is None:
            proc.kill()
            try:
                proc.wait(30)
            except subprocess.TimeoutExpired:
                pass
        th.join(5)
        proc.stdout.close()
        lay['pid'].unlink(missing_ok=True)
    return out_runs


def comfy_test_report(base, config, kind, params, stop, progress, report):
    """Essai comfyui (installation au besoin, mesure) ou comfyui_remove (tout retirer). -> rapport."""
    gpu = Gpu(base, config, Path(__file__).resolve().parent)
    try:
        spec = comfy_spec()
        lay = comfy_layout(base, spec)
        comfy_kill_orphan(lay)
        if kind == 'comfyui_remove':
            freed = folder_bytes(lay['root']) if lay['root'].exists() else 0
            rmtree(lay['root'])
            if lay['root'].exists():
                raise RuntimeError('%s n\'a pas pu être supprimé entièrement (fichier ouvert ?)' % lay['root'])
            report.update(ok=True, freed_gb=round(freed / 1e9, 2), removed=str(lay['root']))
            return report
        values = dict(spec.get('defaults') or {})
        values.update({k: v for k, v in params.items() if k in ('width', 'height', 'steps', 'seed')})
        runs = int(params.get('runs') or values.pop('runs', 2) or 2)
        values.pop('runs', None)
        report['params'] = dict(values, runs=runs)
        report['engine'] = spec.get('label')
        t0 = time.time()
        lay, env = comfy_install(base, spec, gpu, stop, progress, report)
        # Contrôle à chaque essai (10 à 20 s) : version, carte et architecture vues par PyTorch
        out = run_logged([lay['exe'], '-s', '-c', spec['torch']['check']], gpu.root / 'logs' / 'comfyui-install.log', env, 300, stop,
                         what='contrôle de PyTorch')
        line = ([l for l in out.splitlines() if l.startswith('TORCH ')] or [''])[-1].split(' ', 1)[-1]
        report['torch'] = line[:300]
        devices = []
        for l in out.splitlines():
            m = re.match(r'DEV (\d+) (\S+) (\d+) (.*)', l.strip())
            if m:
                devices.append({'index': int(m.group(1)), 'arch': m.group(2), 'memory_gb': round(int(m.group(3)) / 1e9, 1), 'name': m.group(4)[:80]})
        report['torch_devices'] = devices
        if ' True ' not in ' %s ' % line or not devices:
            raise RuntimeError('PyTorch ROCm ne voit pas la carte : %s' % (line or out.strip()[-300:]))
        # Un processeur AMD à graphique intégré est aussi vu par ROCm : ComfyUI calcule sur la carte qui a le plus de mémoire
        card = max(devices, key=lambda d: d['memory_gb'])
        if len(devices) > 1:
            env['HIP_VISIBLE_DEVICES'] = str(card['index'])
        report['torch_device'] = card
        report['install_total_s'] = round(time.time() - t0, 1)
        runs_out = comfy_bench(lay, env, spec, gpu, values, runs, stop, progress, report)
        warm = runs_out[-1]
        ref = (spec.get('reference') or {}).get('s_per_step')
        report.update(ok=True, compute_s=warm.get('wall_s'), s_per_step=warm.get('s_per_step'), executed_s=warm.get('executed_s'),
                      first_run_s=runs_out[0].get('wall_s'))
        if ref and warm.get('s_per_step'):
            report['reference'] = spec.get('reference')
            report['speedup_vs_sdcpp'] = round(ref / warm['s_per_step'], 2)
        if any((r.get('image') or {}).get('std', 1) < 2 for r in runs_out):
            report.update(ok=False, error='image unie (noire ?) : calcul en fp16 tombé en NaN probable, voir log')
        report['size_gb'] = round(folder_bytes(lay['root']) / 1e9, 1)
    except JobLost as e:
        report['error'] = 'annulé : %s' % e
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        report['error'] = str(e)[:400]
    raw = gpu.root / 'logs' / ('comfyui.log' if (gpu.root / 'logs' / 'comfyui.log').exists() and report.get('install_total_s') is not None
                               else 'comfyui-install.log')
    report['log_file'] = str(raw)
    report['log'] = log_tail(raw)
    if gpu.last_trace is not None:
        report['engine_lines'] = gpu.last_trace.lines[-40:]
    return report


# Essais GPU : en local (--gpu-test, worker arrêté) ou demandés par le hub (ordre gpu_test, worker en marche, entre deux
# travaux). Même code, même rapport (logs/gpu-test.json), remonté au hub dans le second cas.
GPU_TEST_KINDS = ('image', '3d', 'comfyui', 'comfyui_remove')
GPU_TEST_OBJECT = 'gpu-test-object.png'   # entrée de l'essai 3D demandé par le hub (512x512, fond blanc)
# Réglages que le hub peut poser sur cette machine (POST /api/reuse/workers/:nom/settings), avec leurs types. Aucun autre.
REMOTE_SETTINGS = {'enable_3d': (bool,), 'gpu_max_gb': (int, float), 'gpu_keep_loaded_s': (int, float)}
LOG_TAIL_LINES = 60


def log_tail(path, lines=LOG_TAIL_LINES, width=300):
    """Dernières lignes lisibles d'un journal de moteur (barres de progression et codes couleur retirés)."""
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 256 * 1024))
            text = f.read().decode('utf-8', 'replace')
    except OSError:
        return []
    out = []
    for raw in re.split(r'[\r\n]+', text):
        line = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', raw).strip()
        if line:
            out.append(line[:width])
    return out[-lines:]


def gpu_test_report(base, config, kind, params=None, input_path=None, stop=None, progress=None):
    """Un essai, sans verrou (l'appelant garantit que rien d'autre ne calcule). -> rapport (dict). Ne lève pas."""
    params = dict(params or {})
    progress = progress or (lambda frac, stage: None)
    config = {k: v for k, v in (config or {}).items() if k not in ('token', 'hub_url')}
    report = {'ok': False, 'kind': kind, 'at': time.strftime('%Y-%m-%d %H:%M:%S'),
              'system': '%s %s %s' % (platform.system(), platform.release(), platform.machine())}
    if kind in ('comfyui', 'comfyui_remove'):
        return comfy_test_report(base, config, kind, params, stop, progress, report)
    if kind == '3d':
        config['enable_3d'] = True   # l'essai est justement là pour décider d'ouvrir la 3D
    gpu = Gpu(base, config, Path(__file__).resolve().parent)
    work = base / 'work' / 'gpu-test'
    try:
        spec = (gpu.catalog.get('types') or {}).get(kind)
        if not spec:
            raise RuntimeError('type %s absent du catalogue' % kind)
        model = spec['default_model']
        if kind == 'image':
            values = {'width': 512, 'height': 512, 'steps': 8, 'cfg_scale': 1.0, 'seed': 42, 'sampler': 'euler', 'negative_prompt': ''}
        else:
            values = {'res': '512', 'steps': 12, 'seed': 42, 'texture': True}
        values.update({k: v for k, v in params.items() if k in values})
        job = {'kind': kind, 'model': model, 'params': values,
               'prompt': 'a red ceramic teapot on a white table, studio photo' if spec.get('prompt') != 'none' else ''}
        report['params'] = values
        src = None
        if input_path:
            report['input'] = Path(input_path).name
        if spec.get('input') == 'required':
            src = Path(input_path) if input_path else base / 'logs' / 'gpu-test.png'
            if not src.exists() and not input_path:
                # Pas d'image d'entrée : l'essai image la fabrique d'abord (même moteur que les travaux image)
                progress(0.0, 'image d\'entrée (essai image 512)')
                first = gpu_test_report(base, config, 'image', {}, None, stop, lambda f, st: progress(0.1 * f, 'image d\'entrée : ' + st))
                report['input_image'] = {k: first.get(k) for k in ('ok', 'compute_s', 'error')}
                if not first.get('ok'):
                    raise RuntimeError('image d\'entrée ratée : %s' % first.get('error'))
            if not src.exists():
                raise RuntimeError('image d\'entrée introuvable : %s (lancer d\'abord l\'essai image, ou --gpu-input)' % src)
        rmtree(work)
        work.mkdir(parents=True)
        out, compute_s, meta = gpu.run(job, src, work, stop, progress)
        dest = base / 'logs' / ('gpu-test.' + out.suffix.lstrip('.'))
        shutil.copyfile(out, dest)
        report.update(ok=True, model=model, compute_s=round(compute_s, 1), output=str(dest), size=os.path.getsize(dest),
                      sha256=sha256_file(dest), **meta)
        if out.suffix == '.glb':
            report['glb'] = glb_stats(dest)
            if not (report['glb'] or {}).get('triangles'):
                report.update(ok=False, error='GLB sans triangle : maillage vide (flux tombé en NaN ?), voir log')
    except JobLost as e:
        report['error'] = 'annulé : %s' % e
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        report['error'] = str(e)[:400]
    raw = gpu.root / 'logs' / ('server-image.log' if kind == 'image' and gpu.server else 'last-%s.log' % kind)
    if not raw.exists():
        raw = gpu.root / 'logs' / ('last-%s.log' % kind)
    tail = log_tail(raw)
    report['log_file'] = str(raw)
    report['log'] = tail
    # trellis.cpp v0.8.1 sur RDNA2 sans contournement : flux NaN mis à zéro en silence (#50). Toute ligne qui en parle est remontée.
    report['nan_lines'] = [l for l in tail if re.search(r'nan', l, re.I)][:20]
    if gpu.last_trace is not None:
        report['engine_lines'] = gpu.last_trace.lines[-40:]
    gpu.stop_server()   # l'essai ne laisse rien tourner derrière lui
    rmtree(work)
    return report


def gpu_test(base, kind, input_path=None):
    """Essai d'une génération sans hub : installe (si besoin) et calcule une petite image, ou un modèle 3D à partir
    d'une image (--gpu-input, sinon l'image de l'essai précédent, sinon une image faite d'abord). Le worker doit être
    arrêté (fichier STOP) : jamais deux calculs sur la carte. Écrit logs/gpu-test.json et le résultat dans logs/gpu-test.<ext>."""
    lock = open(base / '.worker.lock', 'a+')
    try:
        if IS_WINDOWS:
            import msvcrt
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log.error('Le worker tourne : créer le fichier STOP dans %s, attendre son arrêt, puis relancer l\'essai.', base)
        return EXIT_NOT_READY
    config = read_json(base / 'reuse-worker.config.json', {}) or {}
    report = gpu_test_report(base, config, kind, None, input_path, None,
                             lambda frac, stage: log.info('Essai %s : %s (%d %%)', kind, stage, round(100 * frac)))
    write_json(base / 'logs' / 'gpu-test.json', report)
    log.info('ESSAI GPU %s : %s', 'REUSSI' if report['ok'] else 'RATE', json.dumps(report, ensure_ascii=False))
    return 0 if report['ok'] else 1


def main():
    parser = argparse.ArgumentParser(description='Worker de nettoyage RE-USE')
    parser.add_argument('--base', required=True, help='dossier d\'installation (config, runtime, logs)')
    parser.add_argument('--launcher', help='script qui a lancé ce worker (mis à jour avec lui)')
    parser.add_argument('--crash-test', action='store_true', help='essai complet sans hub : installe, teste la carte, nettoie 10 s, écrit logs/crash-test.json')
    parser.add_argument('--gpu-test', choices=GPU_TEST_KINDS, help='essai de génération sans hub (worker arrêté) : logs/gpu-test.json')
    parser.add_argument('--gpu-input', help='image d\'entrée de l\'essai 3D (défaut : logs/gpu-test.png)')
    args = parser.parse_args()
    base = Path(args.base).resolve()
    (base / 'logs').mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter('%(asctime)s | %(levelname)-7s | %(message)s', '%Y-%m-%d %H:%M:%S')
    handlers = [logging.handlers.RotatingFileHandler(base / 'logs' / 'worker.log', maxBytes=5 << 20, backupCount=3, encoding='utf-8')]
    if sys.stdout is not None:
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
        handlers.append(logging.StreamHandler(sys.stdout))
    for h in handlers:
        h.setFormatter(fmt)
        log.addHandler(h)
    log.setLevel(logging.INFO)
    try:
        if args.gpu_test:
            code = gpu_test(base, args.gpu_test, args.gpu_input)
        else:
            code = crash_test(base) if args.crash_test else Worker(base, args.launcher).run()
    except SystemExit as e:
        if isinstance(e.code, str):
            log.error('%s', e.code)
            logging.shutdown()
            sys.exit(2)
        raise
    except Exception as e:  # tout le reste : consigné, puis le lanceur relance
        log.exception('Arrêt inattendu : %s', e)
        logging.shutdown()
        sys.exit(1)
    logging.shutdown()
    sys.exit(code)


if __name__ == '__main__':
    main()
