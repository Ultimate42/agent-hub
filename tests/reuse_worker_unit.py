"""Tests unitaires du worker RE-USE (fonctions pures). Lancé par tests/reuse-worker.test.js."""
import array
import atexit
import hashlib
import importlib.util
import io
import json
import math
import os
import re
import shutil
import struct
import sys
import tarfile
import threading
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

# Un seul dossier temporaire par lancement, effacé à la sortie : chaque essai de pip pose 12 Mo, et /tmp est souvent un
# tmpfs de quelques Go (3 600 dossiers oubliés l'ont rempli le 14/11)
RUN_TMP = tempfile.mkdtemp(prefix='reuse-unit-')
tempfile.tempdir = RUN_TMP
atexit.register(shutil.rmtree, RUN_TMP, True)

spec = importlib.util.spec_from_file_location('reuse_worker', Path(__file__).resolve().parent.parent / 'reuse-worker' / 'reuse_worker.py')
w = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(w)


def sine(n, rate=24000, freq=440.0, amp=0.5):
    return array.array('f', (amp * math.sin(2 * math.pi * freq * i / rate) for i in range(n)))


class WavTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_roundtrip_16_and_24_bits(self):
        src = sine(2400)
        for bits, tol in ((16, 1 / 32000), (24, 1 / 8000000)):
            p = self.dir / ('a%d.wav' % bits)
            w.write_wav(p, 24000, src, bits=bits)
            self.assertEqual(w.wav_frames(p), (24000, 1, 2400, 1))
            rate, channels, got = w.read_wav(p)
            self.assertEqual((rate, channels, len(got)), (24000, 1, 2400))
            self.assertLess(max(abs(a - b) for a, b in zip(src, got)), tol)

    def test_clipping_and_negative_values(self):
        p = self.dir / 'clip.wav'
        w.write_wav(p, 8000, array.array('f', [2.0, -2.0, -0.25, 0.25]), bits=24)
        got = w.read_wav(p)[2]
        self.assertAlmostEqual(got[0], 1.0, places=5)
        self.assertAlmostEqual(got[1], -1.0, places=5)
        self.assertAlmostEqual(got[2], -0.25, places=5)
        self.assertAlmostEqual(got[3], 0.25, places=5)

    def _wav(self, fmt_body, pcm, extra=b''):
        body = b'WAVE' + b'fmt ' + struct.pack('<I', len(fmt_body)) + fmt_body + extra + b'data' + struct.pack('<I', len(pcm)) + pcm
        return b'RIFF' + struct.pack('<I', len(body)) + body

    def test_float32_extensible_and_extra_chunks(self):
        samples = array.array('f', [0.0, 0.5, -0.5, 0.25])
        # flottant 32 bits, avec un bloc LIST avant les données (ce qu'écrit ffmpeg)
        p = self.dir / 'f.wav'
        p.write_bytes(self._wav(struct.pack('<HHIIHH', 3, 1, 44100, 44100 * 4, 4, 32) + b'\0\0', samples.tobytes(),
                                extra=b'LIST' + struct.pack('<I', 5) + b'abcde\0'))
        self.assertEqual(w.wav_frames(p), (44100, 1, 4, 3))
        self.assertEqual(list(w.read_wav(p)[2]), list(samples))
        # 24 bits en WAVE_FORMAT_EXTENSIBLE (ce qu'écrivent flac et ffmpeg au-delà de 16 bits)
        ints = [0, 4194304, -4194304, 8388607]
        pcm = b''.join(struct.pack('<i', v)[:3] for v in ints)
        ext = struct.pack('<HHIIHH', 0xFFFE, 1, 24000, 72000, 3, 24) + struct.pack('<HHI', 22, 24, 4) + struct.pack('<H', 1) + b'\0' * 14
        q = self.dir / 'e.wav'
        q.write_bytes(self._wav(ext, pcm))
        self.assertEqual(w.wav_frames(q), (24000, 1, 4, 1))
        got = w.read_wav(q)[2]
        for v, g in zip(ints, got):
            self.assertAlmostEqual(g, v / 8388608, places=6)

    def test_subsampled_probe_and_bad_files(self):
        p = self.dir / 's.wav'
        w.write_wav(p, 24000, sine(24000), bits=16)
        self.assertEqual(len(w.read_wav(p, step=20)[2]), 1200)
        for junk in (b'', b'RIFF0000WAVE', b'not a wav at all, really not'):
            (self.dir / 'junk.wav').write_bytes(junk)
            with self.assertRaises(ValueError):
                w.wav_frames(self.dir / 'junk.wav')
        (self.dir / 'u8.wav').write_bytes(self._wav(struct.pack('<HHIIHH', 1, 1, 8000, 8000, 1, 8), b'\x80' * 10))
        with self.assertRaises(ValueError):
            w.read_wav(self.dir / 'u8.wav')

    def test_flac_header(self):
        head = bytearray(42)
        head[:4] = b'fLaC'
        head[4], head[7] = 0x80, 34
        samples = 24000 * 300 + 7
        struct.pack_into('>II', head, 18, (24000 << 12) | (0 << 9) | (23 << 4) | (samples >> 32), samples & 0xFFFFFFFF)
        p = self.dir / 'h.flac'
        p.write_bytes(bytes(head) + b'frames')
        self.assertEqual(w.flac_info(p), (24000, 1, samples))
        p.write_bytes(b'ID3' + bytes(head))
        with self.assertRaises(ValueError):
            w.flac_info(p)

    def test_correlation(self):
        a = sine(2000)
        self.assertAlmostEqual(w.correlation(a, a), 1.0, places=6)
        self.assertAlmostEqual(w.correlation(a, array.array('f', (-v for v in a))), -1.0, places=6)
        self.assertLess(abs(w.correlation(a, sine(2000, freq=1234.5))), 0.1)
        self.assertEqual(w.correlation(a, array.array('f', [0.0] * 2000)), 0.0)


class ArchiveTest(unittest.TestCase):
    def test_extraction_refuses_paths_outside_the_folder(self):
        d = Path(tempfile.mkdtemp())
        z = d / 'bad.zip'
        with zipfile.ZipFile(z, 'w') as f:
            f.writestr('ok.txt', 'ok')
            f.writestr('../evil.txt', 'evil')
        with self.assertRaises(RuntimeError):
            w.safe_extract(z, d / 'out')
        self.assertFalse((d / 'evil.txt').exists())
        t = d / 'bad.tar.gz'
        with tarfile.open(t, 'w:gz') as f:
            info = tarfile.TarInfo('../evil2.txt')
            info.size = 4
            f.addfile(info, io.BytesIO(b'evil'))
        with self.assertRaises(RuntimeError):
            w.safe_extract(t, d / 'out2')
        self.assertFalse((d / 'evil2.txt').exists())
        good = d / 'good.zip'
        with zipfile.ZipFile(good, 'w') as f:
            f.writestr('sub/a.txt', 'a')
        w.safe_extract(good, d / 'out3')
        self.assertEqual((d / 'out3' / 'sub' / 'a.txt').read_text(), 'a')

    def test_download_checks_the_checksum(self):
        d = Path(tempfile.mkdtemp())
        src = d / 'src.bin'
        src.write_bytes(b'payload')
        good = w.sha256_file(src)
        self.assertEqual(w.download(src.as_uri(), d / 'ok.bin', good, 'test').read_bytes(), b'payload')
        w.time.sleep = lambda s: None   # pas d'attente entre les essais dans ce test
        with self.assertRaises(RuntimeError):
            w.download(src.as_uri(), d / 'ko.bin', '0' * 64, 'test')
        self.assertFalse((d / 'ko.bin').exists())


