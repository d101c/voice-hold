"""The local LLM: a llama.cpp server (`llama-server`) and one GGUF model,
both downloaded by `setup --commands` into $XDG_DATA_HOME/voice-hold/llm and
pinned to a SHA-256. The server listens on the loopback only, is started on
demand, detached, and gives its memory back after IDLE_S without a request.

Measured on an i7-8565U (4 cores, no GPU), 65 spoken requests, JSON schema:
Qwen3.5-2B Q4_K_M answers 92 % right in 1.4 s (median) for 2 GB of memory,
once the system prompt is in the server's prompt cache."""
import json
import os
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import models

SERVER_NAME = 'llama-b12284'
SERVER_ARCHIVE = SERVER_NAME + '-bin-ubuntu-x64.tar.gz'
SERVER_URL = f'https://github.com/ggml-org/llama.cpp/releases/download/b12284/{SERVER_ARCHIVE}'
SERVER_SIZE = 23_284_029
SERVER_SHA256 = '50b5f85d45f8ddc7179d1b9b65de6534fbb18dc075942413238cb3471570123f'

MODEL_NAME = 'Qwen3.5-2B'
MODEL_FILE = 'Qwen3.5-2B-Q4_K_M.gguf'
MODEL_URL = ('https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/'
             f'f6d5376be1edb4d416d56da11e5397a961aca8ae/{MODEL_FILE}')
MODEL_SIZE = 1_280_835_840
MODEL_SHA256 = 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223'

PORT = int(os.environ.get('VOICE_HOLD_LLM_PORT', '18642'))
URL = f'http://127.0.0.1:{PORT}'
IDLE_S = 600
SLOTS = 2            # one prompt cache for the commands, one for the polish
CTX_PER_SLOT = 4096


def llm_dir():
    base = os.environ.get('VOICE_HOLD_LLM')
    if base:
        return Path(base)
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local' / 'share'))
    return data / 'voice-hold' / 'llm'


def server_binary(base=None):
    return (base or llm_dir()) / SERVER_NAME / 'llama-server'


def model_path(base=None):
    return (base or llm_dir()) / MODEL_FILE


def missing(base=None):
    """What `setup --commands` still has to fetch."""
    out = []
    b = server_binary(base)
    if not (b.is_file() and os.access(b, os.X_OK)):
        out.append(SERVER_NAME)
    m = model_path(base)
    if not m.is_file() or m.stat().st_size != MODEL_SIZE:
        out.append(MODEL_FILE)
    return out


def installed(base=None):
    return not missing(base)


def setup(base=None, log=None):
    """Download the server and the model. Returns what is still missing."""
    base = base or llm_dir()
    log = log or (lambda s: None)
    base.mkdir(parents=True, exist_ok=True)
    need = missing(base)
    if SERVER_NAME in need:
        log(f'Downloading llama.cpp {SERVER_NAME} (~22 MB)...\n')
        with tempfile.TemporaryDirectory(dir=base) as tmp:
            archive = Path(tmp) / SERVER_ARCHIVE
            models._fetch(SERVER_URL, archive, log, size=SERVER_SIZE, sha256=SERVER_SHA256)
            with tarfile.open(archive, 'r:gz') as tar:
                tar.extractall(tmp, filter='data')
            extracted = Path(tmp) / SERVER_NAME
            if not (extracted / 'llama-server').is_file():
                raise RuntimeError(f'{SERVER_ARCHIVE}: no llama-server inside')
            # Only the server and the libraries it loads.
            for p in extracted.iterdir():
                if p.name != 'llama-server' and not p.name.startswith('lib') and p.name != 'LICENSE':
                    shutil.rmtree(p) if p.is_dir() else p.unlink()
            target = base / SERVER_NAME
            if target.exists():
                shutil.rmtree(target)
            extracted.rename(target)
    if MODEL_FILE in need:
        log(f'Downloading {MODEL_FILE} (~1.2 GB)...\n')
        models._fetch(MODEL_URL, model_path(base), log, size=MODEL_SIZE, sha256=MODEL_SHA256)
    return missing(base)


# -- the server ---------------------------------------------------------------

def _state_dir():
    d = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local' / 'state')) / 'voice-hold'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _pid_file():
    return _state_dir() / 'llama-server.pid'


def healthy(timeout=1.0, opener=None):
    """True when a server answers on our port and has finished loading."""
    try:
        with (opener or urllib.request.urlopen)(f'{URL}/health', timeout=timeout) as f:
            return f.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def command(base=None, threads=None):
    threads = threads or min(4, os.cpu_count() or 2)
    return [str(server_binary(base)), '-m', str(model_path(base)), '--alias', MODEL_NAME,
            '--host', '127.0.0.1', '--port', str(PORT), '-t', str(threads),
            '-c', str(CTX_PER_SLOT * SLOTS), '--parallel', str(SLOTS), '-ngl', '0',
            '--jinja', '--reasoning-budget', '0', '--no-webui',
            # Without these two the long system prompt is read again at every
            # request (seconds); with them only the user's words are.
            '--swa-full', '-cms', '0',
            '--sleep-idle-seconds', str(IDLE_S)]


def ensure(wait_s=60.0, base=None, spawn=subprocess.Popen):
    """Return True when the server answers; start it if it is installed and
    does not. Reading 1.2 GB of weights takes a few seconds."""
    if healthy():
        return True
    if not installed(base):
        return False
    binary = server_binary(base)
    env = dict(os.environ)
    env['LD_LIBRARY_PATH'] = f'{binary.parent}:{env.get("LD_LIBRARY_PATH", "")}'.rstrip(':')
    with open(_state_dir() / 'llama-server.log', 'wb') as log:
        proc = spawn(command(base), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                     start_new_session=True, env=env, cwd=str(binary.parent))
    try:
        _pid_file().write_text(str(proc.pid))
    except OSError:
        pass
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        if healthy():
            return True
        if proc.poll() is not None:      # port taken by a twin that won the race, or a crash
            return healthy()
        time.sleep(0.25)
    return False


def stop():
    """Stop the server we started, if it is still ours."""
    try:
        pid = int(_pid_file().read_text())
    except (OSError, ValueError):
        return False
    _pid_file().unlink(missing_ok=True)
    try:
        cmdline = Path(f'/proc/{pid}/cmdline').read_bytes()
    except OSError:
        return False
    if b'llama-server' not in cmdline:
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    return True


def chat(messages, *, schema=None, max_tokens=160, timeout=30.0, opener=None):
    """One answer from the model, as text. Raises OSError (URLError,
    TimeoutError) when the server cannot be reached or is too slow, and
    ValueError on an answer that is not what the API promises."""
    body = {
        'messages': messages, 'stream': False, 'temperature': 0, 'max_tokens': max_tokens,
        'cache_prompt': True, 'chat_template_kwargs': {'enable_thinking': False},
    }
    if schema is not None:
        body['response_format'] = {'type': 'json_schema', 'json_schema': {'name': 'answer', 'schema': schema}}
    req = urllib.request.Request(f'{URL}/v1/chat/completions', data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with (opener or urllib.request.urlopen)(req, timeout=timeout) as f:
        data = json.loads(f.read().decode())
    try:
        content = data['choices'][0]['message']['content']
    except (KeyError, IndexError, TypeError):
        raise ValueError('unexpected answer from llama-server')
    if not isinstance(content, str):
        raise ValueError('unexpected answer from llama-server')
    return content
