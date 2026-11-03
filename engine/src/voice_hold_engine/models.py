"""Model files: where they live, how they are fetched and checked.

Downloads come from the `asr-models` release of sherpa-onnx, a rolling tag:
every file is pinned to a SHA-256 so a re-upload or a tampered download is
refused rather than installed. The pins were taken from the GitHub release
asset digests and checked against a download on 2026-11-03 (see README).
"""
import hashlib
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'
ASR_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
ASR_ARCHIVE = ASR_NAME + '.tar.bz2'
ASR_ARCHIVE_SIZE = 487_170_055
ASR_ARCHIVE_SHA256 = '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf'
VAD_FILE = 'silero_vad.onnx'
VAD_SIZE = 643_854
VAD_SHA256 = '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'

# Files a complete install must have: exact size (checked at every start,
# cheap) and SHA-256 (checked by setup and `status --verify`).
REQUIRED = {
    f'{ASR_NAME}/encoder.int8.onnx': (652_184_281, 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247'),
    f'{ASR_NAME}/decoder.int8.onnx': (11_845_275, '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e'),
    f'{ASR_NAME}/joiner.int8.onnx': (6_355_277, '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3'),
    f'{ASR_NAME}/tokens.txt': (93_939, 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d'),
    VAD_FILE: (VAD_SIZE, VAD_SHA256),
}


def models_dir():
    base = os.environ.get('VOICE_HOLD_MODELS')
    if base:
        return Path(base)
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local' / 'share'))
    return data / 'voice-hold' / 'models'


def missing(base=None):
    """Files absent or not of the expected size."""
    base = base or models_dir()
    out = []
    for rel, (size, _sha) in REQUIRED.items():
        p = base / rel
        if not p.is_file() or p.stat().st_size != size:
            out.append(rel)
    return out


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for buf in iter(lambda: f.read(1 << 20), b''):
            h.update(buf)
    return h.hexdigest()


def verify(base=None):
    """Files whose content does not match the pinned SHA-256 (reads
    everything: ~650 MB)."""
    base = base or models_dir()
    out = []
    for rel, (size, sha) in REQUIRED.items():
        p = base / rel
        if not p.is_file() or p.stat().st_size != size or sha256_of(p) != sha:
            out.append(rel)
    return out


def asr_paths(base=None):
    base = base or models_dir()
    d = base / ASR_NAME
    return {
        'encoder': str(d / 'encoder.int8.onnx'),
        'decoder': str(d / 'decoder.int8.onnx'),
        'joiner': str(d / 'joiner.int8.onnx'),
        'tokens': str(d / 'tokens.txt'),
    }


def vad_path(base=None):
    return str((base or models_dir()) / VAD_FILE)


def _fetch(url, dest, log, *, size, sha256):
    """Download `url` to `dest` through a `.part` file, verify size and
    SHA-256, and leave nothing behind on failure."""
    tmp = dest.with_suffix(dest.suffix + '.part')
    req = urllib.request.Request(url, headers={'User-Agent': 'voice-hold-engine'})
    try:
        h = hashlib.sha256()
        with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, 'wb') as f:
            total = int(resp.headers.get('Content-Length') or 0)
            done = 0
            while True:
                buf = resp.read(1 << 20)
                if not buf:
                    break
                f.write(buf)
                h.update(buf)
                done += len(buf)
                if total:
                    log(f'\r  {dest.name}: {done * 100 // total:3d}% ({done >> 20} MB)')
            log('\n')
        if done != size or h.hexdigest() != sha256:
            raise RuntimeError(
                f'{dest.name}: download does not match the pinned checksum '
                f'(got {done} bytes, sha256 {h.hexdigest()[:12]}…; expected {size} bytes, '
                f'{sha256[:12]}…). The upstream file may have changed; please report it.')
        tmp.replace(dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _safe_extract(archive, dest):
    with tarfile.open(archive, 'r:bz2') as tar:
        tar.extractall(dest, filter='data')


def setup(base=None, log=None):
    """Download what is missing. Returns the list of files still missing."""
    base = base or models_dir()
    log = log or (lambda s: (sys.stderr.write(s), sys.stderr.flush()))
    base.mkdir(parents=True, exist_ok=True)
    need = missing(base)
    if any(rel.startswith(ASR_NAME) for rel in need):
        log(f'Downloading {ASR_NAME} (~465 MB, 650 MB once unpacked)...\n')
        with tempfile.TemporaryDirectory(dir=base) as tmp:
            archive = Path(tmp) / ASR_ARCHIVE
            _fetch(RELEASES + ASR_ARCHIVE, archive, log, size=ASR_ARCHIVE_SIZE, sha256=ASR_ARCHIVE_SHA256)
            log('  extracting...\n')
            _safe_extract(archive, Path(tmp))
            archive.unlink()
            extracted = Path(tmp) / ASR_NAME
            # Only the files we use: no sample WAVs, no fp32 weights.
            shutil.rmtree(extracted / 'test_wavs', ignore_errors=True)
            for p in extracted.glob('*.onnx'):
                if '.int8.' not in p.name:
                    p.unlink()
            bad = [rel for rel in verify(Path(tmp)) if rel.startswith(ASR_NAME)]
            if bad:
                raise RuntimeError(f'extracted files do not match the pinned checksums: {", ".join(bad)}')
            target = base / ASR_NAME
            if target.exists():
                shutil.rmtree(target)
            extracted.rename(target)
    if VAD_FILE in need:
        log(f'Downloading {VAD_FILE}...\n')
        _fetch(RELEASES + VAD_FILE, base / VAD_FILE, log, size=VAD_SIZE, sha256=VAD_SHA256)
    return missing(base)
