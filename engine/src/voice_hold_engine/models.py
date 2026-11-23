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
# Speech models, best first. Parakeet TDT 0.6B "Ultra" replaces v3 since
# 0.4.0: same size and speed, but it no longer slips into English on
# spontaneous French (bench of 2026-11-11: 10.6 % WER against 42.3 % on
# meeting speech). An install that only has v3 keeps working with it until
# `setup` is run again.
ASR_MODELS = {
    'sherpa-onnx-nemo-parakeet-tdt-0.6b-ultra-int8': {
        'archive_size': 487_134_290,
        'archive_sha256': 'd216b71d7f628b3f2f2a20ee7ead39ff0b075984959eb4bf6ddf8dc8da737c09',
        'files': {
            'encoder.int8.onnx': (652_282_345, 'b43072e1b721f18a3df03fcfeb763ff7c4debdf29843598a3aba2f703e2780a3'),
            'decoder.int8.onnx': (11_845_274, '1fab98fe6c12aded87d2da66272cc9e148d0a0044ce3850a12fe56302ec4a922'),
            'joiner.int8.onnx': (6_355_277, '8a71aaccfdba3d451775507a889afd2257d2e754463fd81095a8c8f290f924c2'),
            'tokens.txt': (93_939, 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d'),
        },
    },
    'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8': {
        'archive_size': 487_170_055,
        'archive_sha256': '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
        'files': {
            'encoder.int8.onnx': (652_184_281, 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247'),
            'decoder.int8.onnx': (11_845_275, '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e'),
            'joiner.int8.onnx': (6_355_277, '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3'),
            'tokens.txt': (93_939, 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d'),
        },
    },
}
ASR_NAME = next(iter(ASR_MODELS))      # the one `setup` installs
VAD_FILE = 'silero_vad.onnx'
VAD_SIZE = 643_854
VAD_SHA256 = '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'

# Voices for the optional text-to-speech (Piper VITS models from the
# `tts-models` release of sherpa-onnx; each archive holds the model, its
# tokens and the espeak-ng data it needs). Installed by `setup --tts`.
TTS_RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/'
VOICES = {
    'fr': {'name': 'vits-piper-fr_FR-siwis-medium', 'model': 'fr_FR-siwis-medium.onnx',
           'size': 67_207_459, 'sha256': '375909aa30842b3a4efa10b1beb1d761af792960ae6873b4d53889f96c66195b'},
    'en': {'name': 'vits-piper-en_US-lessac-medium', 'model': 'en_US-lessac-medium.onnx',
           'size': 67_230_653, 'sha256': '9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334e'},
}

def models_dir():
    base = os.environ.get('VOICE_HOLD_MODELS')
    if base:
        return Path(base)
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local' / 'share'))
    return data / 'voice-hold' / 'models'


def _required(name):
    """Files of one speech model plus the VAD: {relative path: (size, sha256)}.
    Sizes are checked at every start (cheap), SHA-256 by setup and
    `status --verify`."""
    req = {f'{name}/{f}': v for f, v in ASR_MODELS[name]['files'].items()}
    req[VAD_FILE] = (VAD_SIZE, VAD_SHA256)
    return req


def _wrong_size(base, req):
    out = []
    for rel, (size, _sha) in req.items():
        p = base / rel
        if not p.is_file() or p.stat().st_size != size:
            out.append(rel)
    return out


def asr_name(base=None):
    """The best speech model that is completely installed, else the one
    `setup` would install."""
    base = base or models_dir()
    for name in ASR_MODELS:
        if not any(rel.startswith(name) for rel in _wrong_size(base, _required(name))):
            return name
    return ASR_NAME


def upgrade_available(base=None):
    """True when an older speech model is in use and `setup` would fetch a
    better one."""
    return asr_name(base) != ASR_NAME


def missing(base=None):
    """Files absent or not of the expected size, for the model in use."""
    base = base or models_dir()
    return _wrong_size(base, _required(asr_name(base)))


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for buf in iter(lambda: f.read(1 << 20), b''):
            h.update(buf)
    return h.hexdigest()


def verify(base=None, name=None):
    """Files whose content does not match the pinned SHA-256 (reads
    everything: ~650 MB)."""
    base = base or models_dir()
    out = []
    for rel, (size, sha) in _required(name or asr_name(base)).items():
        p = base / rel
        if not p.is_file() or p.stat().st_size != size or sha256_of(p) != sha:
            out.append(rel)
    return out


def asr_paths(base=None):
    base = base or models_dir()
    d = base / asr_name(base)
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
    """Download what is missing (and the current speech model when an older
    one is installed). Returns the list of files still missing."""
    base = base or models_dir()
    log = log or (lambda s: (sys.stderr.write(s), sys.stderr.flush()))
    base.mkdir(parents=True, exist_ok=True)
    spec = ASR_MODELS[ASR_NAME]
    if any(rel.startswith(ASR_NAME) for rel in _wrong_size(base, _required(ASR_NAME))):
        log(f'Downloading {ASR_NAME} (~465 MB, 650 MB once unpacked)...\n')
        with tempfile.TemporaryDirectory(dir=base) as tmp:
            archive = Path(tmp) / (ASR_NAME + '.tar.bz2')
            _fetch(RELEASES + archive.name, archive, log, size=spec['archive_size'], sha256=spec['archive_sha256'])
            log('  extracting...\n')
            _safe_extract(archive, Path(tmp))
            archive.unlink()
            extracted = Path(tmp) / ASR_NAME
            # Only the files we use: no sample WAVs, no fp32 weights.
            shutil.rmtree(extracted / 'test_wavs', ignore_errors=True)
            for p in extracted.glob('*.onnx'):
                if '.int8.' not in p.name:
                    p.unlink()
            bad = [rel for rel in verify(Path(tmp), ASR_NAME) if rel.startswith(ASR_NAME)]
            if bad:
                raise RuntimeError(f'extracted files do not match the pinned checksums: {", ".join(bad)}')
            target = base / ASR_NAME
            if target.exists():
                shutil.rmtree(target)
            extracted.rename(target)
        # The model it replaces is 650 MB nobody reads any more.
        for old in ASR_MODELS:
            if old != ASR_NAME:
                shutil.rmtree(base / old, ignore_errors=True)
    if _wrong_size(base, {VAD_FILE: (VAD_SIZE, VAD_SHA256)}):
        log(f'Downloading {VAD_FILE}...\n')
        _fetch(RELEASES + VAD_FILE, base / VAD_FILE, log, size=VAD_SIZE, sha256=VAD_SHA256)
    return missing(base)


# -- text-to-speech voices ---------------------------------------------------

def voice_dir(lang, base=None):
    return (base or models_dir()) / VOICES[lang]['name']


def voice_paths(lang, base=None):
    """Files of an installed voice: {model, tokens, data_dir}."""
    d = voice_dir(lang, base)
    return {'model': str(d / VOICES[lang]['model']), 'tokens': str(d / 'tokens.txt'),
            'data_dir': str(d / 'espeak-ng-data')}


def voice_ready(lang, base=None):
    p = voice_paths(lang, base)
    return Path(p['model']).is_file() and Path(p['tokens']).is_file() and Path(p['data_dir']).is_dir()


def voices_ready(base=None):
    """Languages whose voice is installed."""
    return [lang for lang in VOICES if voice_ready(lang, base)]


def setup_voice(lang, base=None, log=None):
    """Download and unpack one voice (~65 MB). Returns True when ready."""
    base = base or models_dir()
    log = log or (lambda s: (sys.stderr.write(s), sys.stderr.flush()))
    if voice_ready(lang, base):
        return True
    v = VOICES[lang]
    base.mkdir(parents=True, exist_ok=True)
    log(f'Downloading the {lang} voice {v["name"]} (~{v["size"] >> 20} MB)...\n')
    with tempfile.TemporaryDirectory(dir=base) as tmp:
        archive = Path(tmp) / (v['name'] + '.tar.bz2')
        _fetch(TTS_RELEASES + archive.name, archive, log, size=v['size'], sha256=v['sha256'])
        log('  extracting...\n')
        _safe_extract(archive, Path(tmp))
        archive.unlink()
        extracted = Path(tmp) / v['name']
        if not (extracted / v['model']).is_file():
            raise RuntimeError(f'{archive.name}: no {v["model"]} inside')
        shutil.rmtree(extracted / 'test_wavs', ignore_errors=True)
        target = base / v['name']
        if target.exists():
            shutil.rmtree(target)
        extracted.rename(target)
    return voice_ready(lang, base)


# -- wake word -----------------------------------------------------------------
# The small streaming French recogniser behind the wake word (wakeword.py):
# Kroko fr 2025-08-06, a zipformer transducer from Banafo's community models
# (CC-BY-SA-4.0), in the `asr-models` release of sherpa-onnx. Installed by
# `setup --wake`. Pins: GitHub asset digest, checked against a download on
# 2026-11-23 (wake-word bench, ticket #16).
WAKE_NAME = 'sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06'
WAKE_MODEL = {
    'archive_size': 57_220_361,
    'archive_sha256': 'e6ffd3dc43725cd6c8137b05c739f15607d0df946b9b90eb141e10059efca024',
    'files': {
        'encoder.onnx': (70_092_599, 'e02facae1daf6f1f13da67ea3ace7c722516d0868d1768d78c0580bc22cc0c5b'),
        'decoder.onnx': (617_488, '6aed547570e3ab5afc05429a017cedd3a056c16df3baa5703f02461cefa25bac'),
        'joiner.onnx': (336_817, 'a51eec759bcdcaae2614686fa2a8b57417b2d420dd55a5a5558b388d35a9b2b6'),
        'tokens.txt': (5_415, 'fedfb9c844bfb2bf14171f8184863e3d617b815a8667bdd9fc9a3149fde73298'),
    },
}


def _wake_required():
    return {f'{WAKE_NAME}/{f}': v for f, v in WAKE_MODEL['files'].items()}


def wake_missing(base=None):
    """Wake word model files absent or not of the pinned size."""
    return _wrong_size(base or models_dir(), _wake_required())


def wake_verify(base=None):
    """Wake word model files whose SHA-256 does not match the pin."""
    base = base or models_dir()
    return [rel for rel, (size, sha) in _wake_required().items()
            if not (base / rel).is_file() or (base / rel).stat().st_size != size or sha256_of(base / rel) != sha]


def setup_wake(base=None, log=None):
    """Download and unpack the wake word model (~55 MB, 68 MB unpacked).
    Returns the list of files still missing."""
    base = base or models_dir()
    log = log or (lambda s: (sys.stderr.write(s), sys.stderr.flush()))
    if not wake_missing(base):
        return []
    base.mkdir(parents=True, exist_ok=True)
    log(f'Downloading the wake word model {WAKE_NAME} (~{WAKE_MODEL["archive_size"] >> 20} MB)...\n')
    with tempfile.TemporaryDirectory(dir=base) as tmp:
        archive = Path(tmp) / (WAKE_NAME + '.tar.bz2')
        _fetch(RELEASES + archive.name, archive, log,
               size=WAKE_MODEL['archive_size'], sha256=WAKE_MODEL['archive_sha256'])
        log('  extracting...\n')
        _safe_extract(archive, Path(tmp))
        archive.unlink()
        extracted = Path(tmp) / WAKE_NAME
        shutil.rmtree(extracted / 'test_wavs', ignore_errors=True)
        bad = wake_verify(Path(tmp))
        if bad:
            raise RuntimeError(f'extracted files do not match the pinned checksums: {", ".join(bad)}')
        target = base / WAKE_NAME
        if target.exists():
            shutil.rmtree(target)
        extracted.rename(target)
    return wake_missing(base)
