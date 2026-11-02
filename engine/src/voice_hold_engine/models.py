"""Model files: where they live, how they are fetched."""
import os
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'
ASR_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
ASR_ARCHIVE = ASR_NAME + '.tar.bz2'
VAD_FILE = 'silero_vad.onnx'

# Files a complete install must have, with a floor on their size: a truncated
# download fails to load with an obscure "protobuf parsing failed".
REQUIRED = {
    f'{ASR_NAME}/encoder.int8.onnx': 600_000_000,
    f'{ASR_NAME}/decoder.int8.onnx': 10_000_000,
    f'{ASR_NAME}/joiner.int8.onnx': 5_000_000,
    f'{ASR_NAME}/tokens.txt': 10_000,
    VAD_FILE: 1_000_000,
}


def models_dir():
    base = os.environ.get('VOICE_HOLD_MODELS')
    if base:
        return Path(base)
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local' / 'share'))
    return data / 'voice-hold' / 'models'


def missing(base=None):
    base = base or models_dir()
    out = []
    for rel, floor in REQUIRED.items():
        p = base / rel
        if not p.is_file() or p.stat().st_size < floor:
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


def _fetch(url, dest, log):
    tmp = dest.with_suffix(dest.suffix + '.part')
    req = urllib.request.Request(url, headers={'User-Agent': 'voice-hold-engine'})
    with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, 'wb') as f:
        total = int(resp.headers.get('Content-Length') or 0)
        done = 0
        while True:
            buf = resp.read(1 << 20)
            if not buf:
                break
            f.write(buf)
            done += len(buf)
            if total:
                log(f'\r  {dest.name}: {done * 100 // total:3d}% ({done >> 20} MB)')
        log('\n')
    tmp.replace(dest)


def _safe_extract(archive, dest):
    with tarfile.open(archive, 'r:bz2') as tar:
        if hasattr(tarfile, 'data_filter'):
            tar.extractall(dest, filter='data')
        else:  # pragma: no cover - Python < 3.12
            for m in tar.getmembers():
                if m.name.startswith('/') or '..' in Path(m.name).parts:
                    raise RuntimeError(f'unsafe path in archive: {m.name}')
            tar.extractall(dest)


def setup(base=None, log=None):
    """Download what is missing. Returns the list of files still missing."""
    base = base or models_dir()
    log = log or (lambda s: (sys.stderr.write(s), sys.stderr.flush()))
    base.mkdir(parents=True, exist_ok=True)
    need = missing(base)
    if any(rel.startswith(ASR_NAME) for rel in need):
        log(f'Downloading {ASR_NAME} (~650 MB)...\n')
        with tempfile.TemporaryDirectory(dir=base) as tmp:
            archive = Path(tmp) / ASR_ARCHIVE
            _fetch(RELEASES + ASR_ARCHIVE, archive, log)
            log('  extracting...\n')
            _safe_extract(archive, Path(tmp))
            extracted = Path(tmp) / ASR_NAME
            target = base / ASR_NAME
            if target.exists():
                import shutil
                shutil.rmtree(target)
            extracted.rename(target)
            # The fp32 files are not shipped in the int8 archive, but drop any
            # extra bulk if present.
            for p in target.glob('*.onnx'):
                if '.int8.' not in p.name:
                    p.unlink()
    if VAD_FILE in need:
        log(f'Downloading {VAD_FILE}...\n')
        _fetch(RELEASES + VAD_FILE, base / VAD_FILE, log)
    return missing(base)
