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
import ipaddress
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


class Final(RuntimeError):
    """Échec qui se reproduirait à l'identique (trop lent pour le plafond, image ratée deux fois) : le hub ne relance pas."""


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


def download_resume(url, dest, expected_sha256, size, what, stop=None, progress=None, tries=8):
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
    for attempt in range(1, tries + 1):
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
            if attempt == tries:
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
            if a > (self.step or 0):   # durée de chaque étape (la barre se redessine aussi sans avancer)
                self.step_ends = getattr(self, 'step_ends', []) + [now]
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

    def step_durations(self):
        ends = getattr(self, 'step_ends', [])
        return [b - a for a, b in zip(ends, ends[1:])]   # la première étape n'a pas de début mesuré : écartée

    def steady_rate(self):
        """Secondes par étape, médiane des étapes après la première (au moins trois), ou None. Une étape lente isolée (frais
        d'une fois) ne fait plus arrêter le calcul ; un calcul lent d'un bout à l'autre, si."""
        d = sorted(self.step_durations())
        return d[len(d) // 2] if len(d) >= 3 else None

    def summary(self):
        meta = dict(self.meta)
        if self.step_rate:
            meta['s_per_step'] = round(self.step_rate, 2)
        if self.step_durations():
            meta['step_times'] = ','.join('%.1f' % x for x in self.step_durations()[:24])[:190]
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
        self.app = app
        self.catalog = read_json(app / GPU_CATALOG, {}) or {}
        self.hip_device = None   # carte ROCm choisie pour ComfyUI (None : pas encore regardé, '' : une seule carte)
        self.comfy = None        # ComfyUI résident pour les modèles qui passent par lui (FLUX 3 Klein) : poignée de comfy_start
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

    def models(self):
        """Modèles joués par ComfyUI que cette machine propose (annoncés au hub, info.gpu_models) : leur type est proposé, la
        carte est assez grande et l'environnement ComfyUI est déjà installé et prouvé par le banc d'essai (essai comfyui)."""
        spec = (self.catalog.get('benchmarks') or {}).get('comfyui')
        if not spec or not IS_WINDOWS and not self.config.get('comfyui_any_os') or self.config.get('comfyui') is False:
            return []
        lay = comfy_layout(self.root.parent, spec)
        if not all(comfy_done(lay, spec, s) for s in ('python', 'pip', 'source', 'torch', 'requirements')):
            return []
        vram = self.vram()
        out = []
        for t in self.types():
            for mid, m in sorted(((self.catalog['types'][t].get('models') or {}).items())):
                if m.get('engine') != 'comfyui':
                    continue
                need = float(m.get('min_vram_gb') or 0)
                if need and vram is not None and vram < need * 1e9:
                    continue
                out.append(mid)
        return out

    def comfy_free(self, h, need_mib, stop):
        """Carte libérée par ComfyUI lui-même (POST /free : modèles déchargés, cache vidé), sans le relancer ; la place revient
        quand son fil de travail a déchargé. -> Mio libres après (None : inconnu)."""
        try:
            code, _ = comfy_local(h['port'], 'POST', '/free', {'unload_models': True, 'free_memory': True}, timeout=10)
        except (OSError, ValueError) as e:
            log.warning('POST /free de ComfyUI a échoué : %s', e)
            return None
        if code != 200:
            log.warning('POST /free de ComfyUI refusé (HTTP %s).', code)
        free, deadline = None, time.time() + COMFY_FREE_WAIT_S
        while True:
            try:
                free = comfy_vram(h['port'])[0]
            except (OSError, ValueError):
                free = None
            if free is not None and free >= need_mib or time.time() > deadline or stop is not None and stop.is_set():
                return free
            time.sleep(0.5)

    def stop_comfy(self, why=''):
        h, self.comfy = self.comfy, None
        if h:
            comfy_stop(h['h'])
            if why:
                log.info('ComfyUI résident arrêté (%s) : carte libérée.', why)

    def run_comfy(self, job, workdir, stop, progress):
        """Un travail joué par ComfyUI (modèle du catalogue à "engine": "comfyui") : poids posés au besoin, ComfyUI gardé
        chargé entre deux travaux, workflow du catalogue, images de référence par le mécanisme natif du modèle."""
        kind, model_id = job['kind'], job['model']
        model = self.catalog['types'][kind]['models'][model_id]
        spec = (self.catalog.get('benchmarks') or {}).get('comfyui')
        if not spec or model_id not in self.models():
            raise RuntimeError('modèle %s non proposé par cette machine (ComfyUI pas installé ici ?)' % model_id)
        self.stop_server('ComfyUI demandé')   # une seule pile de poids sur la carte
        t0 = time.time()
        meta = {}
        lay, env = comfy_install(self.root.parent, spec, self, stop, lambda f, st: progress(0.3 * f, st), meta, files=model['files'])
        meta.pop('install_s', None)
        values = dict(job.get('params') or {})
        for name, ps in (model.get('params') or {}).items():
            if name not in values and ps.get('default') not in (None, 'random'):
                values[name] = ps['default']
        values.setdefault('seed', 0)
        values.setdefault('ref_megapixels', float((model.get('references') or {}).get('megapixels') or 1.0))
        for key, how in (model.get('workflow_values') or {}).items():   # réglage lisible -> valeur du workflow (text_encoder cpu -> device cpu)
            values[key] = how['map'].get(str(values.get(how['from'])).lower(), how.get('default'))
        values.update(prompt=job.get('prompt') or '')
        tries = [values]
        no_fallback = 'no_fallback' in str(values.get('comfyui_options') or '').lower()
        if values.get('unet_dtype') == 'fp16' and model.get('fp16_fallback') and not no_fallback:
            tries.append(dict(values, unet_dtype=model['fp16_fallback']))   # image unie en fp16 (NaN) : refait dans la précision sûre
        for n, vals in enumerate(tries):
            out, run = self.comfy_generate(job, model, spec, lay, env, vals, workdir, stop, progress, meta)
            stats = png_stats(out) or {}
            meta['image_std'] = stats.get('std')
            # Chaque passage laisse sa trace : un repli ne cache plus ce qu'a donné le premier (job 55)
            name = ('try_first', 'try_second')[min(n, 1)]
            meta[name] = '%s %s : %s s/étape, %s s, écart %s' % (vals.get('unet_dtype'), vals.get('attention'), run.get('s_per_step'),
                                                               run.get('wall_s'), stats.get('std'))
            if self.comfy:
                self.comfy['h']['box']['all'].meta[name] = meta[name]
            if stats.get('std', 99) >= 2:
                break
            if n + 1 < len(tries):
                log.warning('Image unie en %s (NaN probable) : nouvel essai en %s.', vals.get('unet_dtype'), tries[n + 1]['unet_dtype'])
                meta['half_fallback'] = True
            else:
                raise Final('image unie (noire ?) en %s : calcul tombé en NaN probable' % vals.get('unet_dtype', 'default'))
        meta.update(run)
        meta['backend'] = 'rocm'
        meta.pop('torch_devices', None)
        meta.pop('torch', None)
        if isinstance(meta.get('torch_device'), dict):
            meta['device'] = meta.pop('torch_device').get('name')
        self.check_output('png', out, values)
        return out, time.time() - t0, {k: v for k, v in meta.items() if isinstance(v, (str, int, float, bool))}

    def comfy_generate(self, job, model, spec, lay, env, values, workdir, stop, progress, meta):
        """Un passage : ComfyUI (re)lancé si ses réglages changent, workflow joué. -> (out.png, mesures)."""
        extra = []
        for name, flags in (model.get('comfyui_flags') or {}).items():   # réglages admin -> options de ComfyUI
            extra += flags.get(str(values.get(name)).lower(), [])
        add, drop, opt_env, unknown = comfy_options(values.get('comfyui_options'))
        extra += add + ['!' + d for d in drop]
        if unknown:
            meta['comfyui_options_ignored'] = ','.join(unknown)[:120]
        env = dict(env)
        for k in [k for k in env if k.startswith(('COMFY_KITCHEN_', 'PYTORCH_HIP_ALLOC', 'PYTORCH_ALLOC'))]:
            env.pop(k)
        env.update(opt_env)
        if self.hip_device:
            env['HIP_VISIBLE_DEVICES'] = self.hip_device   # carte choisie au premier démarrage
        key = json.dumps([extra, sorted(opt_env.items())])
        if self.comfy and (self.comfy['h']['proc'].poll() is not None or self.comfy.get('key') != key):
            self.stop_comfy('il s\'était arrêté' if self.comfy['h']['proc'].poll() is not None else 'réglages changés')
        def start():
            progress(0.3, 'démarrage de ComfyUI')
            if self.hip_device is None:
                comfy_pick_device(lay, env, spec, self, stop, meta)
                self.hip_device = env.get('HIP_VISIBLE_DEVICES', '')
            self.comfy = {'h': comfy_start(lay, env, spec, self, stop, progress, extra), 'key': key}
            meta['server_start_s'] = self.comfy['h']['start_s']
        reused = self.comfy is not None
        if reused:
            meta['server_reused'] = True
        else:
            start()
        meta['comfyui_flags'] = (' '.join(extra) + ''.join(' %s=%s' % kv for kv in sorted(opt_env.items()))).strip() or 'aucune'
        meta.update({k: values[k] for k in ('unet_dtype', 'attention', 'dynamic_vram', 'ref_megapixels', 'vram_mode', 'text_encoder') if k in values})
        # Place sur la carte : les poids d'un travail précédent restés chargés font déborder le suivant (job 67) ; carte
        # libérée par ComfyUI (POST /free) quand la place manque, ComfyUI relancé si cela ne suffit pas
        for k in ('vram_free_before_mib', 'freed', 'vram_free_after_free_mib', 'free_restart'):
            meta.pop(k, None)
            self.comfy['h']['box']['all'].meta.pop(k, None)   # journal de toute la vie de ComfyUI : pas de reste du travail précédent
        need, need_all = comfy_vram_need(model, values)
        resident = json.dumps([job.get('model'), str(values.get('te_device'))])
        free, total = comfy_vram_safe(self.comfy['h']['port'])
        if free is not None:
            meta['vram_free_before_mib'] = free
        if reused and comfy_should_free(free, total, need, need_all, self.comfy.get('resident') == resident):
            progress(0.32, 'carte libérée avant le calcul')
            after = self.comfy_free(self.comfy['h'], need, stop)
            meta['freed'] = True
            if stop is not None and stop.is_set():
                raise JobLost('calcul interrompu')
            if after is None or after < need:
                log.warning('ComfyUI n\'a rendu que %s Mio sur %d demandés : relancé.', after, need)
                self.stop_comfy('carte pas assez libérée par /free')
                start()
                meta['free_restart'] = True
                after = comfy_vram_safe(self.comfy['h']['port'])[0]
            if after is not None:
                meta['vram_free_after_free_mib'] = after
            log.info('Carte libérée avant le travail %s : %s Mio libres avant, %s après (%d demandés).', job.get('id'), free, after, need)
        h = self.comfy['h']
        self.comfy['resident'] = None   # su seulement quand le calcul a abouti
        self.last_trace = h['box']['all']
        h['on_trace'] = lambda t: setattr(self, 'last_trace', t)   # avancement, précision et extrait du journal au hub pendant le calcul
        # Repris dans le journal envoyé au hub pendant le calcul : un travail raté dit lui aussi avec quels réglages
        h['box']['all'].meta.update({k: meta[k] for k in ('comfyui_flags', 'unet_dtype', 'attention', 'dynamic_vram', 'ref_megapixels',
                                                         'vram_mode', 'text_encoder', 'vram_free_before_mib', 'freed',
                                                         'vram_free_after_free_mib', 'free_restart') if k in meta})
        wf = comfy_workflow(model, values)
        inputs = lay['data'] / 'input'
        inputs.mkdir(parents=True, exist_ok=True)
        placed = []
        how = model.get('workflow_references') or {}
        for n, ref in enumerate(job.get('ref_paths') or []):
            name = 'job%d-ref%d%s' % (int(job['id']), n, Path(ref).suffix)
            shutil.copyfile(ref, inputs / name)
            placed.append(inputs / name)
            wf['ref%d' % n] = {'class_type': 'LoadImage', 'inputs': {'image': name}}
            wf[how.get('node', 'refs')]['inputs'][how.get('input', 'images.image{n}').replace('{n}', str(n))] = ['ref%d' % n, 0]
        meta['references'] = len(placed)
        out = workdir / 'out.png'
        out.unlink(missing_ok=True)
        try:
            path, run = comfy_prompt(h, wf, values['steps'], stop, lambda f, st: progress(0.35 + 0.6 * f, st),
                                     float(model.get('timeout_s') or 1800), 'génération')
            self.last_trace = h.get('trace') or self.last_trace
            if self.comfy:
                self.comfy['resident'] = resident   # poids de ce travail restés chargés : le suivant identique les garde s'ils tiennent
            shutil.copyfile(path, out)
            path.unlink(missing_ok=True)   # rien ne reste dans ComfyUI : la sortie part au hub
        except (JobLost, Final):
            self.stop_comfy('travail arrêté')   # ComfyUI calcule encore : la carte est rendue tout de suite
            raise
        finally:
            if h.get('trace') is not None:
                meta.update({k: v for k, v in h['trace'].summary().items()
                             if k in ('weight_dtype', 'compute_dtype', 'vram_state', 'load', 'dit_load', 'te_load', 'before_dit_s', 'vram_free_min_mib')})
            for p in placed:
                p.unlink(missing_ok=True)
        if self.comfy:
            after = comfy_vram_safe(h['port'])[0]
            if after is not None:
                meta['vram_free_after_mib'] = after
        return out, run

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
        if model.get('engine') == 'comfyui':
            return self.run_comfy(job, workdir, stop, progress)
        self.stop_comfy('autre moteur demandé')
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
        """Appelé par la boucle du worker : décharge les moteurs résidents après gpu_keep_loaded_s sans travail."""
        if self.comfy and (self.comfy['h']['proc'].poll() is not None or time.time() - self.comfy['h']['last_used'] > self.keep_loaded_s()):
            self.stop_comfy('%s sans travail' % fmt_duration(self.keep_loaded_s()))
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
        self.atelier = Atelier(base, self.config, self.app, self.gpu)
        self.gpu.atelier = self.atelier   # l'environnement des travaux n'est pas réinstallé sous un atelier en marche
        self.card_lock = threading.Lock()   # un travail du hub qui démarre / l'atelier qui fait vider la carte des moteurs résidents
        self.job_active = False
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
            'gpu_models': ','.join(self.gpu.models()) or None,   # modèles qui demandent plus que le moteur du type (ComfyUI)
            'tests': ','.join(GPU_TEST_KINDS),         # essais GPU que cette version sait faire sur ordre du hub
            'atelier': self.atelier.describe(),         # ComfyUI de Alice : état, écoute réelle, pare-feu, mémoire vidéo
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

        preempted = {}

        def beat():
            # Plus fréquent qu'un nettoyage : l'avancement se voit côté client et une annulation arrête la carte vite
            period = max(5, min(15, job.get('lease_s', 600) // 5))
            while True:
                if not preempted and self.atelier.busy(sure=True):
                    # Alice a lancé un calcul dans l'atelier (file lue, non vide) : il passe d'abord, ce travail repart
                    # dans la file du hub. Un atelier qui répond lentement n'arrête jamais un travail en cours.
                    preempted['why'] = ATELIER_RELEASE
                    log.info('Job %s : %s.', label, preempted['why'])
                    stop.set()
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
                refs = []
                for ref in job.get('references') or []:   # images de référence (FLUX 3 Klein), vérifiées comme l'entrée
                    fmt, n = ref.get('format'), int(ref.get('n', len(refs)))
                    if fmt not in ('png', 'jpg'):
                        raise RuntimeError('format de référence inattendu : %r' % fmt)
                    dest = jobdir / ('ref%d.%s' % (n, fmt))
                    if not (dest.exists() and sha256_file(dest) == ref['sha256']):
                        def fetch_ref(dest=dest, n=n, ref=ref):
                            status, body = self.hub.request('GET', '%s%d/references/%d' % (route, jid, n), dest=dest, timeout=300)
                            if status in (404, 409):
                                raise JobLost((body or {}).get('error', 'job repris'))
                            if status != 200:
                                raise Refused(status, (body or {}).get('error', 'téléchargement refusé'))
                            if sha256_file(dest) != ref['sha256']:
                                raise OSError('référence reçue abîmée')
                        self.hub.retrying('Téléchargement de la référence %d' % n, fetch_ref)
                    refs.append(str(dest))
                job['ref_paths'] = refs
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
            rmtree(jobdir)
            if preempted:
                self.release(jid, preempted['why'], route)
            else:
                log.warning('Job %s abandonné : le hub l\'a repris ou annulé (%s).', label, e)
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
            rmtree(jobdir)
            if preempted:   # moteur arrêté en plein calcul : pas une panne
                self.release(jid, preempted['why'], route)
                return
            log.error('Job %s raté : %s', label, e)
            self.state['last_error'] = 'job %s : %s' % (label, e)
            self.gpu.status[kind] = 'échec : %s' % str(e)[:120]
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

    def release(self, jid, reason, route):
        """Rend un travail au hub sans compter l'essai (release) : il n'a pas échoué, la carte était prise par l'atelier."""
        log.info('Travail %s rendu au hub sans compter l\'essai : %s.', jid, reason)
        try:
            self.hub.request('POST', '%s%d/fail' % (route, jid), body={'error': str(reason)[:300], 'release': True}, timeout=30)
        except OSError:
            pass

    def post_atelier_task(self, tid, body):
        status, answer = self.hub.request('POST', '/api/reuse/worker/atelier-tasks/%d' % tid, body=body, timeout=30)
        if status in (404, 409):
            return {'ok': False, 'cancel': True}
        return answer or {}

    def atelier_hold(self):
        """Atelier en calcul : signe de vie au hub (ordres et réglages reçus, dont l'arrêt de l'atelier), sans réclamer de travail."""
        if self.state['state'] != 'atelier en calcul':
            log.info('L\'atelier ComfyUI calcule : aucun travail du hub tant que sa file n\'est pas vide.')
        try:
            status, body = self.hub.request('POST', '/api/reuse/worker/status', body={'info': self.info()}, timeout=30)
            if status == 200 and body:
                self.apply_orders(body.get('orders') or {}, tests=False)
        except OSError:
            pass
        if self.atelier.busy():
            self.set_state('atelier en calcul')
            self.atelier.stopping.wait(10)

    def atelier_loop(self):
        """Fil de l'atelier : le mène (tick) et, quand il calcule entre deux travaux du hub, arrête les moteurs résidents des
        travaux (jusqu'à 11 Go gardés 10 minutes) : la carte est à Alice."""
        while not self.atelier.stopping.is_set():
            try:
                self.atelier.tick()
                if self.atelier.busy() and (self.gpu.server or self.gpu.comfy):
                    with self.card_lock:
                        if not self.job_active:
                            self.gpu.stop_server('atelier ComfyUI en calcul')
                            self.gpu.stop_comfy('atelier ComfyUI en calcul')
            except Exception as e:   # le fil ne meurt jamais : l'erreur est dite au hub
                log.exception('Atelier : %s', e)
                self.atelier.error = 'surveillance : %s' % str(e)[:200]
            self.atelier.stopping.wait(ATELIER_TICK_S)

    def give_back(self, jid, reason, route='/api/reuse/jobs/'):
        """Rend le job au hub en comptant l'essai (au bout du dernier, le hub le déclare en échec). Un échec Final n'est pas
        relancé : le même calcul referait la même chose."""
        try:
            self.hub.request('POST', '%s%d/fail' % (route, jid), body={'error': str(reason)[:300], 'final': isinstance(reason, Final)}, timeout=30)
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
        kill_orphan(self.gpu.server_pidfile, (b'sd-server',))   # ComfyUI resté en marche : arrêté juste après
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
        threading.Thread(target=self.atelier_loop, name='atelier', daemon=True).start()
        self.set_state('en attente')
        job = None
        orders = {}
        errors = 0
        while True:
            with self.card_lock:
                self.gpu.idle()
            if (self.base / 'STOP').exists():
                self.gpu.stop_server('arrêt du worker')
                self.gpu.stop_comfy('arrêt du worker')
                self.atelier.shutdown('arrêt du worker')
                log.info('Fichier STOP présent : arrêt. Le supprimer pour relancer.')
                return EXIT_STOP
            if job:
                with self.card_lock:
                    self.job_active = True
                try:
                    if job.get('kind', 'reuse') == 'reuse':
                        self.process(job)
                    else:
                        self.atelier.free('travail %s %s du hub' % (job.get('kind'), job.get('id')))
                        self.process_gpu(job)
                finally:
                    self.job_active = False
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
            if self.atelier.busy():
                self.atelier_hold()   # Alice calcule : aucun travail du hub tant que la file de l'atelier n'est pas vide
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
            if job and job.get('kind', 'reuse') != 'reuse' and self.atelier.busy(live=True, sure=True):
                # L'atelier s'est mis à calculer pendant l'attente : le travail GPU repart dans la file, essai non compté
                self.release(job['id'], ATELIER_RELEASE, '/api/gpu/jobs/')
                job = None
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
        if isinstance(orders.get('in_window'), bool):
            self.atelier.in_window = orders['in_window']   # atelier_window_only : l'atelier suit le créneau de la machine
        if isinstance(orders.get('atelier_task'), dict):
            self.atelier.submit(orders['atelier_task'], self.post_atelier_task)   # dans son propre fil : jamais bloquant
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
        if self.atelier.busy(live=True):
            return   # l'essai reste en attente sur le hub : redonné au prochain échange, quand l'atelier aura fini
        now = {'progress': 0.0, 'stage': 'préparation'}
        stop, finished = threading.Event(), threading.Event()
        why = {}

        def post(body, timeout=30):
            status, answer = self.hub.request('POST', route, body=body, timeout=timeout)
            if status in (404, 409) or (status == 200 and (answer or {}).get('cancel')):
                # Annulé, pause, fin du créneau : arrêt ; installé et téléchargé restent, l'essai suivant reprend là
                why.setdefault('reason', (answer or {}).get('reason') or (answer or {}).get('error') or 'annulé par le hub')
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
        if kind in ('comfyui', 'comfyui_remove') and self.atelier.pid:
            spec = comfy_spec(self.app)
            lay = comfy_layout(self.base, spec)
            if kind == 'comfyui_remove' or not all(comfy_done(lay, spec, x) for x in ('python', 'pip', 'source', 'torch', 'requirements')):
                post({'status': 'failed', 'report': {'ok': False, 'error': ATELIER_SHARES}})
                return
        log.info('Essai GPU %d (%s) demandé par le hub : %s', tid, kind, json.dumps(test.get('params') or {}))
        self.set_state('essai %s' % kind, 'essai %d' % tid)
        self.gpu.stop_server('essai GPU demandé')   # la carte entière pour l'essai
        self.gpu.stop_comfy('essai GPU demandé')
        self.atelier.free('essai GPU %d' % tid)
        with self.card_lock:
            self.job_active = True

        def progress(frac, stage):
            now.update(progress=round(max(0.0, min(1.0, frac)), 3), stage=str(stage)[:200])

        def beat():
            while not finished.wait(20):
                if (self.base / 'STOP').exists():   # arrêt du worker demandé sur le PC : l'essai s'arrête aussi
                    why.setdefault('reason', 'fichier STOP sur le PC')
                    stop.set()
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
            self.job_active = False
        report['test_id'] = tid
        write_json(self.base / 'logs' / 'gpu-test.json', report)
        log.info('ESSAI GPU %d %s : %s', tid, 'REUSSI' if report.get('ok') else 'RATE', json.dumps(report, ensure_ascii=False)[:2000])
        if stop.is_set() and not report.get('ok'):
            report['stopped'] = why.get('reason', 'annulé')
            report.setdefault('error', 'annulé : %s' % report['stopped'])
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
                      r'Starting server|To see the GUI|TORCH |dynamic|staged|offload|lowvram|unload|dtype', re.I)
    BAR = re.compile(r'\|\s*(\d+)/(\d+)\s*\[[^\]]*?,\s*([\d.]+)(s/it|it/s)\]')
    TAKING = (('executed_s', r'Prompt executed in ([\d.]+) seconds'),)

    def summary(self):
        meta = super().summary()
        steady = self.steady_rate()
        if steady:   # tqdm donne une moyenne lissée qui mêle la première étape au rythme établi : la médiane mesurée ici
            meta['s_per_step'] = round(steady, 2)
            meta['tqdm_s_per_step'] = round(self.step_rate, 2) if self.step_rate else None
        return meta

    def line(self, line):
        super().line(line)
        m = re.search(r'Prompt executed in (\d+):(\d\d):(\d\d)', line)   # au-delà d'une minute : « 00:10:21 »
        if m:
            self.meta['executed_s'] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        # Ce qui explique une lenteur : précision réelle, mode mémoire, chargement complet ou partiel des poids
        m = re.search(r'model weight dtype (?:torch\.)?(\w+), manual cast: (?:torch\.)?(\w+)', line)
        if m:
            self.meta.update(weight_dtype=m.group(1), compute_dtype=m.group(2) if m.group(2) != 'None' else m.group(1))
        m = re.search(r'Set vram state to: (\w+)', line)
        if m:
            self.meta['vram_state'] = m.group(1)
        m = re.search(r'Requested to load (\w+)', line)
        if m:
            name = m.group(1)
            self.loading = 'te' if re.search(r'TE|CLIP|Text', name) else ('vae' if re.search(r'Autoencoder|VAE', name, re.I) else 'dit')
            if self.loading == 'dit' and 'before_dit_s' not in self.meta:
                # Depuis le début du travail : encodage du texte et des références compris (l'encodeur passe avant le DiT)
                self.meta['before_dit_s'] = round(self.clock() - self.t0, 1)
        m = re.search(r'(loaded (?:completely|partially)[^\r\n]{0,120})', line)
        if m:
            self.meta['load'] = m.group(1)[:160]
            self.meta['%s_load' % getattr(self, 'loading', 'dit')] = m.group(1)[:160]   # dit_load : le DiT tient-il en entier ?
        if re.search(r'dynamic vram|staged', line, re.I):
            self.meta['load'] = line.strip()[:160]


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
    # Tout ce qui vit dans site-packages dépend du Python : une autre version de Python refait pip, torch et les dépendances
    part = {'python': spec['python'], 'pip': [spec['python'], spec['pip'], spec.get('setuptools')], 'source': spec['source'],
            'torch': [spec['python'], spec['torch']], 'requirements': [spec['python'], spec['source'], spec['torch']]}[step]
    return hashlib.sha256(json.dumps(part, sort_keys=True).encode()).hexdigest()[:16]


def comfy_done(lay, spec, step):
    try:
        return (lay['root'] / ('.ok-' + step)).read_text().strip() == comfy_marker(spec, step)
    except OSError:
        return False


def comfy_need_bytes(lay, spec, files=None):
    """Octets encore à poser sur le disque (poids manquants, environnement Python s'il n'est pas prêt)."""
    need = 0
    for f in (spec.get('files') or []) if files is None else files:
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
    rel = os.path.relpath(str(src_dir), str(python_dir))
    # « import site » remis à la fin ; le dossier d'une autre version de ComfyUI retiré
    lines = [l for l in lines if l != 'import site' and not (os.path.basename(l.rstrip('/\\')).startswith('ComfyUI-') and l != rel)]
    if rel not in lines:
        lines.append(rel)
    tmp = pth.with_name(pth.name + '.new')   # remplacé, jamais réécrit en place : un ._pth lié ailleurs ne bouge pas
    tmp.write_text('\n'.join(lines + ['import site']) + '\n')
    os.replace(tmp, pth)
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


# Amorçage de pip depuis sa roue, comme get-pip.py : la roue mise en tête de sys.path à l'exécution (le Python embarqué ignore
# PYTHONPATH, son ._pth fixe sys.path), puis pip lancé par son point d'entrée. Pas « python pip.whl/pip » : sous Windows,
# pip refuse de se modifier quand argv[0] s'appelle « pip » (« To modify pip, please run python -m pip ... »).
PIP_BOOTSTRAP = 'import sys; sys.path.insert(0, sys.argv[1]); from pip._internal.cli.main import main; sys.exit(main(sys.argv[2:]))'


def pip_bootstrap_command(py, wheel, wheels):
    return [py, '-s', '-c', PIP_BOOTSTRAP, str(wheel), 'install', '--no-index', '--no-warn-script-location'] + [str(w) for w in wheels]


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


def comfy_install(base, spec, gpu, stop, progress, report, files=None):
    """Installe ce qui manque, étape par étape (témoins .ok-<étape>), après contrôle du plafond et de la place libre.
    files : poids à poser (défaut : ceux du banc ; un modèle de travail donne les siens)."""
    lay = comfy_layout(base, spec)
    root = lay['root']
    root.mkdir(parents=True, exist_ok=True)
    files = (spec.get('files') or []) if files is None else files
    atelier = getattr(gpu, 'atelier', None)
    if atelier is not None and atelier.pid and not all(comfy_done(lay, spec, s) for s in ('python', 'pip', 'source', 'torch', 'requirements')):
        raise RuntimeError('environnement ComfyUI des travaux à (ré)installer : ' + ATELIER_SHARES)
    need = comfy_need_bytes(lay, spec, files)
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

    def check_stop():
        if stop is not None and stop.is_set():
            raise JobLost('installation interrompue (reprise au prochain essai)')

    def step(name, frac, label, fn):
        if comfy_done(lay, spec, name):
            return
        check_stop()
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
        run_logged(pip_bootstrap_command(py, wheel, wheels), ilog, env, 600, stop, what='installation de pip')

    def source():
        archive = download(spec['source']['url'], lay['downloads'] / ('comfyui-' + spec['source']['sha256'][:12] + '.zip'), spec['source']['sha256'], 'ComfyUI')
        for old in lay['root'].glob('ComfyUI-*'):   # version précédente du catalogue
            rmtree(old)
        rmtree(lay['src'])
        safe_extract(archive, lay['root'])
        if not (lay['src'] / 'main.py').exists():
            raise RuntimeError('archive ComfyUI sans %s/main.py' % spec['source']['root'])
        if lay['python'].exists():
            write_pth(lay['python'], lay['src'])   # le ._pth du Python pointe vers le dossier de cette version

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
    total = float(sum(int(f['size']) for f in files)) or 1.0
    done = 0.0
    for f in files:
        check_stop()
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


COMFY_VRAM_MARGIN_GB = 1.0   # en plus du plus gros modèle posé sur la carte : calcul, VAE (réglable par modèle : vram_margin_gb)
COMFY_FREE_WAIT_S = 20       # après POST /free, ComfyUI décharge dans son fil de travail : la place revient en une seconde ou deux


def comfy_vram(port):
    """Mémoire de la carte vue par ComfyUI -> (Mio libres, Mio au total), None si inconnu."""
    dev = (((comfy_local(port, 'GET', '/system_stats', timeout=10)[1] or {}).get('devices') or [{}])[0])
    mib = lambda v: int(v / 1048576) if isinstance(v, (int, float)) else None
    return mib(dev.get('vram_free')), mib(dev.get('vram_total'))


def comfy_vram_safe(port, timeout=30):
    """Comme comfy_vram, mais une lecture ratée donne (None, None) : c'est un relevé, il ne fait jamais échouer un travail.
    Job 75 : « timed out » juste après « Prompt executed », quand ComfyUI vide la carte et que /system_stats attend la carte."""
    try:
        dev = (((comfy_local(port, 'GET', '/system_stats', timeout=timeout)[1] or {}).get('devices') or [{}])[0])
    except (OSError, ValueError) as e:
        log.warning('Mémoire vidéo de ComfyUI non lue (%s) : relevé sauté.', e)
        return None, None
    mib = lambda v: int(v / 1048576) if isinstance(v, (int, float)) else None
    return mib(dev.get('vram_free')), mib(dev.get('vram_total'))


def comfy_vram_need(model, values):
    """Mio qu'un travail pose sur la carte -> (plus gros modèle + marge, tous ses modèles + marge). ComfyUI charge un modèle
    à la fois (encodeur texte, DiT, VAE) ; l'encodeur n'y va pas s'il tourne sur le processeur (te_device cpu)."""
    sizes = [int(f.get('size') or 0) / 1048576 for f in model.get('files') or []
             if not (f.get('dir') == 'text_encoders' and str(values.get('te_device')) == 'cpu')]
    margin = float(model.get('vram_margin_gb') or COMFY_VRAM_MARGIN_GB) * 1024
    return int(max(sizes or [0]) + margin), int(sum(sizes) + margin)


def comfy_should_free(free_mib, total_mib, need_mib, all_mib, same_resident):
    """Libérer la carte avant le travail ? Oui si la place libre ne suffit pas au plus gros modèle à charger, sauf si les poids
    restés chargés sont ceux de ce travail et tiennent tous ensemble sur la carte (rien à recharger : gain gardé). Avec
    --highvram, un modèle qui ne tient pas est chargé quand même et déborde en mémoire partagée : Klein passe de 18 à 111 s
    par étape quand le DiT du travail précédent occupe encore 11 Go (job 67)."""
    if free_mib is None or free_mib >= need_mib:
        return False
    return not (same_resident and total_mib and all_mib <= total_mib)


ATTENTION_FLAGS = ('--use-quad-cross-attention', '--use-split-cross-attention', '--use-pytorch-cross-attention')
# Options d'essai de ComfyUI qu'un admin peut ajouter à un job (paramètre comfyui_options, liste séparée par des virgules) :
# jeton -> (options en plus, options retirées, variables d'environnement). Rien d'autre n'atteint la ligne de commande.
COMFY_OPTIONS = {
    'kitchen_hip_off': ([], [], {'COMFY_KITCHEN_DISABLE_HIP': '1'}),      # noyaux HIP de comfy-kitchen coupés (eager)
    'upcast_attention': (['--force-upcast-attention'], [], {}),           # attention en fp32 dans un modèle fp16
    'no_upcast_attention': (['--dont-upcast-attention'], [], {}),
    'fp16_accumulation': (['--fast', 'fp16_accumulation'], [], {}),
    'pinned_memory': ([], ['--disable-pinned-memory'], {}),
    'no_async_offload': (['--disable-async-offload'], [], {}),
    'no_smart_memory': (['--disable-smart-memory'], [], {}),           # modèle inutilisé déchargé tout de suite (l'encodeur avant le DiT)
    'reserve_vram_2': (['--reserve-vram', '2'], [], {}),
    'no_comfy_compiler': (['--disable-comfy-compiler'], [], {}),
    # Allocateur de PyTorch : au-delà de la mémoire physique, Windows prête de la mémoire partagée (lente) au lieu d'échouer
    'alloc_expandable': ([], [], {'PYTORCH_HIP_ALLOC_CONF': 'expandable_segments:True', 'PYTORCH_ALLOC_CONF': 'expandable_segments:True'}),
    'alloc_gc': ([], [], {'PYTORCH_HIP_ALLOC_CONF': 'garbage_collection_threshold:0.7,max_split_size_mb:256',
                          'PYTORCH_ALLOC_CONF': 'garbage_collection_threshold:0.7,max_split_size_mb:256'}),
}


def comfy_options(text):
    """-> (options en plus, options retirées, environnement, jetons inconnus) pour le paramètre comfyui_options."""
    add, drop, env, unknown = [], [], {}, []
    for tok in [t.strip().lower() for t in str(text or '').split(',') if t.strip()]:
        if tok == 'no_fallback':
            continue   # lu par run_comfy
        if tok not in COMFY_OPTIONS:
            unknown.append(tok)
            continue
        a, d, e = COMFY_OPTIONS[tok]
        add += [x for x in a if x not in add]
        drop += d
        env.update(e)
    return add, drop, env, unknown


def comfy_args(spec, port, base, extra=()):
    """Ligne de commande de ComfyUI : celle du catalogue, et les réglages du modèle (précision, attention, mémoire) ; une
    attention demandée remplace celle du catalogue (ComfyUI n'en prend qu'une)."""
    args = build_command(spec['args'], {'port': port, 'base': base})
    if any(a in ATTENTION_FLAGS for a in extra):
        args = [a for a in args if a not in ATTENTION_FLAGS]
    drop = [a[1:] for a in extra if a.startswith('!')]   # « !--option » : retirée de la ligne du catalogue
    return [a for a in args if a not in drop] + [a for a in extra if not a.startswith('!') and a not in args]


def comfy_start(lay, env, spec, gpu, stop, progress, extra=()):
    """ComfyUI lancé sur 127.0.0.1, sans interface, journal dans gpu/logs/comfyui.log. -> poignée {proc, port, box, th, stats}."""
    probe = socket.socket()
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
    probe.close()
    lay['data'].mkdir(parents=True, exist_ok=True)
    args = [str(lay['exe']), '-s', str(lay['src'] / 'main.py')] + comfy_args(spec, port, str(lay['data']), extra)
    flags, kwargs = gpu.spawn_options()
    logs = gpu.root / 'logs'
    logs.mkdir(parents=True, exist_ok=True)
    out_log = open(logs / 'comfyui.log', 'wb')
    out_log.write(('# %s\n' % ' '.join(args[2:])).encode('utf-8', 'replace'))
    t0 = time.time()
    proc = subprocess.Popen(args, cwd=str(lay['src']), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            env=env, creationflags=flags, **kwargs)
    lay['pid'].write_text(str(proc.pid))
    box = {'trace': ComfyTrace(), 'all': ComfyTrace(), 'written': 0}

    def reader():
        for block in iter(lambda: proc.stdout.read1(4096) if hasattr(proc.stdout, 'read1') else proc.stdout.read(4096), b''):
            if box['written'] < (50 << 20):   # résident : journal borné
                out_log.write(block)
                out_log.flush()
                box['written'] += len(block)
            box['trace'].feed(block)
            box['all'].feed(block)
        out_log.close()
    th = threading.Thread(target=reader, daemon=True)
    th.start()
    h = {'proc': proc, 'port': port, 'box': box, 'th': th, 'lay': lay, 'last_used': time.time()}
    try:
        start_timeout = float(spec.get('start_timeout_s') or 900)
        while True:
            if stop is not None and stop.is_set():
                raise JobLost('interrompu au démarrage de ComfyUI')
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
            progress(0.3, 'démarrage de ComfyUI')
            time.sleep(2)
    except BaseException:
        comfy_stop(h)
        raise
    h['start_s'] = round(time.time() - t0, 1)
    h['stats'] = stats or {}
    return h


def comfy_stop(h):
    if not h:
        return
    if h['proc'].poll() is None:
        h['proc'].kill()
        try:
            h['proc'].wait(30)
        except subprocess.TimeoutExpired:
            pass
    h['th'].join(5)
    if h['proc'].stdout:
        h['proc'].stdout.close()
    h['lay']['pid'].unlink(missing_ok=True)


def comfy_prompt(h, wf, steps, stop, progress, timeout, label='calcul'):
    """Un workflow joué par ComfyUI. -> (chemin de la première image, mesures). progress(fraction 0..1 du calcul, étape)."""
    trace = ComfyTrace(int(steps))
    trace.meta.update({k: v for k, v in h['box']['all'].meta.items() if k not in ('before_dit_s', 'vram_free_min_mib')})   # précision, mode mémoire
    trace.lines = list(h['box']['all'].lines[-30:])
    h['box']['trace'] = trace
    h['trace'] = trace
    gpu_trace_hook = h.get('on_trace')
    if gpu_trace_hook:
        gpu_trace_hook(trace)
    port, proc = h['port'], h['proc']
    t1 = time.time()
    status, answer = comfy_local(port, 'POST', '/prompt', {'prompt': wf, 'client_id': 'reuse-worker'}, timeout=60)
    pid = (answer or {}).get('prompt_id')
    if status != 200 or not pid:
        raise RuntimeError('ComfyUI refuse le workflow (HTTP %s) : %s' % (status, json.dumps(answer, ensure_ascii=False)[:400]))
    entry = None
    while entry is None:
        if stop is not None and stop.is_set():
            raise JobLost('calcul interrompu')
        if proc.poll() is not None:
            raise RuntimeError('ComfyUI s\'est arrêté pendant le calcul (code %s) : %s' % (proc.returncode, ' | '.join(h['box']['all'].lines[-4:])[-400:]))
        if time.time() - t1 > timeout:
            raise Final('%s trop long (plus de %s)' % (label, fmt_duration(timeout)))
        # Dès trois étapes : si le rythme établi (la première étape mise à part, elle porte les frais d'une fois) ne tient pas
        # dans le plafond, on s'arrête tout de suite, avec la raison. Jobs 54 et 57 : arrêtés sur la moyenne de tqdm à deux
        # étapes (115,8 s), qui mêlait la première étape au rythme réel.
        steady = trace.steady_rate()
        if steady and time.time() - t1 + steady * (int(steps) - trace.step) > timeout:
            raise Final('%s trop lent : %.1f s par étape (étapes : %s), %d étapes, plafond %s (précision %s/%s, chargement : %s)' % (
                label, steady, ','.join('%.0f' % x for x in trace.step_durations()), int(steps), fmt_duration(timeout),
                trace.meta.get('weight_dtype', '?'), trace.meta.get('compute_dtype', '?'), trace.meta.get('load', '?')))
        progress(max(0.0, min(1.0, (trace.progress - 0.35) / 0.55)), '%s : %s' % (label, trace.stage()))
        # Mémoire vidéo libre pendant l'échantillonnage (le plus bas vu) : dès la première étape vue, puis toutes les 5 s
        if trace.step and ('vram_free_min_mib' not in trace.meta or int(time.time() - t1) % 5 == 0):
            try:
                dev = ((comfy_local(port, 'GET', '/system_stats', timeout=5)[1] or {}).get('devices') or [{}])[0]
                if dev.get('vram_free') is not None:
                    low = int(dev['vram_free'] / 1048576)
                    trace.meta['vram_free_min_mib'] = min(low, trace.meta.get('vram_free_min_mib', low))
            except OSError:
                pass
        time.sleep(1)
        try:   # une lecture lente (ComfyUI vide la carte après le calcul) n'arrête pas le suivi : plafond et processus le bornent
            status, hist = comfy_local(port, 'GET', '/history/%s' % pid, timeout=30)
        except (OSError, ValueError) as e:
            trace.meta['history_retries'] = trace.meta.get('history_retries', 0) + 1
            log.warning('Suivi du calcul : /history pas lu (%s), nouvel essai.', e)
            continue
        if status == 200 and isinstance(hist, dict) and pid in hist:
            entry = hist[pid]
    h['last_used'] = time.time()
    st = entry.get('status') or {}
    meta = dict(trace.summary(), wall_s=round(time.time() - t1, 1))
    if st.get('status_str') != 'success':
        msgs = [m for m in st.get('messages') or [] if m and m[0] == 'execution_error']
        e = (msgs[0][1] if msgs else {}) or {}
        raise RuntimeError('%s raté : %s %s' % (label, e.get('exception_type', ''), str(e.get('exception_message', st))[:300]))
    images = [im for node in (entry.get('outputs') or {}).values() for im in node.get('images') or []]
    if not images:
        raise RuntimeError('%s : aucune image produite' % label)
    im = images[0]
    return h['lay']['data'] / 'output' / (im.get('subfolder') or '') / im['filename'], meta


def comfy_bench(lay, env, spec, gpu, values, runs, stop, progress, report):
    """Le workflow de référence joué runs fois (graine différente à chaque fois, sinon ComfyUI ressert son cache), mesures par
    passage, puis arrêt : la carte est rendue."""
    h = comfy_start(lay, env, spec, gpu, stop, lambda f, st: progress(0.5, st))
    gpu.last_trace = h['box']['all']
    try:
        report['start_s'] = h['start_s']
        stats = h['stats']
        dev = (stats.get('devices') or [{}])[0]
        report['comfyui_system'] = {k: (stats.get('system') or {}).get(k) for k in ('comfyui_version', 'pytorch_version', 'python_version', 'os')}
        report['device'] = {k: dev.get(k) for k in ('name', 'type', 'vram_total', 'vram_free')}
        timeout = float(spec.get('timeout_s') or 3600)
        out_runs = []
        for i in range(runs):
            wf = comfy_workflow(spec, dict(values, seed=int(values['seed']) + i))
            path, meta = comfy_prompt(h, wf, values['steps'], stop,
                                      lambda f, st, i=i: progress(0.55 + 0.4 * (i + f) / runs, 'passage %d/%d : %s' % (i + 1, runs, st.split(' : ', 1)[-1])),
                                      timeout, 'passage %d' % (i + 1))
            run = {'run': i + 1, 'seed': int(values['seed']) + i, **meta}
            size = png_size(path) if path.exists() else None
            if tuple(size or ()) != (int(values['width']), int(values['height'])):
                raise RuntimeError('passage %d : image %s au lieu de %dx%d' % (i + 1, size, values['width'], values['height']))
            run['image'] = png_stats(path)
            kept = gpu.root.parent / 'logs' / ('gpu-test-comfyui-%d.png' % (i + 1))
            shutil.copyfile(path, kept)
            report['output'] = str(kept)
            out_runs.append(run)
        report['runs'] = out_runs
        _, stats = comfy_local(h['port'], 'GET', '/system_stats', timeout=10)
        dev = ((stats or {}).get('devices') or [{}])[0]
        report['device']['vram_free_after'] = dev.get('vram_free')
    finally:
        comfy_stop(h)
    return out_runs


def comfy_pick_device(lay, env, spec, gpu, stop, report):
    """Version, cartes et architectures vues par PyTorch ; pose HIP_VISIBLE_DEVICES dans env si ROCm voit plusieurs cartes."""
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
    return card


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
        comfy_pick_device(lay, env, spec, gpu, stop, report)   # contrôle à chaque essai (10 à 20 s)
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
# ---- Atelier ComfyUI : l'instance de Alice, à côté de celle des travaux -----------------------------------------
# Une seconde instance de ComfyUI, pour un humain : nœuds additionnels et ComfyUI-Manager permis, port fixe, écoute sur
# 127.0.0.1 et sur l'adresse Tailscale du PC (jamais 0.0.0.0), modèles des travaux partagés en lecture. Lancée et surveillée
# par le worker, sans fenêtre, allumée ou éteinte depuis le hub (réglage atelier_enabled). Un seul calcul à la fois sur la
# carte : tant que l'atelier calcule ou a une file, le worker ne prend aucun travail du hub ; avant un travail GPU du hub,
# il vide la carte de l'atelier (POST /free) ; l'atelier rend sa mémoire vidéo après 10 minutes sans calcul.
ATELIER_PORT = 8188
ATELIER_IDLE_FREE_S = 600        # carte rendue par l'atelier après ce temps sans calcul (réglable : atelier_idle_free_s, 0 = jamais)
ATELIER_TICK_S = 3.0             # surveillance : file de l'atelier lue toutes les 3 s (requête locale)
ATELIER_FW_GROUP = 'ComfyUI atelier'   # groupe des règles de pare-feu créées par la commande administrateur (GPU.md)
ATELIER_TS_RETRY_S = 120         # Tailscale pas prêt ou pare-feu absent : nouveau regard toutes les 2 minutes
ATELIER_TS_RECHECK_S = 600       # adresse Tailscale et pare-feu relus toutes les 10 minutes une fois bons
ATELIER_NET_S = 60               # adresses d'écoute réelles (netstat) relues toutes les minutes
ATELIER_HUNG_S = 300             # sans réponse à /queue depuis 5 minutes : relancé (réglable dans la config : atelier_hung_s)
ATELIER_SHARES = ('l\'atelier ComfyUI tourne et partage les fichiers de l\'environnement des travaux (liens physiques) : '
                  'l\'éteindre d\'abord (POST /api/reuse/workers/<nom>/atelier {"on":false})')
ATELIER_RELEASE = 'atelier ComfyUI en calcul : travail rendu à la file, il reprendra plus tard'
ATELIER_FREE_DONE_MIB = 1024     # mémoire gardée par le PyTorch de l'atelier sous laquelle la carte est rendue
ATELIER_KEEP_DAYS = 7            # sorties et images envoyées gardées 7 jours (réglable : atelier_keep_days)
ATELIER_FILES_MAX_GB = 20.0      # et 20 Go au plus à elles deux, les plus anciennes d'abord (réglable : atelier_files_max_gb)
ATELIER_PURGE_S = 600            # ménage toutes les 10 minutes
TAILNET = ipaddress.ip_network('100.64.0.0/10')
LOOPBACK = ipaddress.ip_network('127.0.0.0/8')


def atelier_layout(base, spec):
    root = base / 'atelier'   # hors de gpu\ : ni compté dans gpu_max_gb, ni touché par le ménage du catalogue
    return {'root': root, 'python': root / 'python', 'src': root / spec['source']['root'], 'data': root / 'data',
            'tmp': root / 'tmp', 'cache': root / 'cache', 'logs': root / 'logs', 'state': root / 'atelier.json',
            'extra': root / 'extra_model_paths.yaml', 'exe': root / 'python' / ('python.exe' if IS_WINDOWS else 'bin/python3'),
            'jobs': comfy_layout(base, spec)}


def link_tree(src, dst, copy_names=r'.*\._pth|pyvenv\.cfg'):
    """Copie d'un dossier par liens physiques : rien de plus sur le disque. pip et Python remplacent un fichier (nouveau
    fichier, puis renommage) au lieu de l'écrire en place : les deux copies restent indépendantes. Les fichiers que le worker
    réécrit lui-même (._pth) sont copiés. Copie classique si le lien est refusé. -> (liés, copiés)."""
    src, dst = Path(src), Path(dst)
    linked = copied = 0
    for d, dirs, files in os.walk(src):
        rel = Path(d).relative_to(src)
        (dst / rel).mkdir(parents=True, exist_ok=True)
        for name in list(dirs):
            if (Path(d) / name).is_symlink():
                os.symlink(os.readlink(Path(d) / name), dst / rel / name, target_is_directory=True)
                dirs.remove(name)
        for name in files:
            s, t = Path(d) / name, dst / rel / name
            if s.is_symlink():
                os.symlink(os.readlink(s), t)
                continue
            if not re.fullmatch(copy_names, name):
                try:
                    os.link(s, t)
                    linked += 1
                    continue
                except OSError:
                    pass
            shutil.copy2(s, t)
            copied += 1
    return linked, copied


def can_hardlink(folder):
    folder = Path(folder)
    a, b = folder / '.link-probe-a', folder / '.link-probe-b'
    try:
        a.write_bytes(b'x')
        os.link(a, b)
        return True
    except OSError:
        return False
    finally:
        a.unlink(missing_ok=True)
        b.unlink(missing_ok=True)


def redact(line):
    """Masque ce qui ressemble à un secret dans une ligne de journal (jeton=…, clé: …, Bearer …, longue suite hexadécimale)."""
    line = re.sub(r'(?i)\b(token|api[_-]?key|key|password|passwd|secret|authorization|bearer)\b(\s*[=:]\s*|\s+)\S+', r'\1\2***', line)
    return re.sub(r'\b[A-Za-z0-9_\-]{32,}\b', '***', line)


def listen_ip_ok(text):
    """Adresse d'écoute en plus de 127.0.0.1 : une adresse IPv4 précise, jamais 0.0.0.0, une diffusion ou une boucle."""
    try:
        ip = ipaddress.ip_address(str(text).strip())
    except ValueError:
        return None
    if ip.version != 4 or ip.is_unspecified or ip.is_multicast or ip.is_loopback or ip == ipaddress.ip_address('255.255.255.255'):
        return None
    return str(ip)


def parse_tailscale_ip(text):
    """Première adresse du tailnet (100.64.0.0/10) dans la sortie de « tailscale ip -4 »."""
    for tok in re.findall(r'(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])', text or ''):
        try:
            ip = ipaddress.ip_address(tok)
        except ValueError:
            continue
        if ip in TAILNET:
            return str(ip)
    return None


def tailscale_exe():
    exe = shutil.which('tailscale')
    if exe or not IS_WINDOWS:
        return exe
    for root in (os.environ.get('ProgramFiles'), os.environ.get('ProgramW6432'), r'C:\Program Files'):
        p = Path(root or r'C:\Program Files') / 'Tailscale' / 'tailscale.exe'
        if p.exists():
            return str(p)
    return None


def quiet_run(args, timeout=30):
    """Commande courte sans fenêtre -> (code, sortie texte)."""
    r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=timeout,
                       creationflags=subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0)
    return r.returncode, r.stdout.decode('utf-8', 'replace')


def tailscale_ip():
    """-> (adresse IPv4 Tailscale de ce PC, None si inconnue ; raison lisible si inconnue)."""
    exe = tailscale_exe()
    if not exe:
        return None, 'tailscale introuvable sur ce PC'
    try:
        code, out = quiet_run([exe, 'ip', '-4'], timeout=20)
    except (OSError, subprocess.SubprocessError) as e:
        return None, 'tailscale ip -4 : %s' % e
    ip = parse_tailscale_ip(out)
    return ip, None if ip else ('tailscale pas prêt : %s' % (out.strip()[:160] or 'code %s' % code))


def parse_netstat(text):
    """Sockets TCP en écoute de « netstat -ano » -> [(adresse locale, port, pid)]. Une ligne d'écoute a pour adresse distante
    0.0.0.0:0 ou [::]:0 (la colonne d'état est traduite selon la langue de Windows)."""
    out = []
    for line in (text or '').splitlines():
        p = line.split()
        if len(p) < 4 or p[0].upper() != 'TCP' or p[2] not in ('0.0.0.0:0', '[::]:0', '*:*'):
            continue
        host, _, port = p[1].rpartition(':')
        try:
            out.append((host.strip('[]'), int(port), int(p[-1])))
        except ValueError:
            continue
    return out


def process_exe(pid):
    """Chemin du programme du processus pid ('' s'il n'existe pas ou n'est pas lisible)."""
    try:
        if IS_WINDOWS:
            shell = shutil.which('powershell') or shutil.which('pwsh')
            if not shell:
                return ''
            return quiet_run([shell, '-NoProfile', '-NonInteractive', '-Command',
                              '(Get-Process -Id %d -ErrorAction SilentlyContinue).Path' % int(pid)], timeout=60)[1].strip()
        return os.readlink('/proc/%d/exe' % int(pid))
    except (OSError, ValueError, subprocess.SubprocessError):
        return ''


def pid_alive(pid):
    """Ce processus tourne-t-il ? Appel système direct, sans lancer PowerShell (lu toutes les 3 s)."""
    try:
        if IS_WINDOWS:
            import ctypes
            k = ctypes.windll.kernel32
            h = k.OpenProcess(0x1000, False, int(pid))   # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return False
            code = ctypes.c_ulong()
            ok = k.GetExitCodeProcess(h, ctypes.byref(code))
            k.CloseHandle(h)
            return bool(ok) and code.value == 259     # STILL_ACTIVE
        return Path('/proc/%d/stat' % int(pid)).read_text().split(' ')[2] != 'Z'
    except (OSError, ValueError, IndexError, AttributeError):
        return False


def same_file(a, b):
    try:
        return bool(a) and bool(b) and os.path.normcase(str(Path(a).resolve())) == os.path.normcase(str(Path(b).resolve()))
    except OSError:
        return False


def ip_ranges(entries):
    """Adresses distantes d'une règle de pare-feu Windows (« Any », 1.2.3.4, 1.2.3.0/24, 1.2.3.0/255.255.255.0, a-b)
    -> [(début, fin)] en entiers IPv4 ; les adresses IPv6 et les mots-clés (LocalSubnet…) sont écartés. None : « Any »."""
    out = []
    for e in entries or []:
        e = str(e).strip()
        if e.lower() in ('any', '*'):
            return None
        try:
            if '-' in e:
                a, b = (ipaddress.ip_address(x.strip()) for x in e.split('-', 1))
                if a.version == 4 and b.version == 4:
                    out.append((int(a), int(b)))
            else:
                n = ipaddress.ip_network(e, strict=False)
                if n.version == 4:
                    out.append((int(n.network_address), int(n.broadcast_address)))
        except ValueError:
            continue
    return out


def atelier_firewall_check(rules, exe):
    """Les règles du groupe « ComfyUI atelier » protègent-elles l'atelier ? rules : [{name, action, direction, enabled, remote,
    program}] lues par PowerShell. Il faut, pour le Python de l'atelier, une règle entrante qui autorise des adresses du
    tailnet seulement, et une règle entrante qui bloque tout le reste de l'IPv4 (boucle locale mise à part) : un blocage
    l'emporte sur toute autorisation, même une règle posée ailleurs. -> {ok, allow_from, problem}."""
    mine = [r for r in rules or [] if str(r.get('enabled')).lower() == 'true' and str(r.get('direction')).lower() == 'inbound'
            and same_file(os.path.expandvars(str(r.get('program') or '')), exe)]
    allow = [r for r in mine if str(r.get('action')).lower() == 'allow']
    block = [r for r in mine if str(r.get('action')).lower() == 'block']
    allowed = []
    for r in allow:
        ranges = ip_ranges(r.get('remote'))
        if ranges is None:
            return {'ok': False, 'allow_from': ['Any'], 'problem': 'règle « %s » ouverte à toute adresse' % r.get('name')}
        for a, b in ranges:
            if not (ipaddress.ip_address(a) in TAILNET and ipaddress.ip_address(b) in TAILNET):
                return {'ok': False, 'allow_from': [str(ipaddress.ip_address(a))], 'problem': 'règle « %s » ouverte hors du tailnet' % r.get('name')}
            allowed.append((a, b))
    if not allowed:
        return {'ok': False, 'allow_from': [], 'problem': 'aucune règle « %s » n\'autorise le poste client' % ATELIER_FW_GROUP}
    shown = sorted({str(ipaddress.ip_address(a)) if a == b else '%s-%s' % (ipaddress.ip_address(a), ipaddress.ip_address(b)) for a, b in allowed})
    if len(allowed) > 1 or allowed[0][0] != allowed[0][1]:
        return {'ok': False, 'allow_from': shown, 'problem': 'plus d\'une adresse autorisée (une seule attendue : le poste client)'}
    blocked = []
    for r in block:
        ranges = ip_ranges(r.get('remote'))
        blocked += [(0, 2 ** 32 - 1)] if ranges is None else ranges
    if any(c <= allowed[0][0] <= d for c, d in blocked):   # un blocage l'emporte sur une autorisation
        return {'ok': False, 'allow_from': shown, 'problem': 'le poste client est bloqué aussi par la règle de blocage'}
    # Ce qui doit être bloqué : tout l'IPv4 sauf la boucle locale et l'adresse autorisée
    holes = sorted(allowed + [(int(LOOPBACK.network_address), int(LOOPBACK.broadcast_address))])
    need, start = [], 0
    for a, b in holes:
        if a > start:
            need.append((start, a - 1))
        start = max(start, b + 1)
    if start <= 2 ** 32 - 1:
        need.append((start, 2 ** 32 - 1))
    for a, b in need:
        pos = a
        for c, d in sorted(blocked):
            if c <= pos <= d:
                pos = d + 1
            if pos > b:
                break
        if pos <= b:
            return {'ok': False, 'allow_from': shown, 'problem': 'le reste des adresses n\'est pas bloqué (dès %s)' % ipaddress.ip_address(pos)}
    return {'ok': True, 'allow_from': shown, 'problem': None}


FIREWALL_READ = ("$o=@(); foreach($r in @(Get-NetFirewallRule -Group '%s' -ErrorAction SilentlyContinue)){"
                 "$a=$r|Get-NetFirewallAddressFilter; $p=$r|Get-NetFirewallApplicationFilter;"
                 "$o+=[pscustomobject]@{name=$r.DisplayName; action=\"$($r.Action)\"; direction=\"$($r.Direction)\"; enabled=\"$($r.Enabled)\";"
                 " remote=@($a.RemoteAddress); program=$p.Program}}; ConvertTo-Json -InputObject @($o) -Compress -Depth 3") % ATELIER_FW_GROUP


def read_firewall_rules():
    """Règles du groupe de l'atelier (lecture seule, sans droits administrateur). -> (liste, erreur)."""
    shell = shutil.which('powershell') or shutil.which('pwsh')
    if not IS_WINDOWS or not shell:
        return None, 'pare-feu Windows absent ici'
    try:
        code, out = quiet_run([shell, '-NoProfile', '-NonInteractive', '-Command', FIREWALL_READ], timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        return None, str(e)
    text = out.strip()
    try:
        rules = json.loads(text[text.index('['):]) if '[' in text else []
    except ValueError:
        return None, 'lecture du pare-feu : %s' % text[:160]
    return [r for r in rules if isinstance(r, dict)], None


def purge_files(folders, keep_days, max_bytes, now=None):
    """Ménage de l'atelier : fichiers plus vieux que keep_days, puis les plus anciens tant que le total dépasse max_bytes.
    Les noms cachés (.xxx) et les fichiers témoins de ComfyUI sont laissés. -> (fichiers retirés, octets retirés, octets restants)."""
    now = time.time() if now is None else now
    files = []
    for root in folders:
        for d, dirs, names in os.walk(root):
            dirs[:] = [x for x in dirs if not x.startswith('.')]
            for n in names:
                if n.startswith('.') or n.startswith('_') and n.endswith('_here'):
                    continue
                p = Path(d) / n
                try:
                    st = p.stat()
                except OSError:
                    continue
                files.append((st.st_mtime, st.st_size, p))
    files.sort()
    total = sum(f[1] for f in files)
    removed = freed = 0
    for mtime, size, p in files:
        if now - mtime <= keep_days * 86400 and total <= max_bytes:
            break
        try:
            p.unlink()
        except OSError:
            continue
        removed, freed, total = removed + 1, freed + size, total - size
    for root in folders:   # sous-dossiers vidés
        for d, dirs, names in sorted(os.walk(root), key=lambda x: -len(x[0])):
            if Path(d) != Path(root) and not os.listdir(d):
                try:
                    os.rmdir(d)
                except OSError:
                    pass
    return removed, freed, total


def atelier_extra_paths(models_dir):
    """extra_model_paths.yaml : les poids des travaux (gpu\\comfyui\\data\\models), en plus de ceux de l'atelier."""
    base = str(models_dir).replace('\\', '/').replace("'", "''")
    lines = ['# Écrit par le worker à chaque démarrage de l\'atelier : modèles des travaux du hub, partagés.',
             'reuse_jobs:', "    base_path: '%s'" % base]
    names = sorted(p.name for p in Path(models_dir).iterdir() if p.is_dir()) if Path(models_dir).is_dir() else []
    for name in names:
        if re.fullmatch(r'[\w.-]+', name):
            lines.append('    %s: %s' % (name, name))
    return '\n'.join(lines) + '\n'


def atelier_args(spec, atelier, port, listen, data, extra, manager):
    args = build_command(atelier['args'], {'port': port, 'listen': listen, 'base': str(data), 'extra': str(extra)})
    if manager:
        args += [a for a in atelier.get('manager_args') or [] if a not in args]
    if '0.0.0.0' in ','.join(args) or '::' in [x.strip() for x in listen.split(',')]:
        raise RuntimeError('écoute sur toutes les adresses refusée')
    return args


# ---- Tâches d'atelier données par le hub : packs de nœuds et fichiers de modèle, journalisés et réversibles -------------
ATELIER_TASK_ACTIONS = ('install_nodes', 'remove_nodes', 'download_model', 'remove_model', 'undo')
ATELIER_TRASH_DAYS = 30          # ce qu'une tâche a remplacé ou retiré reste 30 jours dans atelier\trash (undo possible)
GITHUB_REPO = re.compile(r'https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?')
SAFE_PART = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.() +-]{0,119}')
MODEL_EXT = re.compile(r'.+\.(safetensors|sft|gguf|pt|pth|bin|ckpt|onnx)', re.I)


def check_atelier_task(action, p):
    """Mêmes règles que le hub (src/services/atelier-tasks.js), revérifiées ici : rien d'autre n'atteint le disque ou pip.
    -> paramètres nettoyés ; ValueError si refusés."""
    p = p if isinstance(p, dict) else {}
    if action not in ATELIER_TASK_ACTIONS:
        raise ValueError('action inconnue : %r' % action)
    if action == 'install_nodes':
        m = GITHUB_REPO.fullmatch(str(p.get('url') or ''))
        if not m or not re.fullmatch(r'[0-9a-f]{40}', str(p.get('commit') or '')):
            raise ValueError('install_nodes : url https://github.com/<compte>/<dépôt> et commit (40 caractères hexadécimaux) attendus')
        name = str(p.get('name') or m.group(2))
        if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}', name):
            raise ValueError('nom de pack refusé : %r' % name)
        return {'url': 'https://github.com/%s/%s' % (m.group(1), m.group(2)), 'owner': m.group(1), 'repo': m.group(2),
                'commit': p['commit'], 'name': name, 'pip': p.get('pip') is not False}
    if action == 'remove_nodes':
        name = str(p.get('name') or '')
        if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}', name):
            raise ValueError('nom de pack refusé : %r' % name)
        return {'name': name}
    if action in ('download_model', 'remove_model'):
        folder = str(p.get('folder') or '')
        if not re.fullmatch(r'[a-z][a-z0-9_]{1,40}(/[A-Za-z0-9_][A-Za-z0-9_.-]{0,59})?', folder):
            raise ValueError('dossier de modèle refusé : %r (ex. loras, upscale_models, model_patches)' % folder)
        url = str(p.get('url') or '')
        name = str(p.get('name') or urllib.parse.unquote(urllib.parse.urlsplit(url).path.rsplit('/', 1)[-1]))
        if not SAFE_PART.fullmatch(name) or not MODEL_EXT.fullmatch(name) or '..' in name:
            raise ValueError('nom de fichier refusé : %r (safetensors, gguf, pt, pth, bin, ckpt, onnx)' % name)
        if action == 'remove_model':
            return {'folder': folder, 'name': name}
        if not re.fullmatch(r'https://\S{1,2000}', url) or not re.fullmatch(r'[0-9a-f]{64}', str(p.get('sha256') or '')):
            raise ValueError('download_model : url https et sha256 (64 caractères hexadécimaux) attendus')
        size = p.get('size')
        if size is not None and (not isinstance(size, int) or isinstance(size, bool) or size <= 0):
            raise ValueError('size : nombre d\'octets attendu')
        return {'url': url, 'sha256': p['sha256'], 'folder': folder, 'name': name, 'size': size}
    task = p.get('task')
    if not isinstance(task, int) or isinstance(task, bool) or task <= 0:
        raise ValueError('undo : numéro de tâche attendu')
    return {'task': task}


