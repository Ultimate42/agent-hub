"""Tests unitaires du worker RE-USE (fonctions pures). Lancé par tests/reuse-worker.test.js."""
import array
import importlib.util
import io
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


if __name__ == '__main__':
    w.log.addHandler(__import__('logging').NullHandler())
    w.log.propagate = False
    unittest.main(verbosity=1)