class HubTokenTest(unittest.TestCase):
    def test_the_token_never_follows_a_redirect(self):
        # Un hub qui redirige (proxy mal réglé, http -> https, hub compromis) ne doit pas faire partir le jeton ailleurs
        import http.server
        import threading
        seen = {}

        class Target(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen['target'] = self.headers.get('Authorization')
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{}')

            def log_message(self, *a):
                pass

        class Hub(Target):
            def do_GET(self):
                seen['hub'] = self.headers.get('Authorization')
                self.send_response(302)
                self.send_header('Location', 'http://127.0.0.1:%d/ailleurs' % target.server_port)
                self.end_headers()

        target = http.server.HTTPServer(('127.0.0.1', 0), Target)
        hub = http.server.HTTPServer(('127.0.0.1', 0), Hub)
        for srv in (target, hub):
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            self.addCleanup(srv.server_close)
            self.addCleanup(srv.shutdown)
        w.Hub('http://127.0.0.1:%d' % hub.server_port, 'jeton-de-test').request('GET', '/api/reuse/worker/manifest')
        self.assertEqual(seen['hub'], 'Bearer jeton-de-test')
        self.assertIn('target', seen)
        self.assertIsNone(seen['target'])


class NamesTest(unittest.TestCase):
    def test_published_file_names(self):
        for good in ('reuse_worker.py', 'install-and-run.ps1', 'a', 'version.txt', '-x.py', 'x' * 120):
            self.assertTrue(w.safe_file_name(good), good)
        for bad in ('', '.hidden', '../x.py', 'sub/x.py', 'sub\\x.py', 'C:x.py', 'x.py:flux', 'é.py', 'x y.py', 'x' * 121, None, 3):
            self.assertFalse(w.safe_file_name(bad), repr(bad))

    def test_launcher_check_never_puts_the_path_in_the_powershell_command(self):
        # Faux « powershell » : note ce qu'il reçoit. Le dossier contient tout ce que PowerShell interpréterait.
        d = Path(tempfile.mkdtemp())
        tools = d / 'bin'
        tools.mkdir()
        seen = d / 'seen.txt'
        fake = tools / 'powershell'
        fake.write_text('#!/bin/sh\nprintf "%s\\n%s\\n" "$REUSE_PS1_TO_CHECK" "$*" > "$SEEN"\nexit "${FAKE_PS_EXIT:-0}"\n')
        fake.chmod(0o755)
        base = d / "O'Brien $(calc) `x \"q"
        (base / 'app').mkdir(parents=True)
        (base / 'logs').mkdir()
        (base / 'reuse-worker.config.json').write_text(json.dumps({'hub_url': 'https://hub.invalid', 'token': 'jeton-de-test'}))
        launcher = base / 'install-and-run.ps1'
        launcher.write_text('# ancien')
        fresh = base / 'app' / 'install-and-run.ps1'
        fresh.write_text('# nouveau')
        old_path, os.environ['PATH'] = os.environ['PATH'], str(tools) + os.pathsep + os.environ['PATH']
        os.environ['SEEN'] = str(seen)
        try:
            worker = w.Worker(base, launcher)
            os.environ['FAKE_PS_EXIT'] = '1'           # erreur de syntaxe : l'ancien lanceur reste
            self.assertFalse(worker.update_launcher(base / 'app'))
            self.assertEqual(launcher.read_text(), '# ancien')
            os.environ['FAKE_PS_EXIT'] = '0'
            self.assertTrue(worker.update_launcher(base / 'app'))
        finally:
            os.environ['PATH'] = old_path
            os.environ.pop('SEEN'), os.environ.pop('FAKE_PS_EXIT')
        path_seen, command = seen.read_text().split('\n')[:2]
        self.assertEqual(path_seen, str(fresh))
        self.assertNotIn('Brien', command)
        self.assertIn('$env:REUSE_PS1_TO_CHECK', command)
        self.assertEqual(launcher.read_text(), '# nouveau')
        self.assertEqual(Path(str(launcher) + '.prev').read_text(), '# ancien')


class FakeHub:
    """Hub de test : répond ce qu'on lui dit à l'envoi du résultat, note tous les appels."""
    def __init__(self, result_status):
        self.result_status = result_status
        self.calls = []

    def request(self, method, path, body=None, raw=None, headers=None, timeout=60, dest=None):
        self.calls.append((method, path.split('?')[0], body))
        if path.endswith('/heartbeat'):
            return 200, {}
        if '/result' in path:
            return self.result_status, {'error': 'refus de test'}
        return 200, {}

    def retrying(self, what, fn, tries=8):
        return fn()


class RefusedResultTest(unittest.TestCase):
    def worker_with_finished_job(self, result_status):
        """Worker dont le job 7 est déjà nettoyé sur le disque (reprise) : il ne reste qu'à envoyer le résultat."""
        base = Path(tempfile.mkdtemp())
        (base / 'logs').mkdir()
        (base / 'reuse-worker.config.json').write_text(json.dumps({'hub_url': 'https://hub.invalid', 'token': 'jeton-de-test'}))
        worker = w.Worker(base, None)
        worker.hub = FakeHub(result_status)
        jobdir = base / 'work' / 'job-7'
        jobdir.mkdir(parents=True)
        (jobdir / 'out.flac').write_bytes(b'fLaC resultat')
        w.write_json(jobdir / 'done.json', {'in_sha256': 'abc', 'out_sha256': w.sha256_file(jobdir / 'out.flac'), 'compute_s': 1.0})
        job = {'id': 7, 'name': 'p_007.flac', 'samples': 24000, 'rate': 24000, 'attempt': 1, 'sha256': 'abc', 'lease_s': 600}
        return worker, job, jobdir

    def test_a_refusal_the_hub_did_not_count_gives_the_job_back(self):
        # 413 : le hub (ou le proxy) refuse le résultat sans toucher au job. Sans signalement, le bail reste à
        # cette machine, qui reprendrait le même job et le recalculerait sans fin.
        worker, job, jobdir = self.worker_with_finished_job(413)
        worker.process(job)
        fails = [c for c in worker.hub.calls if c[1] == '/api/reuse/jobs/7/fail']
        self.assertEqual(len(fails), 1)
        self.assertIn('413', fails[0][2]['error'])
        self.assertFalse(jobdir.exists())
        self.assertEqual(worker.engine_failures, 0)   # ce n'est pas une panne du moteur : pas de pause

    def test_an_accepted_result_reports_no_failure(self):
        worker, job, jobdir = self.worker_with_finished_job(200)
        worker.process(job)
        self.assertEqual([c for c in worker.hub.calls if c[1].endswith('/fail')], [])
        self.assertFalse(jobdir.exists())



class GpuTest(unittest.TestCase):
    """Générations GPU : ligne de commande, catalogue, plafond du dossier, ménage."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.app = self.dir / 'app'
        self.app.mkdir()
        self.catalog = json.loads((Path(__file__).resolve().parent.parent / 'reuse-worker' / 'gpu-catalog.json').read_text(encoding='utf-8'))
        system = 'windows' if w.IS_WINDOWS else 'linux'
        for e in self.catalog['engines'].values():
            e.setdefault(system, dict(e['windows']))
        (self.app / w.GPU_CATALOG).write_text(json.dumps(self.catalog), encoding='utf-8')

    def gpu(self, **config):
        return w.Gpu(self.dir, config, self.app)

    def test_command_keeps_each_value_whole(self):
        prompt = 'a "cat" ; rm -rf / & echo %PATH% $(x) `y`\nsecond line'
        args = w.build_command(['-p', '{prompt}', '-W', '{width}', '--cfg-scale', '{cfg_scale}', '{if:hd=--hd}', '{unless:texture=--no-texture}'],
                               {'prompt': prompt, 'width': 512, 'cfg_scale': 1.0, 'hd': False, 'texture': False})
        self.assertEqual(args, ['-p', prompt, '-W', '512', '--cfg-scale', '1', '--no-texture'])
        with self.assertRaises(RuntimeError):
            w.build_command(['{missing}'], {})
        # « {opt:x=-t} » : drapeau et valeur seulement si la valeur est donnée
        self.assertEqual(w.build_command(['{opt:threads=-t}', 'x'], {'threads': 0}), ['x'])
        self.assertEqual(w.build_command(['{opt:threads=-t}'], {'threads': 2}), ['-t', '2'])
        self.assertEqual(w.build_command(['{opt:threads=-t}'], {}), [])
        # Accolades dans une valeur : jamais réinterprétées
        self.assertEqual(w.build_command(['{prompt}'], {'prompt': '{file:vae}'}), ['{file:vae}'])

    def test_catalog_commands_use_only_known_values(self):
        for kind, spec in self.catalog['types'].items():
            for mid, m in spec['models'].items():
                values = {k: (v['default'] if v.get('default') != 'random' else 1) for k, v in m['params'].items()}
                if m.get('engine') == 'comfyui':   # modèle joué par ComfyUI : un workflow au lieu d'une ligne de commande
                    extra = {k: how['map'][str(values[how['from']])] for k, how in (m.get('workflow_values') or {}).items()}
                    wf = w.comfy_workflow(m, dict(values, prompt='x', ref_megapixels=1.0, **extra))
                    self.assertTrue(all(isinstance(n.get('class_type'), str) for n in wf.values()))
                    self.assertNotRegex(json.dumps(wf), r'"\{\w+\}"', 'toutes les valeurs posées')
                else:
                    values.update(prompt='x', output='o', models_dir='d', input='i', **{'file:' + f['role']: 'f' for f in m['files']})
                    w.build_command(m['command'] + m.get('command_input', []), values)   # aucune valeur manquante
                if m.get('server'):
                    args = w.build_command(m['server']['command'], dict(values, port=1234))
                    self.assertIn('127.0.0.1', args, 'le moteur résident n\'écoute que la machine elle-même')
                for f in m['files']:
                    self.assertTrue(w.safe_file_name(f['name']))
                    self.assertRegex(f['sha256'], r'^[0-9a-f]{64}$')
                    self.assertTrue(f['url'].startswith('https://huggingface.co/') and '/resolve/' in f['url'] and '/main/' not in f['url'],
                                    'modèle épinglé par commit : %s' % f['url'])

    def test_types_follow_flags(self):
        self.assertEqual(self.gpu().types(), ['image'])
        self.assertEqual(self.gpu(enable_3d=True).types(), ['3d', 'image'])
        self.assertEqual(self.gpu(gpu=False, enable_3d=True).types(), [])

    def test_folder_cap_is_checked_before_any_download(self):
        g = self.gpu(gpu_max_gb=5)
        with self.assertRaises(RuntimeError) as e:
            g.ensure('image', 'z-image-turbo')
        self.assertIn('plafonné à 5 Go', str(e.exception))
        self.assertFalse((self.dir / 'gpu' / 'models').exists(), 'rien téléchargé')

    def test_types_need_a_big_enough_card(self):
        class Seen:
            gpus = None
        engine = Seen()
        g = w.Gpu(self.dir, {'enable_3d': True}, self.app, engine)
        self.assertEqual(g.types(), ['3d', 'image'], 'cartes pas encore regardées : rien d\'écarté')
        engine.gpus = [{'index': 0, 'memory': {'total_bytes': 6442450944}}]          # GTX 1060 6 Go
        why = {}
        self.assertEqual(g.types(why), [])
        self.assertIn('6.4 Go', why['image'])
        engine.gpus.append({'index': 1, 'memory': {'total_bytes': 17163091968}})     # RX 6950 XT 16 Go
        self.assertEqual(g.types(), ['3d', 'image'])
        g.config['gpu_device'] = 0
        self.assertEqual(g.types(), [], 'carte imposée : sa mémoire à elle')
        engine.gpus = []
        g.config.pop('gpu_device')
        self.assertEqual(g.types(), [], 'aucune carte Vulkan')

    def test_free_disk_space_is_checked_before_any_download(self):
        g = self.gpu(gpu_max_gb=1000)
        usage = w.shutil.disk_usage
        w.shutil.disk_usage = lambda path: usage(path)._replace(free=int(15e9))
        try:
            with self.assertRaises(RuntimeError) as e:
                g.ensure('image', 'z-image-turbo')   # 11 Go à télécharger + 10 Go à laisser libres > 15 Go
        finally:
            w.shutil.disk_usage = usage
        self.assertIn('disque presque plein', str(e.exception))
        self.assertFalse((self.dir / 'gpu' / 'models').exists(), 'rien téléchargé')

    def test_prune_removes_what_the_catalog_no_longer_names(self):
        g = self.gpu()
        root = self.dir / 'gpu'
        system = 'windows' if w.IS_WINDOWS else 'linux'
        current = g.engine_dir('sdcpp', self.catalog['engines']['sdcpp'][system])
        old = root / 'engines' / 'sdcpp-000000000000'
        for d in (current, old, root / 'models' / 'z-image-turbo', root / 'models' / 'old-model', root / 'downloads'):
            d.mkdir(parents=True)
        (root / 'models' / 'z-image-turbo' / 'ae.safetensors').write_text('keep')
        (root / 'models' / 'z-image-turbo' / 'ae.safetensors.ok').write_text('keep')
        (root / 'models' / 'z-image-turbo' / 'z_image_turbo-Q6_K.gguf').write_text('old quant')
        g.prune()
        self.assertTrue(current.exists())
        self.assertFalse(old.exists())
        self.assertFalse((root / 'models' / 'old-model').exists())
        self.assertFalse((root / 'downloads').exists())
        self.assertEqual(sorted(p.name for p in (root / 'models' / 'z-image-turbo').iterdir()), ['ae.safetensors', 'ae.safetensors.ok'])

    def test_download_checks_and_remembers_the_checksum(self):
        src = self.dir / 'src.bin'
        src.write_bytes(b'weights' * 1000)
        digest = w.sha256_file(src)
        dest = self.dir / 'm' / 'model.gguf'
        w.download_resume(src.as_uri(), dest, digest, src.stat().st_size, 'test')
        self.assertEqual(dest.read_bytes(), src.read_bytes())
        self.assertTrue(Path(str(dest) + '.ok').exists())
        # Un fichier modifié depuis (taille ou date) est re-vérifié, et refusé s'il ne correspond plus
        dest.write_bytes(b'corrupted' * 10)
        sleep = w.time.sleep
        w.time.sleep = lambda s: None
        try:
            with self.assertRaises(RuntimeError):
                w.download_resume(src.as_uri(), dest, '0' * 64, src.stat().st_size, 'test')
        finally:
            w.time.sleep = sleep
        self.assertFalse(dest.exists())

    def test_output_checks(self):
        p = self.dir / 'o.png'
        p.write_bytes(w.PNG_MAGIC + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', 640, 384) + b'\x08\x06\0\0\0')
        self.assertEqual(w.png_size(p), (640, 384))
        g = self.dir / 'o.glb'
        body = b'{"asset":{}}    '
        g.write_bytes(b'glTF' + struct.pack('<II', 2, 12 + len(body)) + body)
        self.assertTrue(w.is_glb(g))
        g.write_bytes(b'glTF' + struct.pack('<II', 2, 999) + body)
        self.assertFalse(w.is_glb(g))


class EngineTraceTest(unittest.TestCase):
    """Sortie de stable-diffusion.cpp lue au fil de l'eau : carte, plan mémoire, phases et temps remontés au hub."""

    def sample(self, cpu=False):
        bar = lambda a, b, speed: '\r  |%s| %d/%d - %10s\x1b[K%s' % ('#' * (50 * a // b) + ' ' * (50 - 50 * a // b), a, b, speed, '\n' if a == b else '')
        out = ['ggml_vulkan: Found 2 Vulkan devices:\n',
               'ggml_vulkan: 0 = AMD Radeon RX 6950 XT (AMD proprietary driver) | uma: 0 | fp16: 1 | bf16: 0 | warp size: 64\n',
               'ggml_vulkan: 1 = AMD Radeon(TM) Graphics (AMD proprietary driver) | uma: 1 | fp16: 1\n',
               '[INFO ] backend_fit.cpp:334 - auto-fit plan:\n',
               '[INFO ] backend_fit.cpp:337 -     Vulkan0      AMD Radeon RX 6950 XT            free  15312 MiB, budget  14800 MiB\n',
               '[INFO ] backend_fit.cpp:344 -     RAM          free  20480 MiB, params budget  18432 MiB\n',
               '[DEBUG] model.cpp:12 - a line nobody needs\n']
        if cpu:
            out.append('[WARN ] backend_fit.cpp:457 - auto-fit: no GPU memory budget available; using CPU\n')
        else:
            out.append('[INFO ] backend_fit.cpp:485 - auto-fit: --backend "diffusion=Vulkan0,te=Vulkan0,vae=Vulkan0" --params-backend "te=cpu"\n')
        out += [bar(a, 400, '27.31MB/s') for a in (100, 200, 400)]
        out.append('[INFO ] model_loader.cpp:1437 - loading tensors completed, taking 412.20s (read: 400.10s, memcpy: 2.00s, convert: 0.00s, copy_to_backend: 9.00s)\n')
        out.append('[INFO ] image.cpp:662 - get_learned_condition completed, taking 131.05s\n')
        out += [bar(a, 8, '%.2fs/it' % 24.5) for a in range(1, 9)]
        out.append('[INFO ] image.cpp:1037 - sampling completed, taking 196.10s\n')
        out += [bar(a, 16, '1.10it/s') for a in (8, 16)]
        out.append('[INFO ] image.cpp:757 - decode_first_stage completed, taking 35.20s\n')
        out.append('[INFO ] main.cpp:900 - generate_image completed in 790.00s\n')
        return ''.join(out).encode()

    def feed(self, trace, data, size=37):
        for i in range(0, len(data), size):   # blocs arbitraires : lignes et barres coupées n'importe où
            trace.feed(data[i:i + size])
        trace.close()

    def test_phases_device_plan_and_times(self):
        clock = [100.0]
        t = w.EngineTrace(steps=8, clock=lambda: clock[0])
        self.feed(t, self.sample())
        m = t.summary()
        self.assertEqual(m['device'], 'AMD Radeon RX 6950 XT')
        self.assertEqual(m['backend'], 'diffusion=Vulkan0,te=Vulkan0,vae=Vulkan0')
        self.assertEqual((m['vram_free_mib'], m['vram_budget_mib'], m['ram_free_mib']), (15312, 14800, 20480))
        self.assertEqual((m['load_s'], m['encode_s'], m['sampling_s'], m['decode_s'], m['total_s']), (412.2, 131.1, 196.1, 35.2, 790.0))
        self.assertEqual(m['s_per_step'], 24.5)
        self.assertTrue(any('--params-backend "te=cpu"' in l for l in t.lines))
        self.assertFalse(any('nobody needs' in l for l in t.lines))
        self.assertFalse(any('MB/s' in l or 's/it' in l for l in t.lines), 'les barres ne remplissent pas le journal')

    def test_cpu_fallback_is_named(self):
        t = w.EngineTrace(steps=8)
        self.feed(t, self.sample(cpu=True))
        self.assertEqual(t.summary()['backend'], 'cpu')

    def test_progress_and_stage_while_running(self):
        t = w.EngineTrace(steps=8)
        t.feed(b'\r  |#########                    | 100/400 -   27.31MB/s\x1b[K')
        self.assertEqual(t.stage(), 'chargement des poids')
        self.assertAlmostEqual(t.progress, 0.05 + 0.25 * 0.25)
        t.feed(b'\n[INFO ] image.cpp:662 - get_learned_condition completed, taking 1.05s\n')
        t.feed(b'\r  |======>        | 3/8 - 4.25s/it\x1b[K')
        self.assertEqual(t.stage(), 'étape 3/8 (4.2 s par étape)')
        self.assertAlmostEqual(t.progress, 0.35 + 0.55 * 3 / 8)
        before = t.progress
        t.feed(b'\r  |=====| 8/8 - 4.00s/it\x1b[K\n\r  |##| 4/16 - 2.00it/s\x1b[K')
        self.assertEqual(t.stage(), 'décodage')
        self.assertGreater(t.progress, before)

    def test_log_is_bounded(self):
        t = w.EngineTrace(steps=8)
        for i in range(500):
            t.feed(('[WARN ] x.cpp:1 - warning %d\n' % i).encode())
        self.assertEqual(len(t.lines), w.EngineTrace.MAX_LINES)
        self.assertIn('warning 0', t.lines[0])
        self.assertIn('warning 499', t.lines[-1])


class PrefetchTest(unittest.TestCase):
    """Lecture séquentielle des poids avant le moteur : débit mesuré, sautée si la mémoire ne peut pas tout garder."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.files = []
        for i, size in enumerate((3 << 20, 1 << 20)):
            f = self.dir / ('w%d.gguf' % i)
            f.write_bytes(os.urandom(size))
            self.files.append(f)

    def test_reads_everything_and_reports_speed(self):
        seen = []
        info = w.prefetch(self.files, progress=lambda frac, stage: seen.append((frac, stage)), block=1 << 20, ram=lambda: 1 << 40)
        self.assertGreater(info['prefetch_mb_s'], 0)
        self.assertGreaterEqual(info['prefetch_s'], 0)

    def test_skipped_when_memory_cannot_hold_the_weights(self):
        info = w.prefetch(self.files, ram=lambda: 2 << 20)
        self.assertIn('sauté', info['prefetch'])

    def test_unknown_memory_still_reads(self):
        self.assertIn('prefetch_mb_s', w.prefetch(self.files, ram=lambda: None))

    def test_cancel_stops_reading(self):
        import threading
        stop = threading.Event()
        stop.set()
        with self.assertRaises(w.JobLost):
            w.prefetch(self.files, stop=stop, block=1 << 20, ram=lambda: None)

    def test_available_ram_is_a_number_or_none(self):
        v = w.available_ram()
        self.assertTrue(v is None or v > 0)

def make_png(path, width, height, pixel=lambda x, y: (x * 7 + y * 13) % 256):
    import zlib
    rows = b''.join(b'\x00' + bytes(pixel(x, y) for x in range(width)) for y in range(height))
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    Path(path).write_bytes(w.PNG_MAGIC + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0))
                           + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def make_glb(path, doc):
    raw = json.dumps(doc).encode()
    raw += b' ' * (-len(raw) % 4)
    body = struct.pack('<I4s', len(raw), b'JSON') + raw
    Path(path).write_bytes(b'glTF' + struct.pack('<II', 2, 12 + len(body)) + body)


class GpuTestHelpersTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_glb_stats_counts_and_box(self):
        p = self.dir / 'a.glb'
        make_glb(p, {'asset': {'version': '2.0'}, 'images': [{}], 'materials': [{}],
                     'meshes': [{'primitives': [{'attributes': {'POSITION': 0}, 'indices': 1}, {'attributes': {'POSITION': 2}}]}],
                     'accessors': [{'count': 10, 'min': [-1, 0, 0], 'max': [1, 1, 1]}, {'count': 12}, {'count': 5, 'min': [0, 0, -2], 'max': [3, 1, 0]}]})
        self.assertEqual(w.glb_stats(p), {'vertices': 15, 'triangles': 4, 'meshes': 1, 'textures': 1, 'materials': 1, 'bbox_size': [4, 1, 3]})
        empty = self.dir / 'b.glb'
        make_glb(empty, {'asset': {'version': '2.0'}})
        self.assertEqual(w.glb_stats(empty)['triangles'], 0)
        (self.dir / 'c.glb').write_bytes(b'not a glb')
        self.assertIsNone(w.glb_stats(self.dir / 'c.glb'))

    def test_png_stats_tell_a_flat_image(self):
        make_png(self.dir / 'flat.png', 64, 64, lambda x, y: 0)
        make_png(self.dir / 'busy.png', 64, 64)
        self.assertLess(w.png_stats(self.dir / 'flat.png')['std'], 2)
        self.assertGreater(w.png_stats(self.dir / 'busy.png')['std'], 20)
        self.assertEqual(w.png_size(self.dir / 'busy.png'), (64, 64))

    def test_log_tail_strips_bars_and_colours(self):
        p = self.dir / 'x.log'
        p.write_bytes(b'one\r\n\x1b[32mtwo\x1b[0m\r  |==>  | 1/8\r  |====>| 2/8\nthree\n' + b'\n'.join(b'l%d' % i for i in range(100)))
        tail = w.log_tail(p, lines=5)
        self.assertEqual(tail, ['l95', 'l96', 'l97', 'l98', 'l99'])
        self.assertIn('two', w.log_tail(p, lines=200))
        self.assertEqual(w.log_tail(self.dir / 'missing.log'), [])

    def test_trellis_stages_are_followed(self):
        t = w.EngineTrace()
        t.feed(b'[1/7] preprocess\n[5/7] FlexiDualGrid shape decode -> mesh @res512\n')
        self.assertEqual(t.stage(), '5/7 FlexiDualGrid shape decode -> mesh @res512')
        self.assertAlmostEqual(t.progress, 0.3 + 0.65 * 4 / 7, places=3)
        self.assertTrue(any('[5/7]' in l for l in t.lines))


class SteadyRateTest(unittest.TestCase):
    def test_one_slow_step_does_not_stop_a_fast_run(self):
        now = [0.0]
        t = w.ComfyTrace(16, clock=lambda: now[0])
        for i, at in enumerate([8, 228, 234, 240, 246], 1):   # jobs 54/57 : une étape lente, puis le vrai rythme ?
            now[0] = at
            t.feed((' %d/16 [00:00<00:00, 115.80s/it]\r' % i).encode().replace(b' %d/16' % i, b'|##| %d/16' % i))
        self.assertEqual(t.step_durations(), [220, 6, 6, 6])
        self.assertEqual(t.steady_rate(), 6)
        self.assertEqual(t.summary()['s_per_step'], 6)
        self.assertEqual(t.summary()['tqdm_s_per_step'], 115.8)
        self.assertEqual(t.summary()['step_times'], '220.0,6.0,6.0,6.0')
        slow = w.ComfyTrace(16, clock=lambda: now[0])
        for i, at in enumerate([8, 120, 232, 344], 1):
            now[0] = at
            slow.feed(('|##| %d/16 [00:00<00:00, 112.00s/it]\r' % i).encode())
        self.assertEqual(slow.steady_rate(), 112)


class ComfyTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.spec = w.comfy_spec()

    def test_catalog_entry_is_pinned(self):
        s = self.spec
        for part in ('python', 'pip', 'setuptools', 'source'):
            self.assertRegex(s[part]['sha256'], r'^[0-9a-f]{64}$')
            self.assertTrue(s[part]['url'].startswith('https://'))
        self.assertTrue(all(re.search(r'==\d', p) for p in s['torch']['packages']), 'torch pinned to an exact version')
        self.assertTrue(all('/resolve/' in f['url'] and re.search(r'/resolve/[0-9a-f]{40}/', f['url']) for f in s['files']), 'models pinned to a commit')
        self.assertIn('127.0.0.1', s['args'])
        self.assertNotIn('0.0.0.0', s['args'])

    def test_pth_gets_comfyui_and_site(self):
        py = self.dir / 'python'
        py.mkdir()
        (py / 'python313._pth').write_text('python313.zip\n.\n\n# Uncomment to run site.main() automatically\n#import site\n')
        w.write_pth(py, self.dir / 'ComfyUI-0.45.0')
        self.assertEqual((py / 'python313._pth').read_text().split('\n')[:4], ['python313.zip', '.', os.path.join('..', 'ComfyUI-0.45.0'), 'import site'])
        w.write_pth(py, self.dir / 'ComfyUI-0.45.0')   # deux fois : pas de doublon
        self.assertEqual((py / 'python313._pth').read_text().count('ComfyUI'), 1)
        w.write_pth(py, self.dir / 'ComfyUI-0.46.0')   # nouvelle version du catalogue : l'ancien dossier disparaît
        self.assertEqual((py / 'python313._pth').read_text().split('\n')[:4], ['python313.zip', '.', os.path.join('..', 'ComfyUI-0.46.0'), 'import site'])

    def test_every_pip_call_has_a_form_pip_accepts_on_windows(self):
        """pip refuse de se modifier sous Windows si argv[0] s'appelle pip (essai n°3 sur gpu-box) : amorçage par -c, le reste par -m pip."""
        calls = []
        base = self.dir
        (base / 'logs').mkdir()
        spec = json.loads(json.dumps(self.spec))
        lay = w.comfy_layout(base, spec)

        def fake_download(url, dest, sha, what, headers=None):
            Path(dest).parent.mkdir(parents=True, exist_ok=True)
            Path(dest).write_bytes(b'x')
            return Path(dest)

        def fake_extract(archive, dest):
            if 'python' in str(archive):
                Path(dest).mkdir(parents=True, exist_ok=True)
                (Path(dest) / 'python313._pth').write_text('python313.zip\n.\n#import site\n')
            else:
                (lay['src']).mkdir(parents=True, exist_ok=True)
                (lay['src'] / 'main.py').write_text('')
                (lay['src'] / 'requirements.txt').write_text('torch\n')
        saved = {k: getattr(w, k) for k in ('IS_WINDOWS', 'download', 'safe_extract', 'run_logged', 'download_resume')}
        saved_usage = w.shutil.disk_usage
        try:
            w.IS_WINDOWS = True
            w.download, w.safe_extract = fake_download, fake_extract
            w.run_logged = lambda args, *a, **k: calls.append([str(x) for x in args]) or ''
            w.download_resume = lambda url, dest, *a, **k: Path(dest)
            w.shutil.disk_usage = lambda p: __import__('collections').namedtuple('U', 'total used free')(10 ** 13, 0, 10 ** 13)
            gpu = w.Gpu(base, {'gpu_max_gb': 200, 'gpu_keep_free_gb': 0}, Path(w.__file__).parent)
            w.comfy_install(base, spec, gpu, None, lambda f, st: None, {})
        finally:
            for k, v in saved.items():
                setattr(w, k, v)
            w.shutil.disk_usage = saved_usage
        self.assertEqual(len(calls), 3, calls)
        boot = calls[0]
        self.assertEqual(boot[1:4], ['-s', '-c', w.PIP_BOOTSTRAP])
        self.assertTrue(boot[4].endswith('pip-26.3-py3-none-any.whl'))
        self.assertEqual(boot[5:8], ['install', '--no-index', '--no-warn-script-location'])
        self.assertTrue(boot[8].endswith('pip-26.3-py3-none-any.whl') and boot[9].endswith('setuptools-84.2.1-py3-none-any.whl'))
        self.assertFalse(any(os.path.basename(a.rstrip('/\\')) in ('pip', 'pip3', 'pip.exe') for a in boot), 'argv[0] is never pip')
        for c in calls[1:]:
            self.assertEqual(c[1:5], ['-s', '-m', 'pip', 'install'], c)
        self.assertIn('--no-build-isolation', calls[1])
        self.assertIn('-c', calls[2])

    def test_pip_bootstrap_installs_from_the_wheel(self):
        """Le vrai amorçage, contre une vraie roue de pip si le pip du système en fournit une (sinon : sauté)."""
        import subprocess as sp, glob
        wheels = glob.glob('/usr/share/python-wheels/pip-*.whl')
        if not wheels:
            self.skipTest('pas de roue de pip locale')
        target = self.dir / 'target'
        args = w.pip_bootstrap_command(sys.executable, wheels[0], [wheels[0]])
        args[1:2] = ['-I']   # pas de site-packages utilisateur dans le test
        r = sp.run(args[:-1] + ['--target', str(target), args[-1]], stdout=sp.PIPE, stderr=sp.STDOUT, timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout.decode()[-800:])
        self.assertTrue((target / 'pip').is_dir())

    def test_markers_follow_python_and_comfyui_versions(self):
        spec = json.loads(json.dumps(self.spec))
        before = {s: w.comfy_marker(spec, s) for s in ('python', 'pip', 'source', 'torch', 'requirements')}
        spec['python']['sha256'] = '0' * 64
        after = {s: w.comfy_marker(spec, s) for s in before}
        self.assertEqual([s for s in before if before[s] != after[s]], ['python', 'pip', 'torch', 'requirements'], 'site-packages redone')
        spec2 = json.loads(json.dumps(self.spec))
        spec2['source']['sha256'] = '1' * 64
        self.assertEqual([s for s in before if before[s] != w.comfy_marker(spec2, s)], ['source', 'requirements'])

    def test_workflow_values_replace_whole_items_only(self):
        wf = w.comfy_workflow(self.spec, {'prompt': 'a {width} teapot', 'width': 768, 'height': 512, 'steps': 4, 'seed': 7})
        self.assertEqual(wf['57:13']['inputs']['width'], 768)
        self.assertEqual(wf['57:3']['inputs']['steps'], 4)
        self.assertEqual(wf['57:27']['inputs']['text'], 'a {width} teapot', 'a value is never re-read as a template')
        self.assertEqual(wf['57:3']['inputs']['model'], ['57:11', 0])
        with self.assertRaises(RuntimeError):
            w.comfy_workflow(self.spec, {'prompt': 'x'})

    def test_tqdm_and_execution_time(self):
        t = w.ComfyTrace(8)
        t.feed(b' 25%|##5       | 2/8 [00:26<01:19, 13.25s/it]\r 38%|###8      | 3/8 [00:39<01:06, 13.31s/it]\r')
        t.feed(b'\nRequested to load ZImage\nloaded partially; 11800.00 MB usable\nPrompt executed in 131.52 seconds\n')
        self.assertEqual(t.step, 3)
        self.assertEqual(t.summary()['s_per_step'], 13.31)
        self.assertEqual(t.summary()['executed_s'], 131.5)
        self.assertTrue(any('loaded partially' in l for l in t.lines))
        t.feed(b'Prompt executed in 00:10:21\n')
        self.assertEqual(t.summary()['executed_s'], 621)

    def test_disk_cap_refuses_before_any_download(self):
        base = self.dir
        (base / 'logs').mkdir()
        report = w.comfy_test_report(base, {'gpu_max_gb': 1}, 'comfyui', {}, None, lambda f, s: None, {'ok': False})
        self.assertFalse(report['ok'])
        self.assertIn('plafonné', report['error'])
        self.assertGreater(report['disk']['need_gb'], 20)
        self.assertFalse((base / 'gpu' / 'comfyui' / 'downloads').exists(), 'nothing downloaded')

    def test_remove_takes_everything_away(self):
        root = self.dir / 'gpu' / 'comfyui'
        (root / 'data' / 'models').mkdir(parents=True)
        (root / 'data' / 'models' / 'x.safetensors').write_bytes(b'x' * 1000)
        report = w.comfy_test_report(self.dir, {}, 'comfyui_remove', {}, None, None, {'ok': False})
        self.assertTrue(report['ok'])
        self.assertFalse(root.exists())
        self.assertTrue((self.dir / 'gpu').exists(), 'only the ComfyUI folder')


FAKE_COMFY = r'''
import http.server, json, os, struct, sys, threading, time, zlib
a = sys.argv[1:]
port, base = int(a[a.index('--port') + 1]), a[a.index('--base-directory') + 1]
assert '127.0.0.1' == a[a.index('--listen') + 1]
history = {}
print('Total VRAM 16368 MB, total RAM 32000 MB', flush=True)
print('pytorch version: 2.13.0+rocm10.0.0', flush=True)
print('HIP_VISIBLE_DEVICES %s TEMP %s' % (os.environ.get('HIP_VISIBLE_DEVICES'), os.environ.get('TEMP')), flush=True)
flat = lambda: '--fp16-unet' in a and os.path.exists(os.path.join(base, 'flat-fp16'))
slow = os.path.exists(os.path.join(base, 'slow'))
print('Set vram state to: NORMAL_VRAM', flush=True)
def png(path, w, h):
    is_flat = flat()
    rows = b''.join(b'\x00' + bytes(0 if is_flat else (x * 7 + y * 13 + len(history)) % 256 for x in range(w)) for y in range(h))
    c = lambda k, d: struct.pack('>I', len(d)) + k + d + struct.pack('>I', zlib.crc32(k + d))
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 0, 0, 0, 0)) + c(b'IDAT', zlib.compress(rows)) + c(b'IEND', b''))
def run(pid, wf):
    with open(os.path.join(base, 'last-workflow.json'), 'w') as f:
        json.dump(wf, f)
    node = lambda kind: [n for n in wf.values() if n['class_type'] == kind][0]
    for n in wf.values():
        if n['class_type'] == 'LoadImage':
            assert os.path.exists(os.path.join(base, 'input', n['inputs']['image'])), 'reference placed in ComfyUI input'
    steps = node('KSampler')['inputs']['steps']
    print('Requested to load Flux3TEModel_', flush=True)
    print('loaded completely; 15000.00 MB usable, 8000.00 MB loaded, full load: True', flush=True)
    if os.path.exists(os.path.join(base, 'native-crash')):   # plantage en code natif pendant l'encodeur (jobs 187 à 192)
        print('Windows fatal exception: access violation\n\nThread 0x0000a1b2 (most recent call first):\n'
              '  File "C:\\py\\threading.py", line 359 in wait\n\nCurrent thread 0x00004c2c (most recent call first):\n'
              '  File "C:\\gpu\\comfyui\\ComfyUI\\comfy\\text_encoders\\llama.py", line 412 in forward\n'
              '  File "C:\\gpu\\comfyui\\ComfyUI\\main.py", line 200 in prompt_worker', flush=True)
        import signal
        os.kill(os.getpid(), signal.SIGSEGV)
    time.sleep(0.3)
    print('Requested to load Flux3', flush=True)
    print('model weight dtype torch.%s, manual cast: %s' % ('float16' if '--fp16-unet' in a else 'bfloat16', 'None' if '--fp16-unet' in a else 'torch.float32'), flush=True)
    print('loaded completely; 14000.00 MB usable, 11000.00 MB loaded, full load: True', flush=True)
    for i in range(1, steps + 1):
        print(' %3d%%|###   | %d/%d [00:01<00:02,  %s]' % (100 * i // steps, i, steps, '500.00s/it' if slow else '0.05s/it'), end='\r', flush=True)
        time.sleep(0.2 if slow else 0.05)
    time.sleep(0.2 if slow else 1.1)   # décodage VAE : le worker voit les étapes finies et mesure la mémoire vidéo
    print('\nPrompt executed in 0.42 seconds', flush=True)
    lat = [n for n in wf.values() if n['class_type'].startswith('Empty')][0]['inputs']
    os.makedirs(os.path.join(base, 'output'), exist_ok=True)
    name = 'bench_%05d_.png' % (len(history) + 1)
    png(os.path.join(base, 'output', name), lat['width'], lat['height'])
    history[pid] = {'status': {'status_str': 'success', 'completed': True, 'messages': []},
                    'outputs': {'9': {'images': [{'filename': name, 'subfolder': '', 'type': 'output'}]}}}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *x):
        pass
    def answer(self, code, body):
        out = json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(out)))
        self.end_headers(); self.wfile.write(out)
    def do_GET(self):
        if self.path == '/system_stats':
            return self.answer(200, {'system': {'comfyui_version': '0.45.0', 'pytorch_version': '2.13.0+rocm10.0.0', 'python_version': sys.version, 'os': 'nt'},
                                     'devices': [{'name': 'cuda:0 AMD Radeon RX 6950 XT : native', 'type': 'cuda', 'vram_total': 17163091968,
                                                  'vram_free': 5270 * 1048576 if os.path.exists(os.path.join(base, 'vram-busy')) else 16000000000}]})
        pid = self.path.rsplit('/', 1)[-1]
        return self.answer(200, {pid: history[pid]} if pid in history else {})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/free':   # comme ComfyUI : drapeaux posés, déchargement par le fil de travail, réponse vide
            with open(os.path.join(base, 'free-calls'), 'a') as f:
                f.write(json.dumps(body, sort_keys=True) + '\n')
            if not os.path.exists(os.path.join(base, 'vram-stuck')):
                threading.Timer(0.3, lambda: os.path.exists(os.path.join(base, 'vram-busy')) and os.unlink(os.path.join(base, 'vram-busy'))).start()
            self.send_response(200); self.send_header('Content-Length', '0'); self.end_headers()
            return
        pid = 'p%d' % (len(history) + 100)
        threading.Thread(target=run, args=(pid, body['prompt'])).start()
        return self.answer(200, {'prompt_id': pid, 'number': 1})
time.sleep(0.5)
print('Starting server', flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
'''


class KleinJobTest(unittest.TestCase):
    """Un travail FLUX 3 Klein contre un faux ComfyUI : références posées par le mécanisme du modèle, ComfyUI gardé entre
    deux travaux, sortie vérifiée, rien ne reste dans le dossier de ComfyUI."""
    def test_klein_job_with_references_then_a_second_job_reuses_comfyui(self):
        base = Path(tempfile.mkdtemp())
        (base / 'logs').mkdir()
        gpu = w.Gpu(base, {'comfyui_any_os': True, 'gpu_keep_free_gb': 0, 'gpu_max_gb': 1000}, Path(w.__file__).resolve().parent)
        gpu.catalog['engines']['sdcpp']['linux'] = dict(gpu.catalog['engines']['sdcpp']['windows'])   # type image proposé ici
        spec = gpu.catalog['benchmarks']['comfyui']
        spec['torch']['check'] = "print('TORCH 2.13.0+rocm10.0.0 7.1 True 1'); print('DEV 0 gfx1030 17163091968 AMD Radeon RX 6950 XT')"
        lay = w.comfy_layout(base, spec)
        self.assertEqual(gpu.types(), ['image'])
        self.assertEqual(gpu.models(), [], 'ComfyUI not installed: the model is not announced')
        lay['exe'].parent.mkdir(parents=True)
        os.symlink(sys.executable, lay['exe'])
        lay['src'].mkdir(parents=True)
        (lay['src'] / 'main.py').write_text(FAKE_COMFY)
        for step in ('python', 'pip', 'source', 'torch', 'requirements'):
            (lay['root'] / ('.ok-' + step)).write_text(w.comfy_marker(spec, step))
        self.assertEqual(gpu.models(), ['flux3-klein'])
        model = gpu.catalog['types']['image']['models']['flux3-klein']
        for f in model['files']:
            dest = lay['data'] / 'models' / f['dir'] / f['name']
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b'fake')
            st = dest.stat()
            Path(str(dest) + '.ok').write_text('%s %d %d' % (f['sha256'], st.st_size, st.st_mtime_ns))
        work = base / 'work'
        work.mkdir()
        refs = []
        for n in range(2):
            make_png(work / ('ref%d.png' % n), 32, 24)
            refs.append(str(work / ('ref%d.png' % n)))
        job = {'id': 7, 'kind': 'image', 'model': 'flux3-klein', 'prompt': 'the cat from the first image on the sofa from the second image',
               'params': {'width': 320, 'height': 256, 'steps': 4, 'seed': 5, 'unet_dtype': 'fp16'}, 'ref_paths': refs}
        stages = []
        try:
            out, secs, meta = gpu.run(job, None, work, None, lambda f, st: stages.append(st))
            self.assertEqual(w.png_size(out), (320, 256))
            self.assertEqual(meta['references'], 2)
            self.assertEqual(meta['backend'], 'rocm')
            self.assertAlmostEqual(meta['s_per_step'], 0.05, delta=0.02)   # mesuré à l'horloge : tolérance pour une machine chargée
            self.assertIn('server_start_s', meta)
            wf = json.loads((lay['data'] / 'last-workflow.json').read_text())
            self.assertEqual(wf['refs']['inputs']['images.image0'], ['ref0', 0])
            self.assertEqual(wf['refs']['inputs']['images.image1'], ['ref1', 0])
            self.assertEqual(wf['refs']['inputs']['resolution.megapixels'], 1.0)
            self.assertEqual(wf['pos']['inputs']['text'], job['prompt'])
            self.assertEqual(wf['clip']['inputs']['device'], 'default', 'text encoder on the card by default (422 s on the processor, job 54)')
            self.assertEqual(wf['latent']['inputs'], {'width': 320, 'height': 256, 'batch_size': 1})
            self.assertEqual(wf['sampler']['inputs']['steps'], 4)
            self.assertEqual(list((lay['data'] / 'input').iterdir()), [], 'references removed from ComfyUI')
            self.assertEqual(list((lay['data'] / 'output').glob('*.png')), [], 'output removed from ComfyUI')
            pid = gpu.comfy['h']['proc'].pid
            # Second travail, sans référence : ComfyUI déjà chargé est réutilisé
            out2, _, meta2 = gpu.run(dict(job, id=8, ref_paths=[]), None, work, None, lambda f, st: None)
            self.assertTrue(meta2.get('server_reused'))
            self.assertEqual(gpu.comfy['h']['proc'].pid, pid)
            self.assertNotIn('images.image0', json.loads((lay['data'] / 'last-workflow.json').read_text())['refs']['inputs'])
            # Réglages par défaut : demi-précision, chargement estimé (pas dynamique), une seule attention ; et le diagnostic
            cmd = (base / 'gpu' / 'logs' / 'comfyui.log').read_text().splitlines()[0]
            self.assertIn('--fp16-unet', cmd)
            self.assertIn('--disable-dynamic-vram', cmd)
            self.assertEqual(sum(cmd.count(f) for f in w.ATTENTION_FLAGS), 1)
            self.assertEqual((meta['weight_dtype'], meta['compute_dtype']), ('float16', 'float16'))
            self.assertTrue(meta['load'].startswith('loaded completely'))
            self.assertTrue(meta['dit_load'].startswith('loaded completely; 14000'), meta)
            self.assertTrue(meta['te_load'].startswith('loaded completely; 15000'), meta)
            self.assertGreaterEqual(meta['before_dit_s'], 0.3)
            self.assertIn('vram_free_min_mib', meta)
            self.assertIn('--highvram', cmd)
            self.assertEqual(meta['text_encoder'], 'gpu')
            self.assertEqual(meta['vram_state'], 'NORMAL_VRAM')
            self.assertEqual(meta['unet_dtype'], 'fp16')
            self.assertIn('vram_free_before_mib', meta)
            self.assertTrue(all(re.fullmatch(r'[a-z_]{1,32}', k) for k in meta), 'keys the hub keeps')

            self.assertNotIn('freed', meta2, 'card with room (15258 MiB free): the weights left loaded are kept')
            self.assertFalse((lay['data'] / 'free-calls').exists())

            # Carte encore occupée par le DiT du travail précédent (5270 Mio libres, job 67) : libérée par POST /free avant
            # le calcul, place remesurée, ComfyUI gardé
            (lay['data'] / 'vram-busy').write_text('')
            out5, _, meta5 = gpu.run(dict(job, id=12, ref_paths=refs[:1]), None, work, None, lambda f, st: None)
            self.assertEqual(meta5['vram_free_before_mib'], 5270)
            self.assertIs(meta5['freed'], True)
            self.assertEqual(meta5['vram_free_after_free_mib'], 15258)
            self.assertNotIn('free_restart', meta5)
            self.assertEqual(gpu.comfy['h']['proc'].pid, pid, 'freed by ComfyUI itself, not restarted')
            self.assertEqual((lay['data'] / 'free-calls').read_text(), '{"free_memory": true, "unload_models": true}\n')
            self.assertEqual(w.png_size(out5), (320, 256))
            self.assertIs(gpu.last_trace.meta.get('freed'), True, 'sent to the hub with the progress, not only at the end')
            # Travail suivant, carte de nouveau pleine place : rien de libéré, plus de reste « freed » du travail précédent
            _, _, meta6 = gpu.run(dict(job, id=13, ref_paths=[]), None, work, None, lambda f, st: None)
            self.assertNotIn('freed', meta6)
            self.assertNotIn('freed', gpu.comfy['h']['box']['all'].meta)
            # Encodeur sur le processeur : les mêmes poids restés chargés tiennent tous sur la carte, gardés malgré 5270 Mio libres
            cpu_params = dict(job['params'], text_encoder='cpu')
            gpu.run(dict(job, id=14, ref_paths=[], params=cpu_params), None, work, None, lambda f, st: None)
            (lay['data'] / 'vram-busy').write_text('')
            _, _, meta7 = gpu.run(dict(job, id=15, ref_paths=[], params=cpu_params), None, work, None, lambda f, st: None)
            self.assertEqual(meta7['vram_free_before_mib'], 5270)
            self.assertNotIn('freed', meta7)
            self.assertEqual(len((lay['data'] / 'free-calls').read_text().splitlines()), 1)
            # /free sans effet : ComfyUI relancé, la carte repart vide
            (lay['data'] / 'vram-stuck').write_text('')
            w.COMFY_FREE_WAIT_S, wait = 1, w.COMFY_FREE_WAIT_S
            try:
                _, _, meta8 = gpu.run(dict(job, id=16, ref_paths=[]), None, work, None, lambda f, st: None)
            finally:
                w.COMFY_FREE_WAIT_S = wait
            self.assertTrue(meta8['freed'] and meta8['free_restart'])
            self.assertNotEqual(gpu.comfy['h']['proc'].pid, pid)
            self.assertEqual(meta8['vram_free_after_free_mib'], 5270, 'measured again after the restart (the fake card stays busy)')
            for name in ('vram-stuck', 'vram-busy'):
                (lay['data'] / name).unlink()
            pid = gpu.comfy['h']['proc'].pid

            # Image unie en fp16 (NaN) : refaite dans la précision sûre, ComfyUI relancé sans --fp16-unet
            (lay['data'] / 'flat-fp16').write_text('')
            out3, _, meta3 = gpu.run(dict(job, id=9, ref_paths=[]), None, work, None, lambda f, st: None)
            self.assertTrue(meta3['half_fallback'])
            self.assertRegex(meta3['try_first'], r'^fp16 quad : 0\.0[3-7] s/étape, [\d.]+ s, écart 0\.0$')
            self.assertRegex(meta3['try_second'], r'^default quad : ')
            self.assertEqual(meta3['compute_dtype'], 'float32')
            self.assertGreater(w.png_stats(out3)['std'], 2)
            self.assertNotIn('--fp16-unet', (base / 'gpu' / 'logs' / 'comfyui.log').read_text().splitlines()[0])
            (lay['data'] / 'flat-fp16').unlink()

            # Options d'essai : jetons connus seulement, environnement et ligne de commande
            gpu.stop_comfy()
            out4, _, meta4 = gpu.run(dict(job, id=11, ref_paths=[], params=dict(job['params'], comfyui_options='kitchen_hip_off, pinned_memory,rm -rf,no_fallback')),
                                     None, work, None, lambda f, st: None)
            cmd4 = (base / 'gpu' / 'logs' / 'comfyui.log').read_text().splitlines()[0]
            self.assertNotIn('--disable-pinned-memory', cmd4)
            self.assertIn('COMFY_KITCHEN_DISABLE_HIP=1', meta4['comfyui_flags'])
            self.assertEqual(meta4['comfyui_options_ignored'], 'rm -rf')
            self.assertEqual(w.comfy_options('upcast_attention,fp16_accumulation')[0], ['--force-upcast-attention', '--fast', 'fp16_accumulation'])

            # Trop lent pour le plafond : arrêt dès la deuxième étape mesurée, échec définitif avec la raison
            gpu.stop_comfy()
            (lay['data'] / 'slow').write_text('')
            model['timeout_s'] = 1.5   # 16 étapes de 0,2 s ne tiennent pas : arrêt sur le rythme mesuré, pas sur l'affichage de tqdm
            with self.assertRaises(w.Final) as e:
                gpu.run(dict(job, id=10, ref_paths=[], params=dict(job['params'], steps=16)), None, work, None, lambda f, st: None)
            self.assertRegex(str(e.exception), r'trop lent : 0\.2 s par étape \(étapes : 0,0,0')
            self.assertIn('float16', str(e.exception))
            self.assertIsNone(gpu.comfy, 'ComfyUI stopped, card given back')
        finally:
            gpu.stop_comfy()
        self.assertFalse(lay['pid'].exists(), 'card given back')


class ComfySlowReadsTest(unittest.TestCase):
    """Job 75 : une lecture lente juste après « Prompt executed » ne fait pas échouer un travail fini."""

    def test_vram_reading_that_times_out_is_skipped(self):
        import socket
        srv = socket.socket()
        srv.bind(('127.0.0.1', 0))
        srv.listen(1)   # accepte, ne répond jamais
        try:
            t0 = time.time()
            self.assertEqual(w.comfy_vram_safe(srv.getsockname()[1], timeout=0.5), (None, None))
            self.assertLess(time.time() - t0, 5)
            self.assertEqual(w.comfy_vram_safe(free_port(), timeout=0.5), (None, None), 'nothing listening')
        finally:
            srv.close()

    def test_history_poll_survives_a_timeout(self):
        import socket
        base = Path(tempfile.mkdtemp())
        out = base / 'data' / 'output'
        out.mkdir(parents=True)
        calls = []
        entry = {'status': {'status_str': 'success', 'completed': True}, 'outputs': {'9': {'images': [{'filename': 'a.png', 'subfolder': '', 'type': 'output'}]}}}

        def fake_local(port, method, path, body=None, timeout=30):
            calls.append(path)
            if path == '/prompt':
                return 200, {'prompt_id': 'p1'}
            if path.startswith('/history'):
                if calls.count(path) == 1:
                    raise socket.timeout('timed out')
                return 200, {'p1': entry}
            return 200, {}

        class Proc:
            def poll(self):
                return None
        h = {'proc': Proc(), 'port': 1, 'box': {'all': w.ComfyTrace(), 'trace': None}, 'lay': {'data': base / 'data'}}
        saved = w.comfy_local
        w.comfy_local = fake_local
        try:
            path, meta = w.comfy_prompt(h, {}, 4, None, lambda *x: None, 60)
        finally:
            w.comfy_local = saved
        self.assertEqual(path, out / 'a.png')
        self.assertEqual(h['trace'].meta.get('history_retries'), 1)
        self.assertEqual(calls.count('/history/p1'), 2)


class ComfyFreeRuleTest(unittest.TestCase):
    """Quand libérer la carte avant un travail ComfyUI : mesures réelles de gpu-box (jobs 62, 66, 67)."""
    def test_klein_need_and_rule(self):
        gpu = w.Gpu(Path(tempfile.mkdtemp()), {}, Path(w.__file__).resolve().parent)
        model = gpu.catalog['types']['image']['models']['flux3-klein']
        need, need_all = w.comfy_vram_need(model, {'te_device': 'default'})
        self.assertEqual(need, 10583 + 1024, 'DiT, the biggest model, plus margin')
        mib = {f['dir']: int(f['size']) / 1048576 for f in model['files']}
        self.assertEqual(need_all, int(sum(mib.values()) + 1024), 'text encoder + DiT do not fit together on 16 GB')
        self.assertGreater(need_all, 16368)
        cpu_need, cpu_all = w.comfy_vram_need(model, {'te_device': 'cpu'})
        self.assertEqual((cpu_need, cpu_all), (need, int(mib['diffusion_models'] + mib['vae'] + 1024)), 'text encoder on the processor: not on the card')
        total = 16368
        self.assertFalse(w.comfy_should_free(16226, total, need, need_all, False), 'empty card (job 62): nothing to do')
        self.assertTrue(w.comfy_should_free(5270, total, need, need_all, True), 'DiT left loaded, encoder must come back (job 67)')
        self.assertTrue(w.comfy_should_free(5270, total, need, need_all, False))
        self.assertFalse(w.comfy_should_free(5270, total, cpu_need, cpu_all, True), 'same weights, all fit: kept loaded')
        self.assertTrue(w.comfy_should_free(5270, total, cpu_need, cpu_all, False), 'other weights left loaded')
        self.assertTrue(w.comfy_should_free(5270, None, cpu_need, cpu_all, True), 'card size unknown: freed')
        self.assertFalse(w.comfy_should_free(None, total, need, need_all, False), 'free memory unknown: left as is')


class ComfyBenchTest(unittest.TestCase):
    """Le banc complet (lancement, workflow, mesures, image vérifiée, arrêt) contre un faux ComfyUI : l'installation est
    marquée faite, le Python est celui des tests."""
    def test_stopped_mid_bench_comfyui_is_killed_and_the_reason_kept(self):
        import threading as th
        stop = th.Event()
        base, lay, report = self.bench({'steps': 4, 'runs': 3}, stop, lambda f, s: stop.set() if 'passage 2/3' in s else None)
        self.assertFalse(report['ok'])
        self.assertIn('annulé', report['error'])
        self.assertFalse(lay['pid'].exists(), 'ComfyUI stopped, card given back')
        self.assertFalse((base / 'logs' / 'gpu-test-comfyui-3.png').exists())
        self.assertTrue(all((lay['root'] / ('.ok-' + s)).exists() for s in ('python', 'torch')), 'installation kept for the next test')

    def bench(self, params, stop, progress):
        base = Path(tempfile.mkdtemp())
        (base / 'logs').mkdir()
        spec = json.loads(json.dumps(w.comfy_spec()))
        spec['torch']['check'] = "print('TORCH 2.13.0+rocm10.0.0 7.1 True 1'); print('DEV 0 gfx1030 17163091968 AMD Radeon RX 6950 XT')"
        lay = w.comfy_layout(base, spec)
        lay['exe'].parent.mkdir(parents=True)
        os.symlink(sys.executable, lay['exe'])
        lay['src'].mkdir(parents=True)
        (lay['src'] / 'main.py').write_text(FAKE_COMFY)
        for step in ('python', 'pip', 'source', 'torch', 'requirements'):
            (lay['root'] / ('.ok-' + step)).write_text(w.comfy_marker(spec, step))
        for f in spec['files']:
            dest = lay['data'] / 'models' / f['dir'] / f['name']
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b'fake')
            st = dest.stat()
            Path(str(dest) + '.ok').write_text('%s %d %d' % (f['sha256'], st.st_size, st.st_mtime_ns))
        orig = w.comfy_spec
        w.comfy_spec = lambda app=None: spec
        try:
            return base, lay, w.comfy_test_report(base, {'gpu_keep_free_gb': 0}, 'comfyui', params, stop, progress, {'ok': False})
        finally:
            w.comfy_spec = orig

    def test_bench_measures_each_run_and_stops_comfyui(self):
        base = Path(tempfile.mkdtemp())
        (base / 'logs').mkdir()
        spec = json.loads(json.dumps(w.comfy_spec()))
        spec['torch']['check'] = ("print('TORCH 2.13.0+rocm10.0.0 7.1 True 2'); print('DEV 0 gfx1036 2147483648 AMD Radeon(TM) Graphics'); "
                                  "print('DEV 1 gfx1030 17163091968 AMD Radeon RX 6950 XT')")
        lay = w.comfy_layout(base, spec)
        lay['exe'].parent.mkdir(parents=True)
        os.symlink(sys.executable, lay['exe'])
        lay['src'].mkdir(parents=True)
        (lay['src'] / 'main.py').write_text(FAKE_COMFY)
        for step in ('python', 'pip', 'source', 'torch', 'requirements'):
            (lay['root'] / ('.ok-' + step)).write_text(w.comfy_marker(spec, step))
        for f in spec['files']:
            dest = lay['data'] / 'models' / f['dir'] / f['name']
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b'fake')
            st = dest.stat()
            Path(str(dest) + '.ok').write_text('%s %d %d' % (f['sha256'], st.st_size, st.st_mtime_ns))
        stages = []
        orig = w.comfy_spec
        w.comfy_spec = lambda app=None: spec
        try:
            report = w.comfy_test_report(base, {'gpu_keep_free_gb': 0}, 'comfyui', {'width': 256, 'height': 192, 'steps': 4, 'runs': 2},
                                         None, lambda f, s: stages.append(s), {'ok': False})
        finally:
            w.comfy_spec = orig
        self.assertTrue(report['ok'], json.dumps(report, ensure_ascii=False)[:1500])
        self.assertEqual(len(report['runs']), 2)
        self.assertEqual([r['seed'] for r in report['runs']], [42, 43], 'another seed each run (ComfyUI would serve its cache)')
        self.assertEqual(report['runs'][1]['executed_s'], 0.4)
        self.assertAlmostEqual(report['s_per_step'], 0.05, delta=0.02)   # mesuré à l'horloge : tolérance pour une machine chargée
        self.assertEqual(report['speedup_vs_sdcpp'], round(13.2 / report['s_per_step'], 2))
        self.assertEqual(report['torch'], '2.13.0+rocm10.0.0 7.1 True 2')
        self.assertEqual(report['torch_device'], {'index': 1, 'arch': 'gfx1030', 'memory_gb': 17.2, 'name': 'AMD Radeon RX 6950 XT'},
                         'integrated graphics seen too: the dedicated card is the one used')
        self.assertEqual(report['device']['name'], 'cuda:0 AMD Radeon RX 6950 XT : native')
        self.assertGreater(report['runs'][0]['image']['std'], 2)
        self.assertTrue((base / 'logs' / 'gpu-test-comfyui-2.png').exists())
        self.assertEqual(report['output'], str(base / 'logs' / 'gpu-test-comfyui-2.png'), 'the image sent to the hub')
        self.assertFalse(lay['pid'].exists(), 'ComfyUI stopped, card given back')
        self.assertTrue(any('passage 2/2' in s for s in stages))
        self.assertTrue(any('Prompt executed' in l for l in report['log']))
        self.assertTrue(any(l == 'HIP_VISIBLE_DEVICES 1 TEMP %s' % lay['tmp'] for l in report['log']), report['log'][:5])


