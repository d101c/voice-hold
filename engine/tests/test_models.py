"""models: size/checksum pins, clean-up on failed downloads, setup on a tiny
fake archive served from memory."""
import hashlib
import io
import tarfile

import pytest

from voice_hold_engine import models


def _sha(data):
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def pinned(monkeypatch, tmp_path):
    """Pin REQUIRED/archive constants to a small fake model set and serve
    the archive and the VAD from memory. Returns (base, served)."""
    files = {
        'encoder.int8.onnx': b'E' * 1000,
        'decoder.int8.onnx': b'D' * 200,
        'joiner.int8.onnx': b'J' * 100,
        'tokens.txt': b'<blk>\na\nb\n',
        'encoder.onnx': b'F' * 5000,          # fp32 bulk: must be dropped
    }
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:bz2') as tar:
        for name, data in files.items():
            ti = tarfile.TarInfo(f'{models.ASR_NAME}/{name}')
            ti.size = len(data)
            tar.addfile(ti, io.BytesIO(data))
        ti = tarfile.TarInfo(f'{models.ASR_NAME}/test_wavs/en.wav')
        ti.size = 4
        tar.addfile(ti, io.BytesIO(b'RIFF'))
    archive = buf.getvalue()
    vad = b'V' * 300
    served = {models.RELEASES + models.ASR_ARCHIVE: archive, models.RELEASES + models.VAD_FILE: vad}

    monkeypatch.setattr(models, 'ASR_ARCHIVE_SIZE', len(archive))
    monkeypatch.setattr(models, 'ASR_ARCHIVE_SHA256', _sha(archive))
    monkeypatch.setattr(models, 'VAD_SIZE', len(vad))
    monkeypatch.setattr(models, 'VAD_SHA256', _sha(vad))
    monkeypatch.setattr(models, 'REQUIRED', {
        f'{models.ASR_NAME}/encoder.int8.onnx': (1000, _sha(files['encoder.int8.onnx'])),
        f'{models.ASR_NAME}/decoder.int8.onnx': (200, _sha(files['decoder.int8.onnx'])),
        f'{models.ASR_NAME}/joiner.int8.onnx': (100, _sha(files['joiner.int8.onnx'])),
        f'{models.ASR_NAME}/tokens.txt': (len(files['tokens.txt']), _sha(files['tokens.txt'])),
        models.VAD_FILE: (len(vad), _sha(vad)),
    })

    class Resp(io.BytesIO):
        headers = {'Content-Length': '0'}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            self.close()

    def urlopen(req, timeout=None):
        url = req.full_url
        if url not in served:
            raise OSError(f'404 {url}')
        return Resp(served[url])

    monkeypatch.setattr(models.urllib.request, 'urlopen', urlopen)
    base = tmp_path / 'models'
    return base, served


def test_setup_installs_verifies_and_prunes(pinned):
    base, _ = pinned
    log = []
    assert models.setup(base, log.append) == []
    assert models.missing(base) == []
    assert models.verify(base) == []
    d = base / models.ASR_NAME
    assert sorted(p.name for p in d.iterdir()) == ['decoder.int8.onnx', 'encoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
    assert not (d / 'test_wavs').exists()
    assert not list(base.glob('**/*.part'))
    assert not list(base.glob('tmp*')), 'temporary directory removed'


def test_missing_checks_exact_size(pinned):
    base, _ = pinned
    models.setup(base, lambda s: None)
    (base / models.VAD_FILE).write_bytes(b'V' * 301)
    assert models.missing(base) == [models.VAD_FILE]


def test_verify_detects_tampering(pinned):
    base, _ = pinned
    models.setup(base, lambda s: None)
    (base / models.ASR_NAME / 'tokens.txt').write_bytes(b'<blk>\nx\nb\n')   # same size
    assert models.missing(base) == []
    assert models.verify(base) == [f'{models.ASR_NAME}/tokens.txt']


def test_checksum_mismatch_leaves_nothing_behind(pinned, monkeypatch):
    base, served = pinned
    served[models.RELEASES + models.VAD_FILE] = b'W' * 300        # right size, wrong content
    monkeypatch.setattr(models, 'ASR_ARCHIVE_SHA256', 'x' * 64)   # archive refused too
    with pytest.raises(RuntimeError, match='pinned checksum'):
        models.setup(base, lambda s: None)
    assert not list(base.glob('**/*.part'))
    assert not (base / models.ASR_NAME).exists()
    assert not list(base.glob('tmp*'))


def test_interrupted_download_removes_part(pinned, monkeypatch):
    base, _ = pinned
    base.mkdir()

    def broken(req, timeout=None):
        class R:
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

            def read(self, n):
                raise ConnectionResetError('reset')
        return R()
    monkeypatch.setattr(models.urllib.request, 'urlopen', broken)
    with pytest.raises(ConnectionResetError):
        models._fetch('http://x/' + models.VAD_FILE, base / models.VAD_FILE, lambda s: None, size=300, sha256='0' * 64)
    assert list(base.iterdir()) == []


def test_real_pins_are_well_formed():
    assert len(models.ASR_ARCHIVE_SHA256) == 64 and len(models.VAD_SHA256) == 64
    for rel, (size, sha) in models.REQUIRED.items():
        assert size > 0 and len(sha) == 64, rel
    assert models.REQUIRED[f'{models.ASR_NAME}/encoder.int8.onnx'][0] == 652_184_281
