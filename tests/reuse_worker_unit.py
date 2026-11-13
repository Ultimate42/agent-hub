"""Tests unitaires du worker RE-USE (fonctions pures). Lancé par tests/reuse-worker.test.js."""
import array
import importlib.util
import io
import json
import math
import os
import re
import struct
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

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
    time.sleep(0.3)
    print('Requested to load Flux3', flush=True)
    print('model weight dtype torch.%s, manual cast: %s' % ('float16' if '--fp16-unet' in a else 'bfloat16', 'None' if '--fp16-unet' in a else 'torch.float32'), flush=True)
    print('loaded completely; 14000.00 MB usable, 11000.00 MB loaded, full load: True', flush=True)
    for i in range(1, steps + 1):
        print(' %3d%%|###   | %d/%d [00:01<00:02,  %s]' % (100 * i // steps, i, steps, '500.00s/it' if slow else '0.05s/it'), end='\r', flush=True)
        time.sleep(0.2 if slow else 0.05)
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
                                     'devices': [{'name': 'cuda:0 AMD Radeon RX 6950 XT : native', 'type': 'cuda', 'vram_total': 17163091968, 'vram_free': 16000000000}]})
        pid = self.path.rsplit('/', 1)[-1]
        return self.answer(200, {pid: history[pid]} if pid in history else {})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
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
            self.assertEqual(meta['s_per_step'], 0.05)
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

            # Image unie en fp16 (NaN) : refaite dans la précision sûre, ComfyUI relancé sans --fp16-unet
            (lay['data'] / 'flat-fp16').write_text('')
            out3, _, meta3 = gpu.run(dict(job, id=9, ref_paths=[]), None, work, None, lambda f, st: None)
            self.assertTrue(meta3['half_fallback'])
            self.assertRegex(meta3['try_first'], r'^fp16 quad : 0\.05 s/étape, [\d.]+ s, écart 0\.0$')
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
        self.assertEqual(report['s_per_step'], 0.05)
        self.assertEqual(report['speedup_vs_sdcpp'], round(13.2 / 0.05, 2))
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


if __name__ == '__main__':
    w.log.addHandler(__import__('logging').NullHandler())
    w.log.propagate = False
    unittest.main(verbosity=1)
