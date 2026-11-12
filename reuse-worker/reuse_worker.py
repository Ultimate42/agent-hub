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
GPU_DEFAULT_MAX_GB = 30.0        # plafond du dossier gpu (réglable : "gpu_max_gb" dans la config)
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


class Gpu:
    """Image et 3D : moteurs et modèles du catalogue, installés au premier job qui en a besoin, tout sous <dossier>/gpu.

    gpu/engines/<moteur>-<empreinte>/   binaires décompressés        gpu/models/<modèle>/   poids (GGUF, safetensors)
    gpu/downloads/                       archives en cours            gpu/logs/              dernière sortie de chaque moteur
    Rien ailleurs : ni registre, ni service, ni Python en plus. Le plafond du dossier (gpu_max_gb) est vérifié avant
    tout téléchargement ; les versions que le catalogue ne cite plus sont supprimées d'abord."""

    def __init__(self, base, config, app):
        self.root = base / 'gpu'
        self.config = config
        self.system = 'windows' if IS_WINDOWS else 'linux'
        self.catalog = read_json(app / GPU_CATALOG, {}) or {}
        self.pidfile = self.root / 'engine.pid'
        self.status = {}   # type -> état lisible (« prêt », « pas installé », « échec : … »)

    def types(self):
        """Types que cette machine propose au hub (annoncés à chaque échange, info.gpu)."""
        if self.config.get('gpu') is False or platform.machine().lower() not in ('amd64', 'x86_64'):
            return []
        out = []
        for t, spec in sorted((self.catalog.get('types') or {}).items()):
            engine = (self.catalog.get('engines') or {}).get(spec.get('engine')) or {}
            if not engine.get(self.system):
                continue
            if spec.get('experimental') and not self.config.get(spec.get('flag') or ('enable_' + t)):
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
        flags, kwargs = 0, {}
        if IS_WINDOWS:
            flags = subprocess.CREATE_NO_WINDOW | (subprocess.BELOW_NORMAL_PRIORITY_CLASS if self.config.get('low_priority', True) else 0)
        elif self.config.get('low_priority', True):
            kwargs['preexec_fn'] = lambda: os.nice(10)
        logs = self.root / 'logs'
        logs.mkdir(parents=True, exist_ok=True)
        log_path = logs / ('last-%s.log' % kind)
        timeout = float(model.get('timeout_s') or 1800)
        progress(0.3, 'calcul')
        t0 = time.time()
        with open(log_path, 'wb') as out_log:
            proc = subprocess.Popen(args, cwd=str(exe.parent), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                    env=env, creationflags=flags, **kwargs)
            self.pidfile.write_text(str(proc.pid))
            tail = bytearray()

            def reader():
                for block in iter(lambda: proc.stdout.read1(4096) if hasattr(proc.stdout, 'read1') else proc.stdout.read(4096), b''):
                    out_log.write(block)
                    tail.extend(block)
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
                    steps = re.findall(rb'(\d+)/(\d+)\s*-', bytes(tail[-2048:]))
                    if steps:
                        a, b = (int(x) for x in steps[-1])
                        if b:
                            progress(0.3 + 0.65 * min(a, b) / b, 'calcul')
                    time.sleep(1)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                th.join(5)
                self.pidfile.unlink(missing_ok=True)
        compute_s = time.time() - t0
        text = bytes(tail).decode('utf-8', 'replace')
        if proc.returncode != 0:
            raise RuntimeError('%s a échoué (code %s) : %s' % (exe.name, proc.returncode, ' | '.join(text.strip().splitlines()[-3:])[-300:]))
        if not out.exists():
            raise RuntimeError('%s n\'a rien écrit' % exe.name)
        meta = {}
        dev = re.findall(r'ggml_vulkan: \d+ = ([^\r\n|(]+)', text)
        if dev:
            meta['device'] = dev[0].strip()[:120]
        if ext == 'png':
            size = png_size(out)
            if not size:
                raise RuntimeError('la sortie n\'est pas un PNG')
            want = (values.get('width'), values.get('height'))
            if None not in want and tuple(size) != tuple(want):
                raise RuntimeError('image de %dx%d au lieu de %dx%d' % (size + want))
        elif ext == 'glb' and not is_glb(out):
            raise RuntimeError('la sortie n\'est pas un fichier GLB valide')
        return out, compute_s, meta


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
        self.hub = Hub(self.config['hub_url'], self.config['token'])
        self.version = (self.app / 'version.txt').read_text().strip() if (self.app / 'version.txt').exists() else 'dev'
        self.engine = Engine(base, self.config)
        self.gpu = Gpu(base, self.config, self.app)
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

        def progress(frac, stage):
            now.update(progress=round(max(0.0, min(1.0, frac)), 3), stage=stage)

        def beat():
            # Plus fréquent qu'un nettoyage : l'avancement se voit côté client et une annulation arrête la carte vite
            period = max(5, min(15, job.get('lease_s', 600) // 5))
            while True:
                try:
                    status, _ = self.hub.request('POST', '%s%d/heartbeat' % (route, jid), body=dict(now, info=self.info()), timeout=30)
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
            query = urllib.parse.urlencode({'compute_s': done['compute_s'], 'backend': 'vulkan', 'meta': json.dumps(done.get('meta') or {})})

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
            self.give_back(jid, e, route)
        except OSError as e:
            log.error('Job %s en attente : %s. Le travail fait est gardé dans %s.', label, e, jobdir)
            self.state['last_error'] = 'job %s : %s' % (label, e)
        except (RuntimeError, ValueError, KeyError) as e:
            log.error('Job %s raté : %s', label, e)
            self.state['last_error'] = 'job %s : %s' % (label, e)
            self.gpu.status[kind] = 'échec : %s' % str(e)[:120]
            rmtree(jobdir)
            self.give_back(jid, e, route)
        finally:
            finished.set()
            self.set_state('en attente')

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
                self.apply_orders(body.get('orders') or {})
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
        if self.gpu.types():
            log.info('Générations GPU proposées : %s', self.gpu.describe())
        (self.app / '.ok').write_text(time.strftime('%Y-%m-%d %H:%M:%S'))   # cette version démarre : le lanceur ne reviendra pas en arrière
        self.set_state('en attente')
        job = None
        orders = {}
        errors = 0
        while True:
            if (self.base / 'STOP').exists():
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

    def apply_orders(self, orders):
        self.note_pause(orders)
        order = int(orders.get('update') or 0)
        acked = (read_json(self.base / 'update-ack.json', {}) or {}).get('order')
        self.update(orders.get('worker_version'), order if order and order != acked else 0)


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


def gpu_test(base, kind, input_path=None):
    """Essai d'une génération sans hub : installe (si besoin) et calcule une petite image, ou un modèle 3D à partir
    d'une image (--gpu-input, sinon l'image de l'essai précédent). Le worker doit être arrêté (fichier STOP) :
    jamais deux calculs sur la carte. Écrit logs/gpu-test.json et le résultat dans logs/gpu-test.<ext>."""
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
    config = {k: v for k, v in config.items() if k not in ('token', 'hub_url')}
    if kind == '3d':
        config.setdefault('enable_3d', True)   # l'essai est justement là pour décider d'ouvrir la 3D
    gpu = Gpu(base, config, Path(__file__).resolve().parent)
    report = {'ok': False, 'kind': kind, 'at': time.strftime('%Y-%m-%d %H:%M:%S'),
              'system': '%s %s %s' % (platform.system(), platform.release(), platform.machine())}
    work = base / 'work' / 'gpu-test'
    try:
        spec = (gpu.catalog.get('types') or {}).get(kind)
        if not spec:
            raise RuntimeError('type %s absent du catalogue' % kind)
        model = spec['default_model']
        params = {'width': 512, 'height': 512, 'steps': 8, 'cfg_scale': 1.0, 'seed': 42, 'sampler': 'euler', 'negative_prompt': ''} \
            if kind == 'image' else {'res': '512', 'steps': 12, 'seed': 42, 'texture': True}
        job = {'kind': kind, 'model': model, 'params': params,
               'prompt': 'a red ceramic teapot on a white table, studio photo' if spec.get('prompt') != 'none' else ''}
        src = None
        if spec.get('input') == 'required':
            src = Path(input_path) if input_path else base / 'logs' / 'gpu-test.png'
            if not src.exists():
                raise RuntimeError('image d\'entrée introuvable : %s (lancer d\'abord l\'essai image, ou --gpu-input)' % src)
        rmtree(work)
        work.mkdir(parents=True)
        out, compute_s, meta = gpu.run(job, src, work, None, lambda f, st: None)
        dest = base / 'logs' / ('gpu-test.' + out.suffix.lstrip('.'))
        shutil.copyfile(out, dest)
        report.update(ok=True, model=model, compute_s=round(compute_s, 1), output=str(dest), size=os.path.getsize(dest), **meta)
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        report['error'] = str(e)[:400]
        report['log'] = str(gpu.root / 'logs' / ('last-%s.log' % kind))
    rmtree(work)
    write_json(base / 'logs' / 'gpu-test.json', report)
    log.info('ESSAI GPU %s : %s', 'REUSSI' if report['ok'] else 'RATE', json.dumps(report, ensure_ascii=False))
    return 0 if report['ok'] else 1


def main():
    parser = argparse.ArgumentParser(description='Worker de nettoyage RE-USE')
    parser.add_argument('--base', required=True, help='dossier d\'installation (config, runtime, logs)')
    parser.add_argument('--launcher', help='script qui a lancé ce worker (mis à jour avec lui)')
    parser.add_argument('--crash-test', action='store_true', help='essai complet sans hub : installe, teste la carte, nettoie 10 s, écrit logs/crash-test.json')
    parser.add_argument('--gpu-test', choices=('image', '3d'), help='essai de génération sans hub (worker arrêté) : logs/gpu-test.json')
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