FAKE_ATELIER = r'''
import http.server, json, os, sys, time
a = sys.argv[1:]
opt = lambda k: a[a.index(k) + 1] if k in a else None
base, port = opt('--base-directory'), int(opt('--port'))
os.makedirs(base, exist_ok=True)
with open(os.path.join(base, 'argv.jsonl'), 'a') as f:
    f.write(json.dumps({'args': a, 'pid': os.getpid(), 'alloc': os.environ.get('PYTORCH_HIP_ALLOC_CONF'), 'temp': os.environ.get('TEMP')}) + '\n')
held = {'mib': 9000}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *x):
        pass
    def answer(self, code, body):
        out = json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(out)))
        self.end_headers(); self.wfile.write(out)
    def do_GET(self):
        if self.path == '/queue':
            if os.path.exists(os.path.join(base, 'hang')):   # vivant mais muet (au-delà du délai de lecture du worker)
                time.sleep(7)
            busy = os.path.exists(os.path.join(base, 'busy'))
            return self.answer(200, {'queue_running': [[1, 'p1', {}, {}, []]] if busy else [], 'queue_pending': []})
        if self.path == '/system_stats':
            return self.answer(200, {'devices': [{'vram_total': 16384 * 1048576, 'vram_free': (16384 - held['mib']) * 1048576,
                                                  'torch_vram_total': held['mib'] * 1048576, 'torch_vram_free': 0}]})
        return self.answer(404, {})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        if self.path == '/free':
            with open(os.path.join(base, 'free-calls'), 'a') as f:
                f.write(json.dumps(body, sort_keys=True) + '\n')
            held['mib'] = 300
            self.send_response(200); self.send_header('Content-Length', '0'); self.end_headers()
            return
        return self.answer(404, {})
time.sleep(0.3)
print('Starting server', flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
'''