def fetch_file(url, dest, stop=None, timeout=120):
    """Téléchargement simple (archive d'un commit GitHub) -> empreinte SHA-256 de ce qui a été reçu."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'reuse-worker'}), timeout=timeout) as r, open(dest, 'wb') as f:
        for block in iter(lambda: r.read(1 << 20), b''):
            if stop is not None and stop.is_set():
                raise JobLost('téléchargement interrompu')
            f.write(block)
            h.update(block)
    return h.hexdigest()


def remote_size(url, timeout=60):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'reuse-worker'}), timeout=timeout) as r:
            n = r.headers.get('Content-Length')
            return int(n) if n and int(n) > 0 else None
    except (OSError, ValueError):
        return None


def pip_freeze(py, env, log_path, stop=None):
    out = run_logged([py, '-s', '-m', 'pip', 'freeze', '--all'], log_path, env, 300, stop, what='état de pip')
    return sorted({l.strip() for l in out.splitlines() if re.match(r'^[A-Za-z0-9_.-]+(==| @ )', l.strip())})


def pip_changes(before, after):
    b, a = set(before), set(after)
    return {'added': sorted(a - b)[:60], 'removed': sorted(b - a)[:60]}


class Atelier:
    """Cycle de vie de l'atelier, mené par un fil du worker toutes les ATELIER_TICK_S secondes (tick) : préparer, lancer,
    surveiller, relancer, arrêter, et dire au hub ce qu'il en est (describe, dans info.atelier)."""

    def __init__(self, base, config, app, gpu):
        self.base, self.config, self.app, self.gpu = base, config, app, gpu
        self.proc = None            # Popen si ce worker l'a lancé ; None si repris d'un worker précédent (pid seulement)
        self.pid = None
        self.port = None
        self.listen = None
        self.started_at = None
        self.state = 'éteint'
        self.error = None
        self.busy_flag = False
        self.queue = None           # (en cours, en attente)
        self.queue_errors = 0
        self.unresponsive_since = None
        self.hung_restarts = 0
        self.last_busy = time.time()
        self.freed = True
        self.next_try = 0.0
        self.failures = 0
        self.in_window = None       # donné par le hub (orders.in_window) ; None : inconnu
        self.ts = {'ip': None, 'error': None, 'at': 0.0}
        self.fw = {'ok': None, 'at': 0.0}
        self.net = {'listening': None, 'at': 0.0}
        self.vram = {}
        self.vram_at = 0.0
        self.log_at = None
        self.log_lines = []
        self.purge_at = 0.0
        self.files_gb = None
        self.looked_for_orphan = False
        self.manager = None
        self.env_note = None
        self.stopping = threading.Event()
        self.lock = threading.RLock()   # tick (fil de l'atelier) et free / shutdown (fil principal)
        self.env_lock = threading.Lock()   # environnement Python : préparation (clone, Manager) ou pip d'une tâche, jamais les deux
        self.tasks_seen = set()
        self.task_thread = None
        self.last_task = None
        self.restart_wanted = False     # nœuds ajoutés ou retirés : relance dès que l'atelier ne calcule plus

    # ---- réglages ----
    def spec(self):
        spec = comfy_spec(self.app)
        if not spec.get('atelier'):
            raise RuntimeError('atelier absent du catalogue publié')
        return spec

    def enabled(self):
        return self.config.get('atelier_enabled') is True

    def wanted(self):
        if not self.enabled() or self.stopping.is_set() or self.config.get('gpu') is False:
            return False
        if not IS_WINDOWS and not self.config.get('comfyui_any_os'):
            return False
        return not (self.config.get('atelier_window_only') is True and self.in_window is False)

    def idle_free_s(self):
        try:
            return max(0.0, float(self.config.get('atelier_idle_free_s', ATELIER_IDLE_FREE_S)))
        except (TypeError, ValueError):
            return float(ATELIER_IDLE_FREE_S)

    def purge(self, now):
        """Sorties (output) et images envoyées (input) de l'atelier : les agents en envoient beaucoup, le disque ne doit pas
        se remplir. Gardées atelier_keep_days jours et atelier_files_max_gb Go au plus."""
        self.purge_at = now
        try:
            days = max(0.0, float(self.config.get('atelier_keep_days', ATELIER_KEEP_DAYS)))
            cap = max(0.1, float(self.config.get('atelier_files_max_gb', ATELIER_FILES_MAX_GB))) * 1e9
        except (TypeError, ValueError):
            days, cap = ATELIER_KEEP_DAYS, ATELIER_FILES_MAX_GB * 1e9
        lay = atelier_layout(self.base, self.spec())
        data = lay['data']
        removed, freed, left = purge_files([data / 'output', data / 'input'], days, cap, now)
        trash = lay['root'] / 'trash'
        if trash.is_dir():   # corbeille des tâches : un dossier par jour (AAAAMMJJ)
            limit = time.strftime('%Y%m%d', time.localtime(now - ATELIER_TRASH_DAYS * 86400))
            for d in trash.iterdir():
                if d.is_dir() and re.fullmatch(r'\d{8}', d.name) and d.name < limit:
                    rmtree(d)
        self.files_gb = round(left / 1e9, 2)
        if removed:
            log.info('Atelier : ménage, %d fichiers retirés (%.1f Go), %.1f Go gardés.', removed, freed / 1e9, left / 1e9)

    def port_wanted(self, atelier):
        try:
            return int(self.config.get('atelier_port') or atelier.get('port') or ATELIER_PORT)
        except (TypeError, ValueError):
            return ATELIER_PORT

    def running(self):
        if self.proc is not None:
            return self.proc.poll() is None
        return bool(self.pid) and pid_alive(self.pid)   # repris d'un worker précédent : son identité a été vérifiée à la reprise

    # ---- réseau : Tailscale, pare-feu, écoute réelle ----
    def remote_ip(self, now):
        """Adresse d'écoute en plus de 127.0.0.1, ou None (alors écoute locale seulement, et la raison dans self.ts['error'])."""
        forced = self.config.get('atelier_listen_ip')
        if forced:
            ip = listen_ip_ok(forced)
            self.ts.update(ip=ip, error=None if ip else 'atelier_listen_ip refusée : %r' % forced, at=now)
        elif now - self.ts['at'] >= (ATELIER_TS_RECHECK_S if self.ts['ip'] else ATELIER_TS_RETRY_S):
            ip, why = tailscale_ip()
            if ip != self.ts['ip']:
                log.info('Atelier : adresse Tailscale %s.', ip or 'inconnue (%s)' % why)
            self.ts.update(ip=ip, error=why, at=now)
        if not self.ts['ip']:
            return None
        if self.config.get('atelier_require_firewall', True) is False:
            self.fw.update(ok=None, problem='vérification coupée (atelier_require_firewall)')
            return self.ts['ip']
        if now - self.fw['at'] >= (ATELIER_TS_RECHECK_S if self.fw.get('ok') else ATELIER_TS_RETRY_S):
            rules, why = read_firewall_rules()
            check = atelier_firewall_check(rules, atelier_layout(self.base, self.spec())['exe']) if rules is not None \
                else {'ok': False, 'allow_from': [], 'problem': why}
            if check['ok'] != self.fw.get('ok'):
                log.info('Atelier : pare-feu %s.', 'prêt (poste client %s)' % ', '.join(check['allow_from']) if check['ok']
                         else 'pas prêt : %s, écoute locale seulement' % check['problem'])
            self.fw = dict(check, at=now)
        return self.ts['ip'] if self.fw.get('ok') else None

    def look_net(self, now, force=False):
        if not IS_WINDOWS or not self.pid or (not force and now - self.net['at'] < ATELIER_NET_S):
            return
        try:
            code, out = quiet_run(['netstat', '-ano'], timeout=30)
        except (OSError, subprocess.SubprocessError) as e:
            self.net = {'listening': None, 'error': str(e)[:120], 'at': now}
            return
        rows = parse_netstat(out)
        mine = sorted({'%s:%d' % (h, p) for h, p, pid in rows if pid == self.pid})
        others = sorted({'%s:%d (pid %d)' % (h, p, pid) for h, p, pid in rows if p == self.port and pid != self.pid})
        wide = [a for a in mine if a.rpartition(':')[0] in ('0.0.0.0', '::') and a.rpartition(':')[2] == str(self.port)]
        self.net = {'listening': mine, 'port_taken_by': others or None, 'at': now}
        if wide:
            log.error('Atelier : écoute sur toutes les adresses (%s) : arrêté.', ', '.join(wide))
            self.stop('écoute sur toutes les adresses')
            self.error = 'écoute sur toutes les adresses (%s) : arrêté' % ', '.join(wide)
            self.next_try = now + 3600

    # ---- préparation : environnement cloné de celui des travaux, source, Manager ----
    def prepare(self, spec, lay):
        jobs = lay['jobs']
        if not all(comfy_done(jobs, spec, s) for s in ('python', 'pip', 'source', 'torch', 'requirements')):
            raise RuntimeError('ComfyUI des travaux pas encore installé ici (essai comfyui d\'abord) : l\'atelier en clone l\'environnement')
        root = lay['root']
        root.mkdir(parents=True, exist_ok=True)
        for d in ('data', 'logs'):
            lay[d].mkdir(parents=True, exist_ok=True)
        want = comfy_marker(spec, 'requirements')
        mark = root / '.ok-env'
        if not mark.exists():
            self.state = 'préparation : environnement Python'
            part = root / 'python.part'
            rmtree(part)
            rmtree(lay['python'])
            if not can_hardlink(root):
                need = folder_bytes(jobs['python'])
                free = shutil.disk_usage(str(root)).free
                if need + self.gpu.keep_free_bytes() > free:
                    raise RuntimeError('liens physiques impossibles et disque trop plein pour copier l\'environnement (%.1f Go, %.1f Go libres)'
                                       % (need / 1e9, free / 1e9))
            t0 = time.time()
            linked, copied = link_tree(jobs['python'], part)
            os.replace(part, lay['python'])
            mark.write_text(want)
            log.info('Atelier : environnement Python cloné de celui des travaux en %s (%d liens physiques, %d copies).',
                     fmt_duration(time.time() - t0), linked, copied)
        self.env_note = None if mark.read_text().strip() == want else \
            'environnement cloné d\'une version précédente du catalogue (gardé : supprimer atelier\\python pour le refaire)'
        if not (lay['src'] / 'main.py').exists():
            self.state = 'préparation : ComfyUI'
            archive = download(spec['source']['url'], jobs['downloads'] / ('comfyui-' + spec['source']['sha256'][:12] + '.zip'),
                               spec['source']['sha256'], 'ComfyUI (atelier)')
            part = root / 'src.part'
            rmtree(part)
            safe_extract(archive, part)
            if not (part / spec['source']['root'] / 'main.py').exists():
                raise RuntimeError('archive ComfyUI sans %s/main.py' % spec['source']['root'])
            rmtree(lay['src'])
            os.replace(part / spec['source']['root'], lay['src'])
            rmtree(part)
        if IS_WINDOWS or list(lay['python'].glob('python3*._pth')):
            write_pth(lay['python'], lay['src'])   # ._pth copié, jamais lié : celui des travaux ne bouge pas
        self.manager = self.install_manager(spec, lay)
        lay['extra'].write_text(atelier_extra_paths(jobs['data'] / 'models'), encoding='utf-8')

    def install_manager(self, spec, lay):
        """ComfyUI-Manager (paquet pip épinglé par ComfyUI : manager_requirements.txt). Un échec n'empêche pas l'atelier."""
        if self.config.get('atelier_manager') is False:
            return 'coupé (atelier_manager)'
        req = lay['src'] / 'manager_requirements.txt'
        if not req.exists():
            return 'absent de cette version de ComfyUI'
        want = hashlib.sha256(req.read_bytes()).hexdigest()[:16]
        mark = lay['root'] / '.ok-manager'
        if mark.exists() and mark.read_text().strip() == want:
            return True
        failed = lay['root'] / '.manager-failed'
        if failed.exists() and time.time() - failed.stat().st_mtime < 3600:
            return 'échec de l\'installation (nouvel essai dans l\'heure) : %s' % failed.read_text()[:160]
        self.state = 'préparation : ComfyUI-Manager'
        pins = [re.sub(r'\[[^\]]*\]', '', p) for p in spec['torch']['packages']]   # torch reste celui d'AMD
        (lay['root'] / 'constraints.txt').write_text('\n'.join(pins) + '\n')
        try:
            run_logged([lay['exe'], '-s', '-m', 'pip', 'install', '--no-warn-script-location', '-r', req, '-c', lay['root'] / 'constraints.txt'],
                       lay['logs'] / 'atelier-install.log', comfy_env(lay, spec['atelier']), 1800, self.stopping,
                       what='installation de ComfyUI-Manager')
        except (RuntimeError, OSError, JobLost) as e:
            failed.write_text(str(e)[:300])
            log.warning('Atelier : ComfyUI-Manager non installé (%s) ; l\'atelier démarre sans lui.', e)
            return 'échec de l\'installation : %s' % str(e)[:160]
        failed.unlink(missing_ok=True)
        mark.write_text(want)
        return True

    # ---- marche, arrêt ----
    def adopt(self, lay):
        """Atelier resté en marche pendant la mise à jour ou le redémarrage du worker : repris tel quel (le travail de Alice
        n'est pas coupé), seulement si ce numéro est bien le Python de l'atelier."""
        st = read_json(lay['state'], {}) or {}
        pid = st.get('pid')
        if not pid or not same_file(process_exe(pid), lay['exe']):
            lay['state'].unlink(missing_ok=True)
            return False
        self.proc, self.pid, self.port, self.listen = None, int(pid), int(st.get('port') or ATELIER_PORT), st.get('listen')
        self.started_at = st.get('started_at')
        log.info('Atelier repris en marche (pid %d, %s port %d).', self.pid, self.listen, self.port)
        return True

    def start(self, now):
        spec = self.spec()
        atelier = spec['atelier']
        lay = atelier_layout(self.base, spec)
        with self.env_lock:
            self.prepare(spec, lay)
        port = self.port_wanted(atelier)
        try:   # quelque chose répond déjà sur ce port (une connexion, pas un bind : nos requêtes passées laissent des TIME_WAIT)
            socket.create_connection(('127.0.0.1', port), timeout=2).close()
            raise RuntimeError('port %d déjà pris sur ce PC (un autre ComfyUI ?)' % port)
        except OSError:
            pass
        ip = self.remote_ip(now)
        listen = '127.0.0.1' + (',' + ip if ip else '')
        manager = self.manager is True
        args = [str(lay['exe']), '-s', str(lay['src'] / 'main.py')] + atelier_args(spec, atelier, port, listen, lay['data'], lay['extra'], manager)
        env = comfy_env(lay, atelier)
        cors = self.config.get('atelier_cors_origin')
        if cors:   # seulement pour une page web d'une autre origine ; ni l'interface de l'atelier ni curl n'en ont besoin
            if isinstance(cors, str) and re.fullmatch(r'https?://[A-Za-z0-9.-]+(:\d+)?', cors):
                args += ['--enable-cors-header', cors]
            else:
                log.warning('Atelier : atelier_cors_origin ignoré (une origine précise, http(s)://hôte[:port], jamais *) : %r', cors)
        if self.gpu.hip_device:
            env['HIP_VISIBLE_DEVICES'] = self.gpu.hip_device
        flags, kwargs = self.gpu.spawn_options()
        if IS_WINDOWS:
            flags |= subprocess.CREATE_NEW_PROCESS_GROUP
        logf = lay['logs'] / 'atelier.log'
        if logf.exists():
            os.replace(logf, lay['logs'] / 'atelier.previous.log')
        # Journal dans un fichier, pas dans un tube : l'atelier survit à un redémarrage du worker sans perdre sa sortie
        with open(logf, 'wb') as out:
            out.write(('# %s\n' % ' '.join(args[2:])).encode('utf-8', 'replace'))
            out.flush()
            self.proc = subprocess.Popen(args, cwd=str(lay['src']), stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                         env=env, creationflags=flags, **kwargs)
        self.pid, self.port, self.listen, self.started_at = self.proc.pid, port, listen, time.strftime('%Y-%m-%d %H:%M:%S')
        write_json(lay['state'], {'pid': self.pid, 'port': port, 'listen': listen, 'started_at': self.started_at})
        self.state = 'démarrage'
        log.info('Atelier ComfyUI lancé (pid %d) : %s port %d%s.', self.pid, listen, port, ', avec ComfyUI-Manager' if manager else '')
        deadline = time.time() + float(atelier.get('start_timeout_s') or 600)
        while True:
            if self.stopping.is_set():
                self.stop('arrêt du worker')
                return
            code = self.proc.poll()
            if code is not None:
                self.read_log(force=True)
                self.forget(lay)   # self.proc vaut None ensuite : le code est lu avant (boucle de relance du 14/11)
                said = [l for l in self.log_lines if not l.startswith('# ')]   # sans la ligne de commande écrite en tête
                raise RuntimeError('ComfyUI s\'est arrêté au démarrage (code %s) : %s' % (code, ' | '.join(said[-3:])[-230:]))
            if time.time() > deadline:
                self.stop('pas prêt à temps')
                raise RuntimeError('atelier pas prêt après %s' % fmt_duration(deadline - now))
            try:
                if comfy_local(port, 'GET', '/queue', timeout=5)[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(2)
        self.state = 'en marche'
        self.failures = 0
        if not (self.error or '').startswith('ne répondait plus'):   # la relance pour mutisme reste dite au hub
            self.error = None
        self.last_busy, self.freed = time.time(), False
        self.look_net(time.time(), force=True)
        self.purge(time.time())
        log.info('Atelier prêt en %s : %s.', fmt_duration(time.time() - now), ', '.join(self.net.get('listening') or [listen]))

    def forget(self, lay=None):
        self.proc, self.pid, self.busy_flag, self.queue, self.vram, self.listen = None, None, False, None, {}, None
        self.queue_errors, self.unresponsive_since = 0, None
        self.net = {'listening': None, 'at': 0.0}
        try:
            (lay or atelier_layout(self.base, self.spec()))['state'].unlink(missing_ok=True)
        except (RuntimeError, OSError):
            pass

    def stop(self, why):
        with self.lock:
            if self.proc is not None and self.proc.poll() is None:
                if IS_WINDOWS:   # avec ses enfants (un nœud additionnel peut lancer son propre processus)
                    try:
                        quiet_run(['taskkill', '/PID', str(self.proc.pid), '/T', '/F'], timeout=30)
                    except (OSError, subprocess.SubprocessError):
                        pass
                if self.proc.poll() is None:
                    self.proc.kill()
                try:
                    self.proc.wait(30)
                except subprocess.TimeoutExpired:
                    pass
            elif self.proc is None and self.pid:
                try:
                    lay = atelier_layout(self.base, self.spec())
                    if same_file(process_exe(self.pid), lay['exe']):
                        if IS_WINDOWS:
                            quiet_run(['taskkill', '/PID', str(self.pid), '/T', '/F'], timeout=30)
                        else:
                            os.kill(self.pid, 9)
                        deadline = time.time() + 15
                        while process_exe(self.pid) and time.time() < deadline:
                            time.sleep(0.2)
                except (OSError, RuntimeError, subprocess.SubprocessError):
                    pass
            if self.pid:
                log.info('Atelier ComfyUI arrêté (%s).', why)
            self.forget()
            self.state = 'éteint'

    def shutdown(self, why):
        self.stopping.set()
        self.stop(why)

    # ---- file, mémoire vidéo ----
    def poll(self):
        """File de l'atelier -> occupé. busy_flag ne vient que d'une file réellement lue. Trois lectures ratées de suite :
        douteux (doubtful) ; tick relance l'atelier s'il ne répond plus depuis atelier_hung_s."""
        try:
            code, q = comfy_local(self.port, 'GET', '/queue', timeout=5)
            if code != 200 or not isinstance(q, dict):
                raise OSError('HTTP %s' % code)
            self.queue = (len(q.get('queue_running') or []), len(q.get('queue_pending') or []))
            self.queue_errors = 0
            self.unresponsive_since = None
            self.busy_flag = sum(self.queue) > 0
        except (OSError, ValueError):
            self.queue_errors += 1
            if self.unresponsive_since is None:
                self.unresponsive_since = time.time()
        return self.busy()

    def doubtful(self):
        return self.queue_errors >= 3

    def busy(self, live=False, sure=False):
        """Sans verrou : le fil principal n'attend jamais un démarrage de l'atelier (installation, jusqu'à quelques minutes).
        sure=False (prendre un nouveau travail ?) : occupé, ou muet depuis trois lectures (au plus atelier_hung_s, puis
        relancé). sure=True (arrêter un travail en cours ?) : seulement une file réellement lue et non vide ; une réponse
        lente n'abandonne jamais un travail."""
        if not self.pid or self.state != 'en marche':
            return False
        if live:
            self.poll()
        if sure:
            return self.busy_flag and self.queue_errors == 0
        return self.busy_flag or self.doubtful()

    def hung_s(self):
        try:
            return max(1.0, float(self.config.get('atelier_hung_s', ATELIER_HUNG_S)))
        except (TypeError, ValueError):
            return float(ATELIER_HUNG_S)

    def read_log(self, force=False):
        """Fin du journal de ComfyUI (atelier\\logs\\atelier.log) pour l'état remonté au hub : 8 lignes, sans couleurs ni
        barres, valeurs d'allure secrète masquées. Relu seulement si le fichier a changé."""
        try:
            logf = atelier_layout(self.base, self.spec())['logs'] / 'atelier.log'
            mtime = logf.stat().st_mtime
        except (OSError, RuntimeError):
            return
        if not force and mtime == self.log_at:
            return
        self.log_at = mtime
        self.log_lines = [redact(l)[:200] for l in log_tail(logf, 8)]

    def read_vram(self):
        try:
            dev = (((comfy_local(self.port, 'GET', '/system_stats', timeout=10)[1] or {}).get('devices') or [{}])[0])
        except (OSError, ValueError):
            return self.vram
        mib = lambda v: int(v / 1048576) if isinstance(v, (int, float)) else None
        self.vram = {'free_mib': mib(dev.get('vram_free')), 'total_mib': mib(dev.get('vram_total')),
                     'atelier_mib': mib(dev.get('torch_vram_total'))}
        return self.vram

    def free(self, why, wait_s=COMFY_FREE_WAIT_S):
        """Carte rendue par l'atelier (POST /free : modèles déchargés, cache vidé), sans l'arrêter : Alice garde sa page et
        ses réglages. Attend que la mémoire gardée par son PyTorch retombe. -> Mio gardés après (None : inconnu)."""
        if not self.pid or self.state != 'en marche':
            return None
        try:
            comfy_local(self.port, 'POST', '/free', {'unload_models': True, 'free_memory': True}, timeout=10)
        except (OSError, ValueError) as e:
            log.warning('Atelier : POST /free a échoué (%s).', e)
            return None
        held, deadline = None, time.time() + wait_s
        while True:
            held = self.read_vram().get('atelier_mib')
            if held is None or held <= ATELIER_FREE_DONE_MIB or time.time() > deadline:
                break
            time.sleep(1)
        self.freed = True
        log.info('Atelier : carte rendue (%s)%s.', why, '' if held is None else ', %d Mio gardés par son PyTorch' % held)
        return held

    # ---- tâches données par le hub (fil à part : un téléchargement de 6 Go ne bloque pas la surveillance) ----
    def submit(self, task, post):
        """Tâche reçue dans les ordres du hub. post(route_body) -> réponse du hub ({cancel}). Une à la fois ; une tâche déjà
        vue n'est pas refaite (le hub la redonne tant qu'elle attend)."""
        tid = task.get('id') if isinstance(task, dict) else None
        if not isinstance(tid, int) or tid in self.tasks_seen or (self.task_thread and self.task_thread.is_alive()):
            return
        self.tasks_seen.add(tid)
        self.task_thread = threading.Thread(target=self.run_task, args=(task, post), name='atelier-task', daemon=True)
        self.task_thread.start()

    def run_task(self, task, post):
        tid, action = task['id'], str(task.get('action'))
        now = {'stage': 'préparation', 'progress': 0.0}
        stop, finished = threading.Event(), threading.Event()

        def send(body):
            try:
                answer = post(tid, body) or {}
                if answer.get('cancel'):
                    stop.set()
                return answer
            except OSError:
                return {}

        def beat():
            while not finished.wait(30):
                send({'status': 'running', 'stage': now['stage'], 'progress': now['progress']})
        answer = send({'status': 'running', 'stage': 'préparation', 'progress': 0})
        if answer.get('ok') is False or answer.get('cancel'):
            return
        threading.Thread(target=beat, daemon=True).start()
        progress = lambda frac, stage=None: now.update(progress=round(max(0.0, min(1.0, frac)), 3), **({'stage': str(stage)[:200]} if stage else {}))
        result = {'ok': False, 'action': action}
        t0 = time.time()
        try:
            params = check_atelier_task(action, task.get('params'))
            log.info('Atelier : tâche %d (%s) %s', tid, action, json.dumps(params, ensure_ascii=False))
            result.update(getattr(self, 'task_' + action)(tid, params, stop, progress))
            result['ok'] = True
        except (RuntimeError, OSError, ValueError, KeyError, JobLost, subprocess.SubprocessError) as e:
            result['error'] = ('annulée : %s' % e) if stop.is_set() else str(e)[:600]
            log.warning('Atelier : tâche %d (%s) ratée : %s', tid, action, result['error'])
        finally:
            finished.set()
        result['elapsed_s'] = round(time.time() - t0, 1)
        if result['ok']:
            log.info('Atelier : tâche %d (%s) faite : %s', tid, action, json.dumps(result, ensure_ascii=False)[:600])
        self.last_task = {'id': tid, 'action': action, 'ok': result['ok']}
        for _ in range(5):
            try:
                post(tid, {'status': 'done' if result['ok'] else 'failed', 'result': result})
                break
            except OSError:
                time.sleep(10)

    def task_layout(self, need_env=False):
        spec = self.spec()
        lay = atelier_layout(self.base, spec)
        if need_env and not ((lay['root'] / '.ok-env').exists() and lay['exe'].exists()):
            raise RuntimeError('environnement de l\'atelier pas encore préparé : l\'allumer une fois d\'abord (atelier_enabled)')
        for d in ('trash', 'journal'):
            (lay['root'] / d).mkdir(parents=True, exist_ok=True)
        return spec, lay

    def to_trash(self, lay, path, tid, tag):
        """Déplacé (jamais effacé) dans atelier\\trash : défaisable 30 jours. -> chemin dans la corbeille."""
        day = lay['root'] / 'trash' / time.strftime('%Y%m%d')   # un dossier par jour : purgé après ATELIER_TRASH_DAYS
        day.mkdir(parents=True, exist_ok=True)
        dest = day / ('%s.%s%d' % (Path(path).name, tag, tid))
        os.replace(path, dest)
        mark = Path(str(path) + '.ok')
        if mark.exists():
            os.replace(mark, Path(str(dest) + '.ok'))
        return dest

    @staticmethod
    def from_trash(src, dest):
        """Remis à sa place, avec son témoin .ok (fichier déjà vérifié : pas re-haché)."""
        os.replace(src, dest)
        if Path(str(src) + '.ok').exists():
            os.replace(str(src) + '.ok', str(dest) + '.ok')

    def write_task_journal(self, lay, tid, entry):
        write_json(lay['root'] / 'journal' / ('%d.json' % tid), dict(entry, at=time.strftime('%Y-%m-%d %H:%M:%S')))

    def task_install_nodes(self, tid, p, stop, progress):
        spec, lay = self.task_layout(need_env=p['pip'])
        nodes = lay['data'] / 'custom_nodes'
        nodes.mkdir(parents=True, exist_ok=True)
        dest = nodes / p['name']
        work = lay['tmp'] / ('pack-%d' % tid)
        rmtree(work)
        progress(0.05, 'téléchargement de %s au commit %s' % (p['url'], p['commit'][:12]))
        archive = work / 'pack.zip'
        digest = fetch_file('https://github.com/%s/%s/archive/%s.zip' % (p['owner'], p['repo'], p['commit']), archive, stop)
        safe_extract(archive, work / 'x')
        tops = [d for d in (work / 'x').iterdir() if d.is_dir()]
        if len(tops) != 1:
            raise RuntimeError('archive inattendue (%d dossiers à la racine)' % len(tops))
        top = tops[0]
        out = {'name': p['name'], 'path': str(dest), 'commit': p['commit'], 'archive_sha256': digest,
               'install_py': 'présent, non exécuté (à lire avant de le lancer à la main)' if (top / 'install.py').exists() else None}
        write_json(top / '.atelier-pack.json', {'url': p['url'], 'commit': p['commit'], 'archive_sha256': digest, 'task': tid,
                                                'installed_at': time.strftime('%Y-%m-%d %H:%M:%S')})
        displaced = self.to_trash(lay, dest, tid, 'remplace') if dest.exists() else None
        os.replace(top, dest)
        rmtree(work)
        entry = {'action': 'install_nodes', 'installed': str(dest), 'displaced': str(displaced) if displaced else None, 'params': p}
        self.write_task_journal(lay, tid, entry)
        req = dest / 'requirements.txt'
        if p['pip'] and req.exists():
            progress(0.4, 'dépendances pip de %s' % p['name'])
            env = comfy_env(lay, spec['atelier'])
            tlog = lay['logs'] / ('task-%d.log' % tid)
            pins = [re.sub(r'\[[^\]]*\]', '', x) for x in spec['torch']['packages']]
            (lay['root'] / 'constraints.txt').write_text('\n'.join(pins) + '\n')   # torch reste celui d'AMD
            with self.env_lock:
                before = pip_freeze(lay['exe'], env, tlog, stop)
                (lay['root'] / 'journal' / ('%d.pip-before.txt' % tid)).write_text('\n'.join(before) + '\n')
                try:
                    run_logged([lay['exe'], '-s', '-m', 'pip', 'install', '--no-warn-script-location', '-r', req, '-c', lay['root'] / 'constraints.txt'],
                               tlog, env, 3600, stop, what='dépendances de %s' % p['name'])
                except (RuntimeError, JobLost) as e:
                    after = pip_freeze(lay['exe'], env, tlog)
                    self.to_trash(lay, dest, tid, 'rate')   # pas de pack à moitié installé au prochain démarrage
                    if displaced:
                        self.from_trash(displaced, dest)
                    entry.update(installed=None, displaced=None, failed=str(e)[:300], pip=pip_changes(before, after))
                    self.write_task_journal(lay, tid, entry)
                    raise RuntimeError('%s ; pack retiré, changements pip : %s' % (e, json.dumps(entry['pip'], ensure_ascii=False)[:300]))
                after = pip_freeze(lay['exe'], env, tlog, stop)
            (lay['root'] / 'journal' / ('%d.pip-after.txt' % tid)).write_text('\n'.join(after) + '\n')
            out['pip'] = entry['pip'] = pip_changes(before, after)
            self.write_task_journal(lay, tid, entry)
        elif req.exists():
            out['pip'] = 'requirements.txt présent, non installé (pip: false)'
        out['replaced'] = str(displaced) if displaced else None
        self.restart_wanted = True
        out['restart'] = 'atelier relancé dès qu\'il ne calcule plus' if self.pid else 'chargé au prochain démarrage'
        return {k: v for k, v in out.items() if v is not None}

    def task_remove_nodes(self, tid, p, stop, progress):
        spec, lay = self.task_layout()
        dest = lay['data'] / 'custom_nodes' / p['name']
        if not dest.exists():
            raise RuntimeError('pas de pack %s dans custom_nodes' % p['name'])
        trash = self.to_trash(lay, dest, tid, 'retire')
        self.write_task_journal(lay, tid, {'action': 'remove_nodes', 'installed': None, 'displaced': str(trash), 'restore_to': str(dest)})
        self.restart_wanted = True
        return {'name': p['name'], 'trash': str(trash), 'note': 'paquets pip gardés (communs à d\'autres packs)'}

    def task_download_model(self, tid, p, stop, progress):
        spec, lay = self.task_layout()
        folder = lay['data'] / 'models' / Path(*p['folder'].split('/'))
        dest = folder / p['name']
        size = p['size'] or remote_size(p['url'])
        if not size:
            raise RuntimeError('taille inconnue (pas de Content-Length) : donner size en octets')
        free = shutil.disk_usage(str(lay['root'])).free
        if size + self.gpu.keep_free_bytes() > free:
            raise RuntimeError('disque : %.1f Go à poser, %.1f Go libres, %.0f Go à laisser libres' % (size / 1e9, free / 1e9, self.gpu.keep_free_bytes() / 1e9))
        displaced = None
        if dest.exists():
            st = dest.stat()
            if st.st_size == size and sha256_file(dest) == p['sha256']:
                return {'path': str(dest), 'sha256': p['sha256'], 'size': size, 'note': 'déjà présent, identique'}
            displaced = self.to_trash(lay, dest, tid, 'remplace')
        progress(0.01, 'téléchargement de %s (%.2f Go)' % (p['name'], size / 1e9))
        try:
            # Deux essais : une empreinte fausse au bout de 6 Go ne se corrige pas en retéléchargeant huit fois
            download_resume(p['url'], dest, p['sha256'], size, '%s (atelier)' % p['name'], stop,
                            lambda frac: progress(0.01 + 0.98 * frac, 'téléchargement de %s : %d %%' % (p['name'], 100 * frac)), tries=2)
        except BaseException:
            if displaced and not dest.exists():
                self.from_trash(displaced, dest)
            raise
        self.write_task_journal(lay, tid, {'action': 'download_model', 'installed': str(dest), 'displaced': str(displaced) if displaced else None, 'params': p})
        out = {'path': str(dest), 'sha256': p['sha256'], 'size': size}
        if displaced:
            out['replaced'] = str(displaced)
        return out

    def task_remove_model(self, tid, p, stop, progress):
        spec, lay = self.task_layout()
        dest = lay['data'] / 'models' / Path(*p['folder'].split('/')) / p['name']
        if not dest.exists():
            raise RuntimeError('pas de fichier %s/%s dans les modèles de l\'atelier' % (p['folder'], p['name']))
        trash = self.to_trash(lay, dest, tid, 'retire')
        self.write_task_journal(lay, tid, {'action': 'remove_model', 'installed': None, 'displaced': str(trash), 'restore_to': str(dest)})
        return {'trash': str(trash)}

    def task_undo(self, tid, p, stop, progress):
        """Défait une tâche : ce qu'elle a posé part à la corbeille, ce qu'elle avait remplacé ou retiré revient. Les paquets
        pip ne sont pas défaits (l'état avant est dans journal\\<n>.pip-before.txt)."""
        spec, lay = self.task_layout()
        j = read_json(lay['root'] / 'journal' / ('%d.json' % p['task']))
        if not j:
            raise RuntimeError('tâche %d inconnue de cet atelier (pas de journal)' % p['task'])
        if j.get('undone'):
            raise RuntimeError('tâche %d déjà défaite (tâche %s)' % (p['task'], j['undone']))
        installed, displaced = j.get('installed'), j.get('displaced')
        back_to = j.get('restore_to') or installed
        out = {'task': p['task'], 'action': j.get('action')}
        if displaced and not Path(displaced).exists():
            raise RuntimeError('ce que la tâche %d avait déplacé n\'est plus dans la corbeille (plus de %d jours ?)' % (p['task'], ATELIER_TRASH_DAYS))
        if installed and Path(installed).exists():
            out['trash'] = str(self.to_trash(lay, Path(installed), tid, 'defait'))
        if displaced:
            if Path(back_to).exists():
                raise RuntimeError('%s existe déjà : rien remis à sa place' % back_to)
            self.from_trash(displaced, back_to)
            out['restored'] = back_to
        j['undone'] = tid
        write_json(lay['root'] / 'journal' / ('%d.json' % p['task']), j)
        self.write_task_journal(lay, tid, {'action': 'undo', 'of': p['task'], 'installed': None, 'displaced': None})
        if j.get('action') in ('install_nodes', 'remove_nodes'):
            self.restart_wanted = True
            if j.get('pip'):
                out['pip_not_undone'] = j['pip']
        return out

    # ---- boucle ----
    def tick(self, now=None):
        now = time.time() if now is None else now
        with self.lock:
            if not self.looked_for_orphan:   # resté en marche pendant un redémarrage du worker : repris (ou arrêté s'il est éteint)
                self.looked_for_orphan = True
                try:
                    lay = atelier_layout(self.base, self.spec())
                    if lay['state'].exists() and self.adopt(lay):
                        self.state = 'en marche'
                        self.freed = False
                except RuntimeError:
                    pass
            if not self.wanted():
                if self.pid:
                    self.stop('éteint depuis le hub' if not self.enabled() else 'hors du créneau (atelier_window_only)')
                self.state = 'éteint'
                self.error = None if not self.enabled() else self.error
                return
            if not self.pid:
                if now < self.next_try:
                    return
                try:
                    self.start(now)
                except Exception as e:   # toute panne du démarrage : pause croissante, jamais une relance immédiate en boucle
                    if self.pid and not self.running():
                        self.forget()
                    self.failures += 1
                    pause = min(1800, 30 * 2 ** (self.failures - 1))
                    self.next_try = now + pause
                    self.error = str(e)[:300]
                    self.state = 'en échec'
                    log.warning('Atelier : %s (nouvel essai dans %s).', e, fmt_duration(pause))
                return
            if not self.running():
                code = self.proc.returncode if self.proc is not None else '?'
                self.read_log(force=True)
                self.forget()
                self.error = 'arrêté de lui-même (code %s)' % code
                self.state = 'en échec'
                self.failures += 1
                self.next_try = now + min(1800, 30 * 2 ** (self.failures - 1))
                log.warning('Atelier ComfyUI arrêté de lui-même (code %s) : relance dans %s.', code, fmt_duration(self.next_try - now))
                return
            busy = self.poll()
            if self.doubtful() and now - self.unresponsive_since >= self.hung_s():
                # Vivant mais muet : jamais compté occupé sans fin (les files du hub resteraient gelées), relancé et dit au hub
                self.hung_restarts += 1
                why = 'ne répondait plus à /queue depuis %s : relancé (%d fois depuis le démarrage du worker)' % (
                    fmt_duration(now - self.unresponsive_since), self.hung_restarts)
                log.error('Atelier : %s.', why)
                self.stop('ne répond plus')
                self.error = why
                self.next_try = 0.0
                return
            if self.restart_wanted and not busy:
                self.restart_wanted = False
                self.stop('nœuds ajoutés ou retirés : relance')
                self.next_try = 0.0
                return
            if self.busy_flag:
                self.last_busy, self.freed = now, False
            elif not self.freed and self.idle_free_s() > 0 and now - self.last_busy >= self.idle_free_s():
                self.free('%s sans calcul' % fmt_duration(self.idle_free_s()), wait_s=0)
            self.look_net(now)
            if now - self.purge_at >= ATELIER_PURGE_S:
                self.purge(now)
            if now - self.vram_at >= 30:
                self.vram_at = now
                self.read_vram()
                self.read_log()
            # Tailscale prêt après coup, adresse changée, pare-feu posé ou retiré : relance (seulement sans calcul en cours)
            ip = self.remote_ip(now)
            want = '127.0.0.1' + (',' + ip if ip else '')
            if want != self.listen and not busy:
                self.stop('adresse d\'écoute à changer : %s -> %s' % (self.listen, want))
                self.next_try = 0.0

    def describe(self):
        d = {'enabled': self.enabled(), 'state': self.state, 'pid': self.pid, 'port': self.port, 'listen': self.listen,
             'listening': self.net.get('listening'), 'tailscale_ip': self.ts.get('ip'),
             'firewall': None if not (self.enabled() or self.pid) else 'prêt' if self.fw.get('ok') else (
                 self.fw.get('problem') or ('à vérifier' if self.fw.get('ok') is None else 'pas prêt')),
             'allowed_from': ','.join(self.fw.get('allow_from') or []) or None,
             'busy': self.busy_flag if self.pid else None, 'queue': '%d+%d' % self.queue if self.queue else None,
             'unresponsive_s': int(time.time() - self.unresponsive_since) if self.pid and self.doubtful() else None,
             'vram_free_mib': self.vram.get('free_mib'), 'vram_total_mib': self.vram.get('total_mib'),
             'vram_atelier_mib': self.vram.get('atelier_mib'), 'freed': self.freed if self.pid else None,
             'manager': self.manager if self.manager is not None else None, 'started_at': self.started_at, 'files_gb': self.files_gb,
             'error': self.error or (self.ts.get('error') if self.pid and not self.ts.get('ip') else None), 'note': self.env_note,
             'task': ('%(id)d %(action)s %(ok)s' % dict(self.last_task, ok='ok' if self.last_task['ok'] else 'raté')) if self.last_task else None,
             'tasks': ','.join(ATELIER_TASK_ACTIONS),
             'log': list(self.log_lines) or None}   # fin du journal de ComfyUI : pourquoi il ne démarre pas, vu du hub   # ce que cette version sait faire : le hub ne donne de tâche qu'à elle
        if self.net.get('port_taken_by'):
            d['port_taken_by'] = ', '.join(self.net['port_taken_by'])
        return {k: v for k, v in d.items() if v is not None}


GPU_TEST_KINDS = ('image', '3d', 'comfyui', 'comfyui_remove')
GPU_TEST_OBJECT = 'gpu-test-object.png'   # entrée de l'essai 3D demandé par le hub (512x512, fond blanc)
# Réglages que le hub peut poser sur cette machine (POST /api/reuse/workers/:nom/settings), avec leurs types. Aucun autre.
REMOTE_SETTINGS = {'enable_3d': (bool,), 'gpu_max_gb': (int, float), 'gpu_keep_loaded_s': (int, float),
                   'atelier_enabled': (bool,), 'atelier_window_only': (bool,), 'atelier_idle_free_s': (int, float),
                   'atelier_keep_days': (int, float), 'atelier_files_max_gb': (int, float)}
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
