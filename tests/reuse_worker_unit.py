"""Tests unitaires du worker RE-USE (fonctions pures). Lancé par tests/reuse-worker.test.js."""
import array
import importlib.util
import io
import json
import math
import os
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
        # Accolades dans une valeur : jamais réinterprétées
        self.assertEqual(w.build_command(['{prompt}'], {'prompt': '{file:vae}'}), ['{file:vae}'])

    def test_catalog_commands_use_only_known_values(self):
        for kind, spec in self.catalog['types'].items():
            for mid, m in spec['models'].items():
                values = {k: (v['default'] if v.get('default') != 'random' else 1) for k, v in m['params'].items()}
                values.update(prompt='x', output='o', models_dir='d', input='i', **{'file:' + f['role']: 'f' for f in m['files']})
                w.build_command(m['command'] + m.get('command_input', []), values)   # aucune valeur manquante
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

if __name__ == '__main__':
    w.log.addHandler(__import__('logging').NullHandler())
    w.log.propagate = False
    unittest.main(verbosity=1)