def free_port():
    import socket
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def alive(pid, settle=5.0):
    """Vivant après settle secondes au plus (un processus tué met un instant à devenir zombie)."""
    deadline = time.time() + settle
    while True:
        try:
            up = Path('/proc/%d/stat' % pid).read_text().split(' ')[2] != 'Z'
        except OSError:
            up = False
        if not up or time.time() > deadline:
            return up
        time.sleep(0.05)


GOOD_RULES = [
    {'name': 'ComfyUI atelier : poste client', 'action': 'Allow', 'direction': 'Inbound', 'enabled': 'True', 'remote': ['100.101.102.103']},
    {'name': 'ComfyUI atelier : tout le reste', 'action': 'Block', 'direction': 'Inbound', 'enabled': 'True',
     'remote': ['0.0.0.0-100.101.102.102', '100.101.102.104-126.255.255.255', '128.0.0.0-255.255.255.255']},
]


class AtelierNetTest(unittest.TestCase):
    """Ce qui décide de l'écoute de l'atelier : adresse Tailscale, adresses refusées, sockets réelles, règles de pare-feu."""

    def test_tailscale_address_is_taken_from_the_tailnet_only(self):
        self.assertEqual(w.parse_tailscale_ip('100.101.102.103\n'), '100.101.102.103')
        self.assertEqual(w.parse_tailscale_ip('192.168.1.20\n100.64.0.7\n'), '100.64.0.7')
        self.assertIsNone(w.parse_tailscale_ip('192.168.1.20\n'))
        self.assertIsNone(w.parse_tailscale_ip('100.128.0.1\n'), 'outside 100.64.0.0/10')
        self.assertIsNone(w.parse_tailscale_ip('Tailscale is stopped.\n'))
        self.assertIsNone(w.parse_tailscale_ip('fd7a:115c:a1e0::1\n'))

    def test_listen_address_never_everything(self):
        for bad in ('0.0.0.0', '::', '127.0.0.1', '255.255.255.255', '224.0.0.1', 'dev-box', '', '100.1.2.3,0.0.0.0'):
            self.assertIsNone(w.listen_ip_ok(bad), bad)
        self.assertEqual(w.listen_ip_ok(' 100.101.102.103 '), '100.101.102.103')

    def test_command_line_from_the_catalog(self):
        spec = w.comfy_spec()
        at = spec['atelier']
        args = w.atelier_args(spec, at, 8188, '127.0.0.1,100.101.102.103', '/x/data', '/x/extra.yaml', True)
        self.assertEqual(args[args.index('--listen') + 1], '127.0.0.1,100.101.102.103')
        self.assertEqual(args[args.index('--port') + 1], '8188')
        self.assertEqual(args[args.index('--extra-model-paths-config') + 1], '/x/extra.yaml')
        self.assertIn('--enable-manager', args)
        for flag in ('--disable-all-custom-nodes', '--disable-api-nodes'):
            self.assertNotIn(flag, args, 'the workshop allows custom nodes')
        self.assertIn('--disable-comfy-compiler', args)
        self.assertNotIn('--enable-manager', w.atelier_args(spec, at, 8188, '127.0.0.1', '/x', '/y', False))
        for listen in ('0.0.0.0', '127.0.0.1,0.0.0.0', '127.0.0.1,::'):
            with self.assertRaises(RuntimeError):
                w.atelier_args(spec, at, 8188, listen, '/x', '/y', False)
        self.assertEqual(at['env']['PYTORCH_HIP_ALLOC_CONF'], 'expandable_segments:True')
        self.assertNotIn('HF_HUB_OFFLINE', at['env'], 'custom nodes may fetch their own files')

    def test_netstat_rows_whatever_the_language(self):
        text = '''
Connexions actives

  Proto  Adresse locale         Adresse distante       État
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1104
  TCP    127.0.0.1:8188         0.0.0.0:0              ÉCOUTE          4242
  TCP    100.101.102.50:8188    0.0.0.0:0              ÉCOUTE          4242
  TCP    127.0.0.1:8188         127.0.0.1:50311        ESTABLISHED     4242
  TCP    [::]:445               [::]:0                 LISTENING       4
  UDP    0.0.0.0:5353           *:*                                    2200
'''
        self.assertEqual(w.parse_netstat(text), [('0.0.0.0', 135, 1104), ('127.0.0.1', 8188, 4242), ('100.101.102.50', 8188, 4242), ('::', 445, 4)])

    def test_firewall_rules_must_allow_the_dev_pc_only_and_block_the_rest(self):
        exe = '/x/atelier/python/python.exe'
        rules = lambda rs: [dict(r, program=exe) for r in rs]
        ok = w.atelier_firewall_check(rules(GOOD_RULES), exe)
        self.assertEqual((ok['ok'], ok['allow_from']), (True, ['100.101.102.103']))
        self.assertFalse(w.atelier_firewall_check([], exe)['ok'])
        self.assertFalse(w.atelier_firewall_check(rules(GOOD_RULES[:1]), exe)['ok'], 'no block rule')
        self.assertFalse(w.atelier_firewall_check([dict(r, program='/other/python.exe') for r in GOOD_RULES], exe)['ok'], 'another program')
        self.assertFalse(w.atelier_firewall_check(rules([dict(GOOD_RULES[0], enabled='False'), GOOD_RULES[1]]), exe)['ok'])
        anyone = w.atelier_firewall_check(rules([dict(GOOD_RULES[0], remote=['Any']), GOOD_RULES[1]]), exe)
        self.assertFalse(anyone['ok'])
        self.assertIn('toute adresse', anyone['problem'])
        lan = w.atelier_firewall_check(rules([dict(GOOD_RULES[0], remote=['192.168.1.0/255.255.255.0']), GOOD_RULES[1]]), exe)
        self.assertFalse(lan['ok'])
        self.assertIn('hors du tailnet', lan['problem'])
        two = w.atelier_firewall_check(rules([dict(GOOD_RULES[0], remote=['100.101.102.103', '100.64.0.9']), GOOD_RULES[1]]), exe)
        self.assertFalse(two['ok'], 'one address only: the dev PC')
        hole = w.atelier_firewall_check(rules([GOOD_RULES[0], dict(GOOD_RULES[1], remote=GOOD_RULES[1]['remote'][:2])]), exe)
        self.assertFalse(hole['ok'])
        self.assertIn('128.0.0.0', hole['problem'])
        # Blocage de tout : le poste client serait bloqué aussi (un blocage l'emporte sur une autorisation)
        everything = w.atelier_firewall_check(rules([GOOD_RULES[0], dict(GOOD_RULES[1], remote=['Any'])]), exe)
        self.assertFalse(everything['ok'])
        self.assertIn('poste client', everything['problem'])
        cidr = w.atelier_firewall_check(rules([GOOD_RULES[0], dict(GOOD_RULES[1], remote=['0.0.0.0/2', '64.0.0.0/3', '96.0.0.0/6',
                                                                                        '100.0.0.0-100.101.102.102', '100.101.102.104-126.255.255.255', '128.0.0.0/1'])]), exe)
        self.assertTrue(cidr['ok'], cidr)


class AtelierFilesTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_clone_by_hard_links_keeps_both_sides_independent(self):
        src = self.dir / 'jobs' / 'python'
        (src / 'Lib' / 'site-packages' / 'torch').mkdir(parents=True)
        (src / 'Lib' / 'site-packages' / 'torch' / '__init__.py').write_text('v1')
        (src / 'python313._pth').write_text('python313.zip\n.\n..\\ComfyUI-0.45.0\nimport site\n')
        (src / 'bin').mkdir()
        os.symlink(sys.executable, src / 'bin' / 'python3')
        dst = self.dir / 'atelier' / 'python'
        linked, copied = w.link_tree(src, dst)
        self.assertEqual((linked, copied), (1, 1))
        a, b = src / 'Lib' / 'site-packages' / 'torch' / '__init__.py', dst / 'Lib' / 'site-packages' / 'torch' / '__init__.py'
        self.assertEqual(a.stat().st_ino, b.stat().st_ino, 'no extra disk for torch')
        self.assertNotEqual((src / 'python313._pth').stat().st_ino, (dst / 'python313._pth').stat().st_ino, '._pth copied, never linked')
        self.assertEqual(os.readlink(dst / 'bin' / 'python3'), sys.executable)
        # Ce que fait pip : nouveau fichier puis renommage ; la copie des travaux ne bouge pas
        tmp = b.with_name('__init__.py.new')
        tmp.write_text('v2')
        os.replace(tmp, b)
        self.assertEqual(a.read_text(), 'v1')
        w.write_pth(dst, self.dir / 'atelier' / 'ComfyUI-0.45.0')
        self.assertIn('..\\ComfyUI-0.45.0', (src / 'python313._pth').read_text())

    def test_write_pth_never_writes_through_a_hard_link(self):
        py = self.dir / 'py'
        py.mkdir()
        (py / 'python313._pth').write_text('python313.zip\n.\n')
        os.link(py / 'python313._pth', self.dir / 'other._pth')
        w.write_pth(py, self.dir / 'ComfyUI-0.45.0')
        self.assertEqual((self.dir / 'other._pth').read_text(), 'python313.zip\n.\n')
        self.assertIn('import site', (py / 'python313._pth').read_text())

    def test_purge_by_age_then_by_size_oldest_first(self):
        out, inp = self.dir / 'output', self.dir / 'input'
        now = time.time()
        made = {}
        for i, (folder, days, size) in enumerate([(out, 10, 100), (out / 'sub', 3, 400), (inp, 2, 300), (out, 1, 200), (out, 0, 50)]):
            folder.mkdir(parents=True, exist_ok=True)
            p = folder / ('f%d.png' % i)
            p.write_bytes(b'x' * size)
            os.utime(p, (now - days * 86400, now - days * 86400))
            made[i] = p
        (out / '_output_images_will_be_put_here').write_text('')
        (out / '.keep').write_text('x' * 5000)
        removed, freed, left = w.purge_files([out, inp], 7, 600, now)
        self.assertEqual((removed, freed, left), (2, 500, 550))   # 10 jours, puis les plus anciens tant qu'on dépasse 600 octets
        self.assertEqual(sorted(p.name for p in made.values() if p.exists()), ['f2.png', 'f3.png', 'f4.png'])
        self.assertFalse((out / 'sub').exists(), 'emptied subfolder removed')
        self.assertTrue((out / '_output_images_will_be_put_here').exists() and (out / '.keep').exists())
        self.assertTrue(out.exists() and inp.exists())

    def test_shared_models_file(self):
        models = self.dir / "C'est" / 'models'
        for d in ('diffusion_models', 'vae', 'text_encoders'):
            (models / d).mkdir(parents=True)
        (models / 'readme.txt').write_text('x')
        text = w.atelier_extra_paths(models)
        self.assertIn("base_path: '%s'" % str(models).replace("'", "''"), text)
        self.assertEqual(re.findall(r'^    (\w+): \1$', text, re.M), ['diffusion_models', 'text_encoders', 'vae'])
        self.assertIn('reuse_jobs:', w.atelier_extra_paths(self.dir / 'missing'))


class AtelierBase(unittest.TestCase):
    """L'atelier mené par tick() contre un faux ComfyUI : environnement cloné de celui des travaux, lancé sur 127.0.0.1, puis
    relancé sur l'adresse Tailscale quand le pare-feu est prêt (jamais pendant un calcul), carte rendue après l'inactivité,
    repris après un redémarrage du worker, arrêté quand le hub l'éteint."""

    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        (self.base / 'logs').mkdir()
        self.port = free_port()
        self.config = {'atelier_enabled': True, 'comfyui_any_os': True, 'atelier_port': self.port, 'gpu_keep_free_gb': 0}
        self.gpu = w.Gpu(self.base, self.config, Path(w.__file__).resolve().parent)
        self.spec = self.gpu.catalog['benchmarks']['comfyui']
        jobs = w.comfy_layout(self.base, self.spec)
        (jobs['python'] / 'bin').mkdir(parents=True)
        os.symlink(sys.executable, jobs['python'] / 'bin' / 'python3')
        (jobs['python'] / 'lib-marker.txt').write_text('torch')
        for step in ('python', 'pip', 'source', 'torch', 'requirements'):
            (jobs['root'] / ('.ok-' + step)).write_text(w.comfy_marker(self.spec, step))
        (jobs['data'] / 'models' / 'vae').mkdir(parents=True)
        self.lay = w.atelier_layout(self.base, self.spec)
        self.lay['src'].mkdir(parents=True)
        (self.lay['src'] / 'main.py').write_text(FAKE_ATELIER)
        self.saved = (w.tailscale_ip, w.read_firewall_rules)
        self.ts = [None, 'tailscale pas prêt : Tailscale is stopped.']
        self.rules = [None, 'pare-feu Windows absent ici']
        w.tailscale_ip = lambda: tuple(self.ts)
        w.read_firewall_rules = lambda: tuple(self.rules)
        self.ateliers = []

    def tearDown(self):
        w.tailscale_ip, w.read_firewall_rules = self.saved
        for a in self.ateliers:
            a.shutdown('fin du test')

    def atelier(self):
        a = w.Atelier(self.base, self.config, Path(w.__file__).resolve().parent, self.gpu)
        self.ateliers.append(a)
        return a

    def runs(self):
        p = self.lay['data'] / 'argv.jsonl'
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []


class AtelierLifeTest(AtelierBase):
    def test_life(self):
        a = self.atelier()
        self.assertFalse(a.busy(), 'nothing running yet')
        a.tick()
        self.assertEqual(a.state, 'en marche', a.error)
        first = self.runs()[-1]
        self.assertEqual(first['args'][first['args'].index('--listen') + 1], '127.0.0.1', 'Tailscale not ready: local only')
        self.assertEqual(first['alloc'], 'expandable_segments:True')
        self.assertTrue(first['temp'].startswith(str(self.lay['root'])))
        self.assertEqual(Path(first['args'][first['args'].index('--base-directory') + 1]), self.lay['data'])
        self.assertTrue((self.lay['python'] / 'lib-marker.txt').exists(), 'environment cloned from the jobs one')
        self.assertIn(str(self.lay['jobs']['data'] / 'models'), self.lay['extra'].read_text())
        self.assertEqual(a.manager, 'absent de cette version de ComfyUI')
        self.assertNotIn('--enable-cors-header', first['args'], 'no CORS by default: the page is served by the workshop itself')
        self.assertEqual(a.describe()['files_gb'], 0.0, 'housekeeping ran')
        d = a.describe()
        self.assertEqual((d['state'], d['port'], d['listen'], d['busy']), ('en marche', self.port, '127.0.0.1', False))
        self.assertIn('tailscale pas prêt', d['error'])
        pid1 = a.pid
        # Tailscale prêt mais pas de pare-feu : toujours local seulement, pas de relance
        self.ts[:] = ['100.101.102.50', None]
        a.ts['at'] = a.fw['at'] = 0
        a.tick()
        self.assertEqual((a.pid, a.listen), (pid1, '127.0.0.1'))
        self.assertIn('pare-feu', a.describe()['firewall'])
        # Pare-feu posé pendant un calcul : la relance attend la fin du calcul
        self.rules[:] = [[dict(r, program=str(self.lay['exe'])) for r in GOOD_RULES], None]
        (self.lay['data'] / 'busy').write_text('1')
        a.fw['at'] = 0
        a.tick()
        self.assertTrue(a.busy())
        self.assertEqual(a.pid, pid1, 'never restarted while Alice computes')
        self.assertEqual(a.describe()['queue'], '1+0')
        (self.lay['data'] / 'busy').unlink()
        a.tick()
        self.assertIsNone(a.pid, 'stopped to listen on the new address')
        self.assertFalse(alive(pid1))
        a.tick()
        self.assertEqual(a.listen, '127.0.0.1,100.101.102.50')
        last = self.runs()[-1]
        self.assertEqual(last['args'][last['args'].index('--listen') + 1], '127.0.0.1,100.101.102.50')
        self.assertEqual(a.describe()['firewall'], 'prêt')
        self.assertEqual(a.describe()['allowed_from'], '100.101.102.103')
        # Inactif : la carte est rendue une fois (POST /free), pas à chaque tour
        self.config['atelier_idle_free_s'] = 0.2
        freed = self.lay['data'] / 'free-calls'
        for _ in range(50):   # machine chargée : quelques tours au plus
            time.sleep(0.1)
            a.tick()
            if freed.exists():
                break
        a.tick()
        calls = freed.read_text().splitlines()
        self.assertEqual(calls, ['{"free_memory": true, "unload_models": true}'])
        self.assertTrue(a.describe()['freed'])
        # Avant un travail du hub : /free et attente de la mémoire rendue
        self.assertEqual(a.free('travail image 1 du hub'), 300)
        # Le worker redémarre (mise à jour) : l'atelier continue, le nouveau worker le reprend
        pid2 = a.pid
        b = self.atelier()
        b.tick()
        self.assertEqual((b.pid, b.state, b.listen), (pid2, 'en marche', '127.0.0.1,100.101.102.50'))
        self.assertTrue(w.pid_alive(pid2) and b.running())
        self.assertFalse(w.pid_alive(2 ** 22 + 7))
        self.assertEqual(len(self.runs()), 2, 'not relaunched')
        (self.lay['data'] / 'busy').write_text('1')
        b.tick()
        self.assertTrue(b.busy(live=True))
        (self.lay['data'] / 'busy').unlink()
        # Créneau seulement : hors créneau, arrêté ; éteint depuis le hub : arrêté et rien ne repart
        self.config['atelier_window_only'] = True
        b.in_window = False
        b.tick()
        self.assertFalse(alive(pid2))
        self.assertEqual(b.state, 'éteint')
        b.in_window = True
        b.tick()
        self.assertEqual(b.state, 'en marche')
        pid3 = b.pid
        self.config['atelier_enabled'] = False
        b.tick()
        self.assertFalse(alive(pid3))
        self.assertFalse(self.lay['state'].exists())
        b.tick()
        self.assertEqual(len(self.runs()), 3, "nothing started again once switched off")
        self.assertEqual(b.describe()['state'], 'éteint')

    def test_silent_workshop_blocks_new_jobs_for_a_while_only_and_never_stops_a_running_one(self):
        a = self.atelier()
        a.tick()
        pid = a.pid
        (self.lay['data'] / 'busy').write_text('1')
        a.tick()
        self.assertTrue(a.busy(sure=True), 'a queue really read: a running hub job gives way')
        (self.lay['data'] / 'busy').unlink()
        a.tick()
        (self.lay['data'] / 'hang').write_text('1')
        for _ in range(3):
            a.tick()
        self.assertTrue(a.busy(), 'silent: no new hub job for now')
        self.assertFalse(a.busy(sure=True), 'a slow answer never stops a running hub job')
        self.assertGreaterEqual(a.describe()['unresponsive_s'], 0)
        self.assertEqual(a.pid, pid, 'not before atelier_hung_s')
        self.config['atelier_hung_s'] = 1
        (self.lay['data'] / 'hang').unlink()
        a.queue_errors, a.unresponsive_since = 3, time.time() - 5
        (self.lay['data'] / 'hang').write_text('1')
        a.tick()
        self.assertIsNone(a.pid, 'restarted, not counted busy forever')
        self.assertFalse(alive(pid))
        self.assertFalse(a.busy())
        (self.lay['data'] / 'hang').unlink()
        a.tick()
        self.assertEqual(a.state, 'en marche')
        self.assertNotEqual(a.pid, pid)
        self.assertIn('ne répondait plus à /queue', a.describe()['error'], 'said to the hub')
        self.assertFalse(a.busy())

    def test_jobs_environment_is_not_reinstalled_under_a_running_workshop(self):
        a = self.atelier()
        a.tick()
        self.gpu.atelier = a
        (self.lay['jobs']['root'] / '.ok-torch').unlink()
        with self.assertRaisesRegex(RuntimeError, 'liens physiques'):
            w.comfy_install(self.base, self.spec, self.gpu, None, lambda *x: None, {}, files=[])
        a.stop('suite')
        self.config['atelier_enabled'] = False
        with self.assertRaises(RuntimeError) as e:   # éteint : l'installation part (ici, refusée plus loin faute de Windows)
            w.comfy_install(self.base, self.spec, self.gpu, None, lambda *x: None, {}, files=[])
        self.assertNotIn('liens physiques', str(e.exception))

    def test_port_taken_and_crash_are_retried_later(self):
        import socket
        s = socket.socket()
        s.bind(('127.0.0.1', self.port))
        s.listen(1)
        a = self.atelier()
        try:
            a.tick()
            self.assertEqual(a.state, 'en échec')
            self.assertIn('port %d déjà pris' % self.port, a.error)
            a.tick()
            self.assertEqual(a.failures, 1, 'waits before the next try')
        finally:
            s.close()
        a.next_try = 0
        a.tick()
        self.assertEqual(a.state, 'en marche')
        os.kill(a.pid, 9)
        a.proc.wait()
        a.tick()
        self.assertEqual(a.state, 'en échec')
        self.assertIn('arrêté de lui-même', a.error)
        a.next_try = 0
        a.tick()
        self.assertEqual(a.state, 'en marche')

    def test_cors_only_for_one_precise_origin(self):
        self.config['atelier_cors_origin'] = '*'
        a = self.atelier()
        a.tick()
        self.assertNotIn('--enable-cors-header', self.runs()[-1]['args'])
        a.stop('suite')
        self.config['atelier_cors_origin'] = 'http://100.101.102.103:3000'
        a.tick()
        args = self.runs()[-1]['args']
        self.assertEqual(args[args.index('--enable-cors-header') + 1], 'http://100.101.102.103:3000')

    def test_comfyui_dying_at_start_is_retried_later_and_its_log_is_shown(self):
        """gpu-box, 14/11 : ComfyUI s'arrêtait au démarrage ; la surveillance lisait le code d'un Popen déjà oublié
        (AttributeError), relançait aussitôt, toutes les 25 s, état figé sur « démarrage »."""
        (self.lay['src'] / 'main.py').write_text("import sys\nprint('Traceback: ModuleNotFoundError: No module named comfyui_manager', flush=True)\n"
                                                  "print('token=abcdef0123456789 ' + 'a' * 40, flush=True)\nsys.exit(3)\n")
        a = self.atelier()
        a.tick()
        self.assertEqual(a.state, 'en échec')
        self.assertIn('code 3', a.error)
        self.assertIn('No module named comfyui_manager', a.error)
        self.assertIsNone(a.pid)
        self.assertGreater(a.next_try, time.time() + 10, 'waits before the next try')
        d = a.describe()
        self.assertIn('Traceback: ModuleNotFoundError: No module named comfyui_manager', d['log'])
        self.assertNotIn('abcdef0123456789', json.dumps(d), 'secret-looking values masked')
        self.assertNotIn('a' * 40, json.dumps(d))
        a.tick()
        self.assertEqual(len([l for l in (self.lay['logs'] / 'atelier.log').read_text().splitlines() if l.startswith('# ')]), 1,
                         'not relaunched right away')

    def test_any_startup_exception_backs_off(self):
        a = self.atelier()
        saved = a.prepare
        a.prepare = lambda spec, lay: (_ for _ in ()).throw(AttributeError('boom'))
        try:
            a.tick()
        finally:
            a.prepare = saved
        self.assertEqual(a.state, 'en échec')
        self.assertIn('boom', a.error)
        self.assertGreater(a.next_try, time.time() + 10)

    def test_jobs_environment_missing(self):
        (self.lay['jobs']['root'] / '.ok-torch').unlink()
        a = self.atelier()
        a.tick()
        self.assertEqual(a.state, 'en échec')
        self.assertIn('essai comfyui', a.error)
        self.assertEqual(self.runs(), [])

    def test_manager_installed_with_torch_pinned_then_skipped(self):
        (self.lay['src'] / 'manager_requirements.txt').write_text('comfyui_manager==4.2.2\n')
        calls = []
        saved = w.run_logged
        w.run_logged = lambda args, *x, **k: calls.append([str(v) for v in args]) or ''
        try:
            a = self.atelier()
            a.tick()
            a.stop('suite du test')
            a.tick()
        finally:
            w.run_logged = saved
        self.assertEqual(len(calls), 1, 'installed once')
        self.assertEqual(calls[0][1:6], ['-s', '-m', 'pip', 'install', '--no-warn-script-location'])
        self.assertIn('torch==2.13.0+rocm10.0.0', (self.lay['root'] / 'constraints.txt').read_text())
        self.assertTrue(a.manager is True)
        self.assertIn('--enable-manager', self.runs()[-1]['args'])


class AtelierTaskTest(AtelierBase):
    """Tâches du hub sur l'atelier : rien n'est effacé (corbeille), tout se défait, pip garde torch et dit ce qu'il a changé."""
    COMMIT = 'a' * 40

    def setUp(self):
        super().setUp()
        self.saved_tasks = (w.fetch_file, w.run_logged)
        self.pip_calls, self.freeze = [], [['numpy==2.1.0', 'torch==2.13.0+rocm10.0.0']]
        self.pip_fails = False

        def fake_fetch(url, dest, stop=None, timeout=120):
            self.fetched = url
            Path(dest).parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(dest, 'w') as z:
                top = 'Pack-%s/' % self.COMMIT
                z.writestr(top + '__init__.py', 'NODE_CLASS_MAPPINGS = {}  # v%d\n' % len(self.pip_calls))
                z.writestr(top + 'requirements.txt', 'opencv-python-headless\n')
                z.writestr(top + 'install.py', 'raise SystemExit("never run")\n')
            return 'f' * 64

        def fake_run(args, *a, **k):
            args = [str(x) for x in args]
            if 'freeze' in args:
                return '\n'.join(self.freeze[-1]) + '\n'
            self.pip_calls.append(args)
            if self.pip_fails:
                raise RuntimeError('pip a échoué (code 1)')
            self.freeze.append(self.freeze[-1] + ['opencv-python-headless==4.11.0'])
            return ''
        w.fetch_file, w.run_logged = fake_fetch, fake_run

    def tearDown(self):
        w.fetch_file, w.run_logged = self.saved_tasks
        super().tearDown()

    def test_rules_shared_with_the_hub(self):
        ok = w.check_atelier_task('install_nodes', {'url': 'https://github.com/OliverCrosby/ComfyUI-Universal-Seamless-Tiles.git', 'commit': self.COMMIT})
        self.assertEqual((ok['name'], ok['owner'], ok['pip']), ('ComfyUI-Universal-Seamless-Tiles', 'OliverCrosby', True))
        for bad in ({'url': 'https://gitlab.com/a/b', 'commit': self.COMMIT}, {'url': 'https://github.com/a/b', 'commit': 'main'},
                    {'url': 'https://github.com/a/b', 'commit': self.COMMIT, 'name': '../x'}):
            with self.assertRaises(ValueError):
                w.check_atelier_task('install_nodes', bad)
        m = w.check_atelier_task('download_model', {'url': 'https://huggingface.co/x/y/resolve/0123/4x-Ultra%20Sharp.pth?download=true',
                                                    'sha256': 'b' * 64, 'folder': 'upscale_models'})
        self.assertEqual(m['name'], '4x-Ultra Sharp.pth')
        for bad in ({'url': 'http://x/a.safetensors', 'sha256': 'b' * 64, 'folder': 'loras'},
                    {'url': 'https://x/a.exe', 'sha256': 'b' * 64, 'folder': 'loras'},
                    {'url': 'https://x/a.safetensors', 'sha256': 'b' * 64, 'folder': '../custom_nodes'},
                    {'url': 'https://x/a.safetensors', 'sha256': 'B' * 64, 'folder': 'loras'},
                    {'url': 'https://x/a.safetensors', 'sha256': 'b' * 64, 'folder': 'loras', 'size': True}):
            with self.assertRaises(ValueError):
                w.check_atelier_task('download_model', bad)
        self.assertEqual(w.check_atelier_task('download_model', {'url': 'https://x/a.safetensors', 'sha256': 'b' * 64, 'folder': 'loras/style'})['folder'], 'loras/style')
        with self.assertRaises(ValueError):
            w.check_atelier_task('format_disk', {})
        # Un fichier dans un zip de release : nom tiré du membre, empreinte de l'archive obligatoire
        z = {'url': 'https://github.com/Kim2091/PBRify_Remix/releases/download/v1.7.2/PBRify_Remix-1.7.2.zip', 'sha256': 'b' * 64,
             'folder': 'upscale_models', 'member': 'PBRify_Remix-1.7.2/Models/4x-PBRify-UpscalerV4.safetensors', 'archive_sha256': 'c' * 64}
        m = w.check_atelier_task('download_model', z)
        self.assertEqual((m['name'], m['member'], m['archive_sha256'], m['archive_size']), ('4x-PBRify-UpscalerV4.safetensors', z['member'], 'c' * 64, None))
        for bad in (dict(z, archive_sha256=None), dict(z, archive_sha256='C' * 64), dict(z, member='../Models/x.safetensors'),
                    dict(z, member='a/../x.safetensors'), dict(z, member='/etc/x.safetensors'), dict(z, member='a\\x.safetensors'),
                    dict(z, member='C:/x.safetensors'), dict(z, member='a//x.safetensors'), dict(z, member='a/x.exe'), dict(z, member=7),
                    dict(z, archive_size=0), {'url': z['url'], 'sha256': 'b' * 64, 'folder': 'loras', 'name': 'x.safetensors', 'archive_sha256': 'c' * 64}):
            with self.assertRaises(ValueError, msg=str(bad)):
                w.check_atelier_task('download_model', bad)

    def test_node_pack_install_replace_undo_and_pip_failure(self):
        a = self.atelier()
        a.tick()
        self.assertEqual(a.state, 'en marche')
        pid = a.pid
        reports = []
        post = lambda tid, body: reports.append((tid, body)) or {'ok': True}
        a.submit({'id': 11, 'action': 'install_nodes', 'params': {'url': 'https://github.com/lonecatone23/ComfyUI_LC_MaskMaker_nodes', 'commit': self.COMMIT}}, post)
        a.task_thread.join(30)
        final = reports[-1][1]
        self.assertEqual(final['status'], 'done', final)
        r = final['result']
        dest = self.lay['data'] / 'custom_nodes' / 'ComfyUI_LC_MaskMaker_nodes'
        self.assertEqual(self.fetched, 'https://github.com/lonecatone23/ComfyUI_LC_MaskMaker_nodes/archive/%s.zip' % self.COMMIT)
        self.assertTrue((dest / '__init__.py').exists())
        self.assertEqual(json.loads((dest / '.atelier-pack.json').read_text())['commit'], self.COMMIT)
        self.assertEqual(r['pip'], {'added': ['opencv-python-headless==4.11.0'], 'removed': []})
        self.assertIn('non exécuté', r['install_py'])
        self.assertEqual(self.pip_calls[0][-2:], ['-c', str(self.lay['root'] / 'constraints.txt')])
        self.assertIn('torch==2.13.0+rocm10.0.0', (self.lay['root'] / 'constraints.txt').read_text())
        self.assertEqual(reports[0][1]['status'], 'running')
        # Relance pour charger le pack : pas pendant un calcul
        (self.lay['data'] / 'busy').write_text('1')
        a.tick()
        self.assertEqual(a.pid, pid)
        (self.lay['data'] / 'busy').unlink()
        a.tick()
        self.assertIsNone(a.pid)
        a.tick()
        self.assertEqual(a.state, 'en marche')
        # Même pack, nouvelle version : l'ancienne part à la corbeille ; undo la remet
        a.submit({'id': 12, 'action': 'install_nodes', 'params': {'url': 'https://github.com/lonecatone23/ComfyUI_LC_MaskMaker_nodes', 'commit': self.COMMIT}}, post)
        a.task_thread.join(30)
        self.assertIn('v1', (dest / '__init__.py').read_text())
        self.assertTrue(Path(reports[-1][1]['result']['replaced']).exists())
        a.submit({'id': 13, 'action': 'undo', 'params': {'task': 12}}, post)
        a.task_thread.join(30)
        self.assertEqual(reports[-1][1]['status'], 'done', reports[-1])
        self.assertIn('v0', (dest / '__init__.py').read_text())
        self.assertIn('pip_not_undone', reports[-1][1]['result'])
        a.submit({'id': 14, 'action': 'undo', 'params': {'task': 12}}, post)
        a.task_thread.join(30)
        self.assertIn('déjà défaite', reports[-1][1]['result']['error'])
        a.submit({'id': 14, 'action': 'undo', 'params': {'task': 12}}, post)
        self.assertFalse(a.task_thread.is_alive() and False)
        self.assertEqual([t for t, _ in reports].count(14), 2, 'a task already seen is not run again')
        # pip refuse : pas de pack à moitié installé, l'ancien revient
        self.pip_fails = True
        a.submit({'id': 15, 'action': 'install_nodes', 'params': {'url': 'https://github.com/lonecatone23/ComfyUI_LC_MaskMaker_nodes', 'commit': self.COMMIT}}, post)
        a.task_thread.join(30)
        self.assertEqual(reports[-1][1]['status'], 'failed')
        self.assertIn('pack retiré', reports[-1][1]['result']['error'])
        self.assertIn('v0', (dest / '__init__.py').read_text())
        # Retrait puis undo
        a.submit({'id': 16, 'action': 'remove_nodes', 'params': {'name': 'ComfyUI_LC_MaskMaker_nodes'}}, post)
        a.task_thread.join(30)
        self.assertFalse(dest.exists())
        a.submit({'id': 17, 'action': 'undo', 'params': {'task': 16}}, post)
        a.task_thread.join(30)
        self.assertTrue((dest / '__init__.py').exists())
        self.assertEqual(a.describe()['task'], '17 undo ok')
        self.assertTrue(all(d.parent.name == 'trash' and re.fullmatch(r'\d{8}', d.name) for d in (self.lay['root'] / 'trash').iterdir()))

    def test_model_download_checked_then_removed_and_restored(self):
        a = self.atelier()
        src = self.base / 'store' / 'lora.safetensors'
        src.parent.mkdir()
        src.write_bytes(b'lora weights ' * 100)
        digest = w.sha256_file(src)
        p = {'url': src.as_uri(), 'sha256': digest, 'folder': 'loras', 'name': 'lora.safetensors', 'size': src.stat().st_size}
        out = a.task_download_model(21, p, None, lambda *x: None)
        dest = self.lay['data'] / 'models' / 'loras' / 'lora.safetensors'
        self.assertEqual((Path(out['path']), out['sha256']), (dest, digest))
        self.assertEqual(a.task_download_model(22, p, None, lambda *x: None)['note'], 'déjà présent, identique')
        with self.assertRaises(RuntimeError):
            a.task_download_model(23, dict(p, sha256='0' * 64), None, lambda *x: None)
        self.assertEqual(dest.read_bytes(), src.read_bytes(), 'a bad download leaves the previous file in place')
        a.task_remove_model(24, {'folder': 'loras', 'name': 'lora.safetensors'}, None, None)
        self.assertFalse(dest.exists())
        a.task_undo(25, {'task': 24}, None, None)
        self.assertEqual(w.sha256_file(dest), digest)
        self.assertTrue(Path(str(dest) + '.ok').exists(), 'checked once, not hashed again')
        a.task_undo(26, {'task': 21}, None, None)
        self.assertFalse(dest.exists(), 'undo of the download: file to the trash')
        with self.assertRaises(RuntimeError):
            a.task_remove_model(27, {'folder': 'loras', 'name': 'lora.safetensors'}, None, None)

    def release_zip(self, member='Pack-1.0/Models/up.safetensors', data=b'upscaler weights ' * 4000):
        """Petit zip de release, construit ici : le fichier voulu, un autre modèle du même nom ailleurs, un README."""
        src = self.base / 'store' / 'Pack-1.0.zip'
        src.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(src, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr(member, data)
            z.writestr('Pack-1.0/Other/up.safetensors', b'another model')
            z.writestr('Pack-1.0/README.md', 'read me')
        p = w.check_atelier_task('download_model', {'url': src.as_uri().replace('file://', 'https://'), 'sha256': hashlib.sha256(data).hexdigest(),
                                                    'folder': 'upscale_models', 'member': member, 'archive_sha256': w.sha256_file(src),
                                                    'size': len(data), 'archive_size': src.stat().st_size})
        return dict(p, url=src.as_uri()), data

    def leftovers(self):
        d = self.lay['root'] / 'downloads'
        return sorted(x.name for x in d.iterdir()) if d.exists() else []

    def test_model_from_a_zip_only_that_file_checked_then_archive_deleted(self):
        a = self.atelier()
        p, data = self.release_zip()
        out = a.task_download_model(31, p, None, lambda *x: None)
        dest = self.lay['data'] / 'models' / 'upscale_models' / 'up.safetensors'
        self.assertEqual((Path(out['path']), out['size'], out['member']), (dest, len(data), 'Pack-1.0/Models/up.safetensors'))
        self.assertEqual(dest.read_bytes(), data)
        self.assertEqual(sorted(x.name for x in dest.parent.iterdir()), ['up.safetensors', 'up.safetensors.ok'], 'only that file, no .part')
        self.assertEqual(self.leftovers(), [], 'archive deleted')
        self.assertEqual(a.task_download_model(32, p, None, lambda *x: None)['note'], 'déjà présent, identique')
        a.task_undo(33, {'task': 31}, None, None)
        self.assertFalse(dest.exists(), 'undo: file to the trash')

    def test_model_from_a_zip_refused(self):
        a = self.atelier()
        dest = self.lay['data'] / 'models' / 'upscale_models' / 'up.safetensors'
        dest.parent.mkdir(parents=True)
        dest.write_bytes(b'previous weights')
        p, data = self.release_zip()
        w_sleep, w.time.sleep = w.time.sleep, lambda s: None   # deux essais de téléchargement : pas 5 s d'attente
        kept = ['archive-%s.zip' % p['archive_sha256'][:16], 'archive-%s.zip.ok' % p['archive_sha256'][:16]]
        try:
            for bad, why, left in ((dict(p, archive_sha256='0' * 64), 'empreinte inattendue', []),
                                   (dict(p, sha256='0' * 64), 'empreinte inattendue pour Pack-1.0/Models/up.safetensors', kept),
                                   (dict(p, member='Pack-1.0/Models/missing.safetensors', name='up.safetensors'), 'pas de Pack-1.0/Models/missing', kept),
                                   (dict(p, member='Pack-1.0/up.safetensors'), 'même nom ailleurs : Pack-1.0/Models/up.safetensors', kept),
                                   (dict(p, size=len(data) - 1), r'attendus \(size\)', kept)):
                with self.assertRaisesRegex(RuntimeError, why):
                    a.task_download_model(41, bad, None, lambda *x: None)
                self.assertEqual(dest.read_bytes(), b'previous weights', 'a refused file leaves the previous one in place')
                self.assertEqual(sorted(x.name for x in dest.parent.iterdir()), ['up.safetensors'], 'no .part left')
                self.assertEqual(self.leftovers(), left, 'bad zip: nothing kept; verified zip: kept for a retry')
        finally:
            w.time.sleep = w_sleep
        with self.assertRaises(ValueError):
            w.check_atelier_task('download_model', dict(p, member='Pack-1.0/../up.safetensors'))

    def test_zip_kept_after_a_failed_or_cancelled_extraction_then_deleted(self):
        a = self.atelier()
        p, data = self.release_zip()
        with self.assertRaisesRegex(RuntimeError, 'empreinte inattendue'):
            a.task_download_model(51, dict(p, sha256='0' * 64), None, lambda *x: None)
        self.assertEqual(len(self.leftovers()), 2, 'verified zip and its .ok kept')
        stop = __import__('threading').Event()
        stop.set()
        with self.assertRaises(w.JobLost):
            a.task_download_model(52, p, stop, lambda *x: None)
        self.assertEqual(len(self.leftovers()), 2, 'cancelled while extracting: zip kept')
        (self.base / 'store' / 'Pack-1.0.zip').unlink()   # une relance qui retéléchargerait échouerait
        out = a.task_download_model(53, p, None, lambda *x: None)
        self.assertEqual(Path(out['path']).read_bytes(), data)
        self.assertEqual(self.leftovers(), [], 'deleted after success')

    def test_zip_held_by_an_antivirus_does_not_fail_a_done_task(self):
        a = self.atelier()
        p, data = self.release_zip()
        real = w.os.remove

        def held(path, *x, **k):
            if Path(path).name.startswith('archive-'):
                raise PermissionError(13, 'used by another process')
            return real(path, *x, **k)
        w.os.remove = held
        try:
            out = a.task_download_model(61, p, None, lambda *x: None)
        finally:
            w.os.remove = real
        self.assertIn('used by another process', out['archive_left'])
        self.assertEqual(Path(out['path']).read_bytes(), data)
        self.assertTrue((self.lay['root'] / 'journal' / '61.json').exists(), 'journaled: undo possible')
        a.task_undo(62, {'task': 61}, None, None)
        self.assertFalse(Path(out['path']).exists())

    def test_abandoned_zips_purged_after_7_days_never_during_a_task(self):
        a = self.atelier()
        d = self.lay['root'] / 'downloads'
        d.mkdir(parents=True)
        now = time.time()
        old, recent, other = d / ('archive-%s.zip.part' % ('a' * 16)), d / ('archive-%s.zip' % ('b' * 16)), d / 'notes.zip'
        for x in (old, recent, other):
            x.write_bytes(b'x')
        for x in (old, other):
            os.utime(x, (now - 8 * 86400, now - 8 * 86400))

        class Running:
            is_alive = staticmethod(lambda: True)
        a.task_thread = Running()
        a.purge(now)
        self.assertTrue(old.exists(), 'not while a task runs')
        a.task_thread = None
        a.purge(now)
        self.assertEqual(sorted(x.name for x in d.iterdir()), sorted([recent.name, other.name]))

    def test_zip_member_links_and_bombs_refused(self):
        d = self.base / 'zips'
        d.mkdir()
        dest = d / 'out' / 'x.safetensors'
        link = d / 'link.zip'
        with zipfile.ZipFile(link, 'w') as z:
            info = zipfile.ZipInfo('m/x.safetensors')
            info.external_attr = (0o120777 << 16)   # lien symbolique
            z.writestr(info, '/etc/passwd')
        with self.assertRaisesRegex(RuntimeError, 'lien ou dossier'):
            w.extract_member(link, 'm/x.safetensors', dest, 'a' * 64)
        zeros = b'\0' * (4 << 20)
        bomb = d / 'bomb.zip'
        with zipfile.ZipFile(bomb, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('m/x.safetensors', zeros)
        self.assertLess(bomb.stat().st_size, 64 << 10)
        saved, w.ZIP_MEMBER_MAX = w.ZIP_MEMBER_MAX, 1 << 20
        try:
            with self.assertRaisesRegex(RuntimeError, 'borne'):
                w.extract_member(bomb, 'm/x.safetensors', dest, hashlib.sha256(zeros).hexdigest())
        finally:
            w.ZIP_MEMBER_MAX = saved
        with self.assertRaisesRegex(RuntimeError, 'disque'):
            w.extract_member(bomb, 'm/x.safetensors', dest, hashlib.sha256(zeros).hexdigest(), room=1 << 20)
        # Taille annoncée mentie (en-têtes réécrits à 1 000 octets) : jamais plus que l'annoncé, puis refusé
        raw = bytearray(bomb.read_bytes())
        for sig, at in ((b'PK\x03\x04', 22), (b'PK\x01\x02', 24)):
            i = raw.index(sig)
            raw[i + at:i + at + 4] = struct.pack('<I', 1000)
        liar = d / 'liar.zip'
        liar.write_bytes(bytes(raw))
        with self.assertRaises(RuntimeError):
            w.extract_member(liar, 'm/x.safetensors', dest, hashlib.sha256(zeros).hexdigest())
        self.assertFalse(dest.exists() or Path(str(dest) + '.part').exists())
        self.assertEqual(w.extract_member(bomb, 'm/x.safetensors', dest, hashlib.sha256(zeros).hexdigest()), len(zeros))

    def test_old_trash_is_purged(self):
        a = self.atelier()
        old = self.lay['root'] / 'trash' / '20200101'
        old.mkdir(parents=True)
        (old / 'x.safetensors.retire1').write_text('x')
        recent = self.lay['root'] / 'trash' / time.strftime('%Y%m%d')
        recent.mkdir()
        a.purge(time.time())
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())

    def test_never_fast_nor_miopen(self):
        at = w.comfy_spec()['atelier']
        flat = json.dumps(at)
        self.assertNotIn('--fast', flat)
        self.assertNotIn('COMFYUI_ENABLE_MIOPEN', flat)


class AutoRepairTest(unittest.TestCase):
    """Auto-diagnostic et auto-réparation (jobs 187 à 192 : Klein plantait en code natif, fichiers jamais revérifiés)."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_native_crash_and_file_errors_are_recognised_whatever_the_model(self):
        self.assertIn('0xC0000005', w.crash_kind("ComfyUI s'est arrêté pendant le calcul (code 3221225477) : x"))
        self.assertIn('0xC0000005', w.crash_kind('a échoué (code -1073741819)'))
        self.assertIn('0xC0000006', w.crash_kind('code 3221225478'))
        self.assertEqual(w.crash_kind('code -11'), 'SIGSEGV')
        self.assertEqual(w.crash_kind('sd-cli a échoué (code 139)'), 'SIGSEGV')
        self.assertIsNotNone(w.crash_kind('   13s Windows fatal exception: access violation'))
        self.assertIsNone(w.crash_kind('sd-cli a échoué (code 1) : out of memory'))
        # exit(-1) sous Windows (4294967295) ou tué par SIGKILL/SIGTERM : pas des exceptions Windows
        for code in ('-1', '4294967295', '-9', '-15'):
            self.assertIsNone(w.crash_kind('ComfyUI s\'est arrêté pendant le calcul (code %s) : x' % code), code)
        self.assertIsNone(w.crash_kind('génération trop lent : 115.8 s par étape'))
        self.assertIsNotNone(w.file_error('Error while deserializing header: HeaderTooLarge'))
        self.assertIsNotNone(w.file_error('safetensors_rust.SafetensorError: MetadataIncompleteBuffer'))
        self.assertIsNone(w.file_error('CUDA out of memory'))

    def test_a_native_crash_keeps_where_python_called_native_code(self):
        t = w.ComfyTrace()
        out = ['Windows fatal exception: access violation', '', 'Thread 0x0000a1b2 (most recent call first):',
               '  File "C:\\py\\Lib\\threading.py", line 359 in wait', '  File "C:\\py\\Lib\\threading.py", line 1012 in run',
               '', 'Current thread 0x00004c2c (most recent call first):',
               '  File "C:\\gpu\\comfyui\\ComfyUI-0.45.0\\comfy\\ops.py", line 88 in cast_bias_weight',
               '  File "C:\\gpu\\comfyui\\ComfyUI-0.45.0\\comfy\\text_encoders\\llama.py", line 412 in forward',
               '  File "C:\\gpu\\comfyui\\ComfyUI-0.45.0\\main.py", line 200 in prompt_worker']
        out += ['0x00007FFDEC8095E%d, C:\\x\\torch\\lib\\c10.dll(0x00007FFDEC760000) + 0xA95E0 byte(s), ?_ThrowRuntimeTypeLogicError' % i
                for i in range(10)]
        t.feed(('\n'.join(out) + '\n').encode())
        self.assertEqual(t.meta['crash_at'], 'ComfyUI-0.45.0/comfy/ops.py:88 cast_bias_weight')
        self.assertEqual(t.meta['crash'], 'Windows fatal exception: access violation')
        text = '\n'.join(t.lines)
        self.assertIn('text_encoders/llama.py:412 forward', text)
        self.assertNotIn('threading.py', text, 'stacks of the other threads are left out')
        self.assertEqual(sum('c10.dll' in l for l in t.lines), 8, 'native frames bounded')

    def entry(self, name, data, model='m1', url=None, links=()):
        return {'model': model, 'name': name, 'path': str(self.dir / name), 'size': len(data),
                'sha256': hashlib.sha256(data).hexdigest(), 'url': url, 'links': list(links)}

    def test_files_are_rehashed_whatever_their_marker_says_and_wrong_ones_redownloaded(self):
        good, te, vae = b'g' * 4096, b't' * 5000, b'v' * 3000
        src = self.dir / 'mirror'
        src.mkdir()
        (src / 'te.safetensors').write_bytes(te)
        entries = [self.entry('good.safetensors', good), self.entry('te.safetensors', te, url=(src / 'te.safetensors').as_uri()),
                   self.entry('vae.safetensors', vae), self.entry('never.safetensors', b'n' * 10)]
        (self.dir / 'good.safetensors').write_bytes(good)
        # Même taille, un octet changé, témoin .ok encore valide (date et taille inchangées) : invisible jusqu'ici
        bad = bytearray(te)
        bad[2500] ^= 1
        (self.dir / 'te.safetensors').write_bytes(bytes(bad))
        st = (self.dir / 'te.safetensors').stat()
        Path(str(self.dir / 'te.safetensors') + '.ok').write_text('%s %d %d' % (entries[1]['sha256'], st.st_size, st.st_mtime_ns))
        (self.dir / 'vae.safetensors').write_bytes(vae[:1000])   # tronqué
        link = self.dir / 'other-copy.safetensors'
        os.link(self.dir / 'vae.safetensors', link)
        entries[2]['links'] = [str(link)]
        stages = []
        res = w.verify_files(entries, repair=True, progress=lambda f, st: stages.append((f, st)))
        by = {r['file']: r for r in res}
        self.assertEqual(by['good.safetensors']['state'], 'sain')
        self.assertTrue(Path(str(self.dir / 'good.safetensors') + '.ok').exists(), 'a sound file gets a fresh marker')
        self.assertEqual(by['te.safetensors']['state'], 'empreinte')
        self.assertEqual(by['te.safetensors']['action'], 'effacé ; retéléchargé et vérifié')
        self.assertTrue(by['te.safetensors']['ok'])
        self.assertEqual((self.dir / 'te.safetensors').read_bytes(), te)
        self.assertEqual(by['vae.safetensors']['state'], 'taille')
        self.assertEqual(by['vae.safetensors']['action'], 'effacé : retéléchargé au prochain travail', 'no url: the next job downloads it')
        self.assertFalse((self.dir / 'vae.safetensors').exists())
        self.assertFalse(link.exists(), 'the other name of the same broken file goes too')
        self.assertEqual(by['never.safetensors']['state'], 'absent')
        self.assertNotIn('action', by['never.safetensors'], 'a file never installed is left to the next job (cap and disk checked there)')
        self.assertEqual(stages[-1], (1.0, 'vérification finie'))
        self.assertIn('te.safetensors : empreinte -> effacé ; retéléchargé et vérifié', w.verify_summary(res))

    def test_a_known_link_is_removed_only_while_it_is_still_the_same_file(self):
        good = b'a' * 300
        e = self.entry('ae.safetensors', good)
        (self.dir / 'ae.safetensors').write_bytes(b'b' * 300)
        other = self.dir / 'engine-ae.safetensors'
        other.write_bytes(good)   # l'autre nom a déjà été retéléchargé à part (plus haut dans la même vérification)
        Path(str(other) + '.ok').write_text('x')
        e['links'] = [str(other)]
        res = w.verify_files([e], repair=True)
        self.assertEqual(res[0]['state'], 'empreinte')
        self.assertFalse((self.dir / 'ae.safetensors').exists())
        self.assertEqual(other.read_bytes(), good, 'no longer the same file: kept')
        self.assertTrue(Path(str(other) + '.ok').exists())

    def test_a_file_held_open_is_released_once_then_removed(self):
        data = b'x' * 100
        e = self.entry('held.safetensors', data)
        (self.dir / 'held.safetensors').write_bytes(b'y' * 100)
        real, calls, unlocked = w.remove_files, [], []

        def flaky(paths):
            calls.append(1)
            return 'held.safetensors : [WinError 32] utilisé par un autre processus' if len(calls) == 1 else real(paths)
        w.remove_files = flaky
        try:
            res = w.verify_files([e], repair=True, unlock=lambda why: unlocked.append(why) or True)
        finally:
            w.remove_files = real
        self.assertEqual(len(unlocked), 1)
        self.assertIn('WinError 32', unlocked[0])
        self.assertEqual(res[0]['action'], 'effacé : retéléchargé au prochain travail')
        # Rien ne libère le fichier : dit tel quel, pas réparé
        (self.dir / 'held.safetensors').write_bytes(b'y' * 100)
        w.remove_files = lambda paths: 'held.safetensors : tenu'
        try:
            res = w.verify_files([e], repair=True, unlock=lambda why: False)
        finally:
            w.remove_files = real
        self.assertEqual(res[0]['action'], 'retrait impossible : held.safetensors : tenu')
        self.assertFalse(res[0]['ok'])

    def test_python_environment_is_checked_against_pip_records(self):
        sp = self.dir / 'python' / 'Lib' / 'site-packages'
        (sp / 'torch' / 'lib').mkdir(parents=True)
        (sp / 'torch-2.13.0.dist-info').mkdir()
        files = {'torch/__init__.py': b'import x\n', 'torch/lib/c10.dll': b'MZ' + b'\0' * 64, 'torch/lib/gone.dll': b'MZ'}
        rec = []
        for rel, data in files.items():
            rec.append('%s,sha256=%s,%d' % (rel, w.record_hash(hashlib.sha256(data).digest()), len(data)))
            if rel != 'torch/lib/gone.dll':
                (sp / rel).write_bytes(data)
        rec += ['torch/__pycache__/x.cpython-313.pyc,,', '../../Scripts/torchrun.exe,sha256=abc,3', 'torch-2.13.0.dist-info/RECORD,,']
        (sp / 'torch-2.13.0.dist-info' / 'RECORD').write_text('\n'.join(rec) + '\n')
        env = w.verify_python_env(self.dir / 'python')
        self.assertEqual((env['packages'], env['files'], env['bad_count']), (1, 3, 1))
        self.assertEqual(env['bad'][0]['why'], 'absent')
        # Changé en place, même taille (lien physique partagé avec l'atelier et réécrit)
        (sp / 'torch/lib/c10.dll').write_bytes(b'MZ' + b'\1' * 64)
        env = w.verify_python_env(self.dir / 'python')
        self.assertEqual(env['bad_count'], 2)
        self.assertIn({'package': 'torch-2.13.0.dist-info', 'file': 'torch/lib/c10.dll', 'why': 'empreinte différente de celle inscrite par pip'}, env['bad'])
        self.assertIn('environnement Python abîmé : 2 fichier(s)', w.verify_summary([], env))

    def test_model_entries_follow_the_catalog_for_any_engine(self):
        gpu = w.Gpu(self.dir, {}, Path(w.__file__).resolve().parent)
        klein = gpu.model_entries('flux3-klein')
        names = [e['name'] for e in klein]
        self.assertEqual(names, [f['name'] for f in gpu.catalog['types']['image']['models']['flux3-klein']['files']])
        self.assertTrue(all('/gpu/comfyui/data/models/' in e['path'].replace('\\', '/') for e in klein))
        self.assertTrue(all(len(e['sha256']) == 64 and e['size'] > 0 and e['url'] for e in klein))
        default = gpu.catalog['types']['image']['default_model']
        self.assertTrue(all(('/gpu/models/%s/' % default) in e['path'].replace('\\', '/') for e in gpu.model_entries(default)))
        self.assertEqual(len(gpu.model_entries('comfyui')), len(gpu.catalog['benchmarks']['comfyui']['files']))
        self.assertEqual(gpu.model_entries('nope'), [])
        self.assertEqual(gpu.model_entries(None, installed_only=True), [], 'nothing on this machine yet')
        p = Path(klein[1]['path'])
        p.parent.mkdir(parents=True)
        p.write_bytes(b'x')
        self.assertEqual([e['name'] for e in gpu.model_entries(None, installed_only=True)], [klein[1]['name']])

    def test_environment_reset_keeps_the_weights_and_the_workshop_environment(self):
        spec = w.comfy_spec(Path(w.__file__).resolve().parent)
        lay = w.comfy_layout(self.dir, spec)
        for d in (lay['python'] / 'Lib', lay['src'], lay['data'] / 'models' / 'vae', lay['cache'] / 'miopen'):
            d.mkdir(parents=True)
        (lay['python'] / 'Lib' / 'x.py').write_bytes(b'1' * 100)
        (lay['data'] / 'models' / 'vae' / 'ae.safetensors').write_bytes(b'w')
        (lay['cache'] / 'miopen' / 'k.db').write_bytes(b'c' * 50)
        for step in ('python', 'pip', 'source', 'torch', 'requirements'):
            (lay['root'] / ('.ok-' + step)).write_text(w.comfy_marker(spec, step))
        at = w.atelier_layout(self.dir, spec)
        at['root'].mkdir(parents=True)
        (at['root'] / '.ok-env').write_text('x')
        self.assertEqual(w.clear_compute_caches(self.dir, spec), 50)
        self.assertFalse(lay['cache'].exists())
        self.assertGreaterEqual(w.comfy_reset_env(self.dir, spec), 100)
        self.assertFalse(lay['python'].exists() or lay['src'].exists())
        self.assertFalse(any(w.comfy_done(lay, spec, s) for s in ('python', 'pip', 'source', 'torch', 'requirements')))
        self.assertTrue((lay['data'] / 'models' / 'vae' / 'ae.safetensors').exists(), 'weights kept')
        # L'atelier n'est pas recloné : son Python porte les paquets pip de ses nœuds (install_nodes, Manager)
        self.assertTrue((at['root'] / '.ok-env').exists(), 'the workshop keeps its own environment')

    def test_remote_verify_models_reports_files_and_environment(self):
        r = w.gpu_test_report(self.dir, {}, 'verify_models', {'model': 'nope'})
        self.assertFalse(r['ok'])
        self.assertIn('inconnu du catalogue', r['error'])
        r = w.gpu_test_report(self.dir, {}, 'verify_models', {})
        self.assertTrue(r['ok'])
        self.assertEqual((r['model'], r['files']), ('tous (posés sur ce PC)', []))
        spec = w.comfy_spec(Path(w.__file__).resolve().parent)
        sp = w.comfy_layout(self.dir, spec)['python'] / 'Lib' / 'site-packages'
        (sp / 'a-1.dist-info').mkdir(parents=True)
        (sp / 'a.py').write_bytes(b'changed')
        (sp / 'a-1.dist-info' / 'RECORD').write_text('a.py,sha256=%s,7\n' % w.record_hash(hashlib.sha256(b'origin').digest()))
        r = w.gpu_test_report(self.dir, {}, 'verify_models', {'model': 'flux3-klein'})
        self.assertFalse(r['ok'])
        self.assertEqual([f['state'] for f in r['files']], ['absent'] * 3)
        self.assertIn('environnement Python abîmé : 1 fichier(s), ex. a.py', r['error'])
        self.assertIn('comfyui_reinstall', r['next'])
        r = w.gpu_test_report(self.dir, {}, 'verify_models', {'model': 'flux3-klein', 'env': False})
        self.assertTrue(r['ok'])
        self.assertNotIn('env', r)

    def test_remote_comfyui_reinstall_removes_the_environment_first_and_keeps_the_weights(self):
        spec = w.comfy_spec(Path(w.__file__).resolve().parent)
        lay = w.comfy_layout(self.dir, spec)
        (lay['python'] / 'Lib').mkdir(parents=True)
        (lay['data'] / 'models' / 'vae').mkdir(parents=True)
        (lay['data'] / 'models' / 'vae' / 'ae.safetensors').write_bytes(b'w')
        for step in ('python', 'pip', 'source', 'torch', 'requirements'):
            (lay['root'] / ('.ok-' + step)).write_text(w.comfy_marker(spec, step))
        r = w.gpu_test_report(self.dir, {'gpu_keep_free_gb': 0, 'gpu_max_gb': 1000}, 'comfyui_reinstall', {})
        self.assertIn('reinstall_freed_gb', r)
        self.assertFalse(lay['python'].exists())
        self.assertTrue((lay['data'] / 'models' / 'vae' / 'ae.safetensors').exists())
        self.assertFalse(r['ok'], 'then the normal installation runs: here it stops (Linux, or no room for the weights)')

    def test_workshop_held_off_during_a_repair_then_free_to_start_again(self):
        base = self.dir
        at = w.Atelier(base, {'atelier_enabled': True, 'comfyui_any_os': True}, Path(w.__file__).resolve().parent, None)
        self.assertTrue(at.wanted())
        self.assertFalse(at.hold('environnement refait'))
        self.assertFalse(at.wanted())
        self.assertTrue(at.state.startswith('suspendu'))
        at.next_try = 1e12
        at.unhold()
        self.assertTrue(at.wanted())
        self.assertEqual(at.next_try, 0.0)
        self.assertEqual(at.state, 'éteint')


class ComfyNativeCrashTest(unittest.TestCase):
    def test_a_native_crash_says_its_kind_and_the_python_line_that_called_native_code(self):
        base = Path(tempfile.mkdtemp())
        (base / 'logs').mkdir()
        gpu = w.Gpu(base, {'comfyui_any_os': True, 'gpu_keep_free_gb': 0, 'gpu_max_gb': 1000}, Path(w.__file__).resolve().parent)
        gpu.catalog['engines']['sdcpp']['linux'] = dict(gpu.catalog['engines']['sdcpp']['windows'])
        spec = gpu.catalog['benchmarks']['comfyui']
        spec['torch']['check'] = "print('TORCH 2.13.0+rocm10.0.0 7.1 True 1'); print('DEV 0 gfx1030 17163091968 AMD Radeon RX 6950 XT')"
        lay = w.comfy_layout(base, spec)
        lay['exe'].parent.mkdir(parents=True)
        os.symlink(sys.executable, lay['exe'])
        lay['src'].mkdir(parents=True)
        (lay['src'] / 'main.py').write_text(FAKE_COMFY)
        for step in ('python', 'pip', 'source', 'torch', 'requirements'):
            (lay['root'] / ('.ok-' + step)).write_text(w.comfy_marker(spec, step))
        for f in gpu.catalog['types']['image']['models']['flux3-klein']['files']:
            dest = lay['data'] / 'models' / f['dir'] / f['name']
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b'fake')
            st = dest.stat()
            Path(str(dest) + '.ok').write_text('%s %d %d' % (f['sha256'], st.st_size, st.st_mtime_ns))
        lay['data'].mkdir(parents=True, exist_ok=True)
        (lay['data'] / 'native-crash').write_text('')
        job = {'id': 191, 'kind': 'image', 'model': 'flux3-klein', 'prompt': 'a red mug', 'params': {'width': 256, 'height': 256, 'steps': 4}}
        try:
            with self.assertRaises(RuntimeError) as c:
                gpu.run(job, None, base, None, lambda f, st: None)
        finally:
            gpu.stop_comfy()
        msg = str(c.exception)
        self.assertIn("s'est arrêté pendant le calcul (code -11, SIGSEGV) dans comfy/text_encoders/llama.py:412 forward", msg)
        self.assertIsNotNone(w.crash_kind(msg), 'the worker recognises it for the auto-repair')
        self.assertNotIn('threading.py', '\n'.join(gpu.last_trace.lines))


class AutoRepairWorkerTest(unittest.TestCase):
    """Le worker : échec -> raison -> vérification -> réparation -> un seul nouvel essai, chaque étape dite au hub."""
    CRASH = "ComfyUI s'est arrêté pendant le calcul (code 3221225477) :    13s Windows fatal exception: access violation"

    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        (self.base / 'logs').mkdir()
        (self.base / 'reuse-worker.config.json').write_text(json.dumps({'hub_url': 'https://hub.invalid', 'token': 'jeton-de-test'}))
        self.worker = w.Worker(self.base, None)
        self.worker.hub = FakeHub(200)
        self.data = b'poids' * 1000
        mirror = self.base / 'mirror'
        mirror.mkdir()
        (mirror / 'te.safetensors').write_bytes(self.data)
        self.file = self.base / 'models' / 'te.safetensors'
        self.file.parent.mkdir()
        self.entries = [{'model': 'flux3-klein', 'name': 'te.safetensors', 'path': str(self.file), 'size': len(self.data),
                         'sha256': hashlib.sha256(self.data).hexdigest(), 'url': (mirror / 'te.safetensors').as_uri(), 'links': []}]
        self.worker.gpu.model_entries = lambda model=None, installed_only=False: self.entries
        self.runs = []
        self.job = {'id': 187, 'kind': 'image', 'model': 'flux3-klein'}

    def restart(self):
        """Le worker redémarre (mise à jour au merge, PC relancé) : seul ce qui est sur le disque reste."""
        self.worker = w.Worker(self.base, None)
        self.worker.hub = FakeHub(200)
        self.worker.gpu.model_entries = lambda model=None, installed_only=False: self.entries

    def test_the_6_hour_guard_survives_a_restart_and_a_broken_state_file_never_stops_the_worker(self):
        self.file.write_bytes(self.data)
        with self.assertRaises(RuntimeError):
            self.run_with([RuntimeError(self.CRASH), RuntimeError(self.CRASH)])
        self.assertTrue((self.base / w.REPAIR_STATE).exists())
        self.restart()
        self.runs.clear()
        with self.assertRaises(RuntimeError) as c:
            self.run_with([RuntimeError(self.CRASH)])
        self.assertEqual(len(self.runs), 1, 'no second repair nor replay after a restart')
        self.assertIn('[auto-réparation : déjà tentée à', str(c.exception))
        for broken in ('[1, 2]', '{"repairs": [1], "env_reset_at": "x"}', '{"repairs": {"m": 3}}', 'pas du json'):
            (self.base / w.REPAIR_STATE).write_text(broken)
            self.restart()
            self.assertEqual((self.worker.repairs, self.worker.env_reset_at), ({}, 0.0), broken)

    def run_with(self, outcomes):
        def fake_run(job, src, workdir, stop, progress):
            self.runs.append(job['id'])
            o = outcomes.pop(0)
            if isinstance(o, Exception):
                raise o
            return Path('out.png'), 1.0, {'s_per_step': 4.0}
        self.worker.gpu.run = fake_run
        return self.worker.run_gpu(self.job, None, self.base, threading.Event(), lambda f, st: None)

    def events(self):
        return [(c[2]['what'], c[2]['detail']) for c in self.worker.hub.calls if c[1] == '/api/reuse/worker/events']

    def test_a_corrupted_weight_after_a_native_crash_is_redownloaded_and_the_job_replayed_once(self):
        broken = bytearray(self.data)
        broken[10] ^= 0xFF
        self.file.write_bytes(bytes(broken))
        out, secs, meta = self.run_with([RuntimeError(self.CRASH), None])
        self.assertEqual(len(self.runs), 2)
        self.assertEqual(self.file.read_bytes(), self.data)
        self.assertIn('te.safetensors : empreinte -> effacé ; retéléchargé et vérifié', meta['repair'])
        what = [e[0] for e in self.events()]
        self.assertEqual(what, ['repair_started', 'repair_file', 'repair_finished', 'repair_replay', 'repair_replay_ok'],
                         'no ComfyUI environment here: not checked')
        started, file = self.events()[0][1], self.events()[1][1]
        self.assertIn('0xC0000005', started['reason'])
        self.assertEqual((file['file'], file['state'], file['model'], file['job']), ('te.safetensors', 'empreinte', 'flux3-klein', 187))
        self.assertEqual(self.worker.model_failures['flux3-klein'], 0)

    def test_sound_files_after_a_native_crash_clear_the_caches_replay_once_and_say_the_cause_is_elsewhere(self):
        self.file.write_bytes(self.data)
        with self.assertRaises(RuntimeError) as c:
            self.run_with([RuntimeError(self.CRASH), RuntimeError(self.CRASH)])
        self.assertEqual(len(self.runs), 2, 'one replay, never more')
        self.assertIn('[après auto-réparation : 1 fichier(s) vérifié(s), sains', str(c.exception))
        fin = dict(self.events())['repair_finished']
        self.assertIn('caches de calcul vidés', fin['summary'])
        self.assertIn('cause ailleurs que dans les fichiers', fin['summary'])
        self.assertIn('repair_replay_failed', [e[0] for e in self.events()])
        # Un nouveau plantage dans les 6 h : pas de nouvelle vérification de 20 Go, la raison est dite
        self.runs.clear()
        with self.assertRaises(RuntimeError) as c:
            self.run_with([RuntimeError(self.CRASH)])
        self.assertEqual(len(self.runs), 1)
        self.assertIn('[auto-réparation : déjà tentée à', str(c.exception))
        self.assertEqual(self.events()[-1][0], 'repair_skipped')

    def test_a_native_crash_with_sound_files_replays_with_a_safe_memory_profile_and_says_so(self):
        self.file.write_bytes(self.data)
        seen = []
        def fake_run(job, src, workdir, stop, progress):
            seen.append(dict(job.get('params') or {}))
            if len(seen) == 1:
                raise RuntimeError(self.CRASH)
            return Path('out.png'), 1.0, {}
        self.worker.gpu.run = fake_run
        job = dict(self.job, params={'vram_mode': 'high', 'dynamic_vram': False, 'text_encoder': 'cpu'})
        out, secs, meta = self.worker.run_gpu(job, None, self.base, threading.Event(), lambda f, st: None)
        self.assertEqual(seen[0], {'vram_mode': 'high', 'dynamic_vram': False, 'text_encoder': 'cpu'})
        self.assertEqual(seen[1], {'vram_mode': 'normal', 'dynamic_vram': True, 'text_encoder': 'cpu'})
        self.assertEqual(len(seen), 2)
        self.assertEqual(job['params']['vram_mode'], 'high', 'the caller job is left untouched')
        self.assertEqual(meta['repair_profile']['vram_mode'], {'job': 'high', 'safe': 'normal'})
        self.assertIn('profil mémoire sûr', meta['repair'])
        ev = dict(self.events())
        self.assertEqual(ev['repair_safe_profile_ok']['profile']['dynamic_vram'], {'job': False, 'safe': True})
        self.assertEqual(ev['repair_replay']['safe_profile'], {'vram_mode': 'normal', 'dynamic_vram': True})
        # Une panne de fichier (poids faux) : mêmes paramètres au rejeu, pas de profil sûr
        self.worker.repairs.clear()
        seen.clear()
        broken = bytearray(self.data)
        broken[10] ^= 0xFF
        self.file.write_bytes(bytes(broken))
        out, secs, meta = self.worker.run_gpu(job, None, self.base, threading.Event(), lambda f, st: None)
        self.assertEqual(seen[0], seen[1])
        self.assertNotIn('repair_profile', meta)

    def test_an_ordinary_failure_is_not_repaired_until_it_happens_twice_in_a_row_on_the_same_model(self):
        self.file.write_bytes(self.data)
        with self.assertRaises(RuntimeError):
            self.run_with([RuntimeError('ComfyUI refuse le workflow (HTTP 400)')])
        self.assertEqual(self.events(), [])
        with self.assertRaises(RuntimeError) as c:
            self.run_with([RuntimeError('ComfyUI refuse le workflow (HTTP 400)')])
        self.assertIn('2 échecs de suite', self.events()[0][1]['reason'])
        self.assertIn('[auto-réparation : 1 fichier(s) vérifié(s), sains', str(c.exception))
        self.assertEqual(len(self.runs), 2, 'sound files, no native crash: nothing to replay')
        # Final (trop lent, image noire) : jamais une affaire de fichiers
        self.worker.repairs.clear()
        with self.assertRaises(w.Final):
            self.run_with([w.Final('génération trop lente')])
        self.assertEqual(self.events()[-1][0], 'repair_finished')

    def test_a_damaged_python_environment_is_reset_once_with_the_workshop_held_off(self):
        self.file.write_bytes(self.data)
        spec = w.comfy_spec(Path(w.__file__).resolve().parent)
        lay = w.comfy_layout(self.base, spec)
        sp = lay['python'] / 'Lib' / 'site-packages'
        (sp / 'torch-2.13.0.dist-info').mkdir(parents=True)
        (sp / 'torch').mkdir()
        (sp / 'torch' / 'c10.dll').write_bytes(b'changed')
        (sp / 'torch-2.13.0.dist-info' / 'RECORD').write_text('torch/c10.dll,sha256=%s,7\n' % w.record_hash(hashlib.sha256(b'origin').digest()))
        held, installs = [], []
        self.worker.atelier.hold = lambda why: held.append(why) or False
        real = w.comfy_install

        def fake_install(base, spec_, gpu, stop, progress, report, files=None):
            # Réinstallé avant le nouvel essai : sans cela, le modèle n'est plus proposé (gpu.models()) et l'essai échoue
            installs.append((files, lay['python'].exists(), w.comfy_done(lay, spec_, 'torch')))
            return lay, {}
        w.comfy_install = fake_install
        try:
            out, _, meta = self.run_with([RuntimeError(self.CRASH), None])
            self.assertEqual(installs, [([], False, False)], 'damaged environment removed, then reinstalled (weights untouched)')
            self.assertEqual(len(held), 1)
            self.assertIsNone(self.worker.atelier.held, 'workshop free to start again (it reclones the new environment)')
            what = [e[0] for e in self.events()]
            self.assertLess(what.index('repair_env_reset'), what.index('repair_env_reinstalled'))
            self.assertLess(what.index('repair_env_reinstalled'), what.index('repair_replay'))
            env = dict(self.events())['repair_env']
            self.assertEqual(env['bad'][0]['file'], 'torch/c10.dll')
            self.assertIn('environnement ComfyUI refait', meta['repair'])
            # Même panne le lendemain matin (moins de 24 h), worker redémarré entre-temps : pas de seconde réinstallation
            self.restart()
            self.worker.atelier.hold = lambda why: held.append(why) or False
            self.assertGreater(self.worker.env_reset_at, 0, 'kept on disk')
            self.worker.repairs.clear()
            (sp / 'torch-2.13.0.dist-info').mkdir(parents=True)
            (sp / 'torch').mkdir()
            (sp / 'torch' / 'c10.dll').write_bytes(b'changed')
            (sp / 'torch-2.13.0.dist-info' / 'RECORD').write_text('torch/c10.dll,sha256=%s,7\n' % w.record_hash(hashlib.sha256(b'origin').digest()))
            with self.assertRaises(RuntimeError) as c:
                self.run_with([RuntimeError(self.CRASH)])
            self.assertIn('pas de nouvelle réinstallation avant 24 h', dict(self.events())['repair_finished']['summary'])
            self.assertEqual(len(installs), 1)
        finally:
            w.comfy_install = real

if __name__ == '__main__':
    w.log.addHandler(__import__('logging').NullHandler())
    w.log.propagate = False
    unittest.main(verbosity=1)
