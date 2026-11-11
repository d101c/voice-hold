"""llamacpp: pinned downloads, the server command line, start and stop."""
import hashlib
import io
import json
import tarfile

import pytest

from voice_hold_engine import llamacpp, models


@pytest.fixture
def base(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_STATE_HOME', str(tmp_path / 'state'))
    return tmp_path / 'llm'


def _archive():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        for name, data, mode in (('llama-server', b'#!/bin/sh\n', 0o755), ('libllama.so', b'L', 0o644),
                                 ('llama-cli', b'C', 0o755), ('LICENSE', b'MIT', 0o644)):
            ti = tarfile.TarInfo(f'{llamacpp.SERVER_NAME}/{name}')
            ti.size = len(data)
            ti.mode = mode
            tar.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def test_setup_fetches_server_and_model_with_pins(base, monkeypatch):
    archive, model = _archive(), b'G' * 500
    served = {llamacpp.SERVER_URL: archive, llamacpp.MODEL_URL: model}
    monkeypatch.setattr(llamacpp, 'SERVER_SIZE', len(archive))
    monkeypatch.setattr(llamacpp, 'SERVER_SHA256', hashlib.sha256(archive).hexdigest())
    monkeypatch.setattr(llamacpp, 'MODEL_SIZE', len(model))
    monkeypatch.setattr(llamacpp, 'MODEL_SHA256', hashlib.sha256(model).hexdigest())

    class Resp(io.BytesIO):
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            self.close()
    monkeypatch.setattr(models.urllib.request, 'urlopen', lambda req, timeout=None: Resp(served[req.full_url]))
    assert llamacpp.missing(base) == [llamacpp.SERVER_NAME, llamacpp.MODEL_FILE]
    assert llamacpp.setup(base) == [] and llamacpp.installed(base)
    kept = sorted(p.name for p in (base / llamacpp.SERVER_NAME).iterdir())
    assert kept == ['LICENSE', 'libllama.so', 'llama-server'], 'only the server and its libraries'
    # A tampered model is refused and leaves nothing behind.
    llamacpp.model_path(base).unlink()
    served[llamacpp.MODEL_URL] = b'H' * 500
    with pytest.raises(RuntimeError, match='pinned checksum'):
        llamacpp.setup(base)
    assert llamacpp.missing(base) == [llamacpp.MODEL_FILE] and not list(base.glob('*.part'))


def test_real_pins_and_command_line(base):
    assert len(llamacpp.SERVER_SHA256) == 64 and len(llamacpp.MODEL_SHA256) == 64
    assert llamacpp.MODEL_URL.startswith('https://huggingface.co/') and '/resolve/main/' not in llamacpp.MODEL_URL
    cmd = llamacpp.command(base, threads=3)
    assert cmd[0].endswith('llama-server') and cmd[cmd.index('--host') + 1] == '127.0.0.1'
    assert cmd[cmd.index('-t') + 1] == '3' and cmd[cmd.index('-ngl') + 1] == '0'
    for flag in ('--swa-full', '--no-webui', '--jinja', '--sleep-idle-seconds'):
        assert flag in cmd


def test_ensure_does_not_spawn_when_not_installed_or_already_up(base, monkeypatch):
    spawned = []
    monkeypatch.setattr(llamacpp, 'healthy', lambda *a, **k: False)
    assert llamacpp.ensure(base=base, spawn=lambda *a, **k: spawned.append(a)) is False
    monkeypatch.setattr(llamacpp, 'healthy', lambda *a, **k: True)
    assert llamacpp.ensure(base=base, spawn=lambda *a, **k: spawned.append(a)) is True
    assert spawned == []


def test_ensure_spawns_detached_and_stop_only_kills_a_llama_server(base, monkeypatch):
    monkeypatch.setattr(llamacpp, 'installed', lambda b=None: True)
    state = {'up': False}
    monkeypatch.setattr(llamacpp, 'healthy', lambda *a, **k: state['up'])
    calls = []

    class Proc:
        pid = 2 ** 22 + 12345          # no such process

        def poll(self):
            state['up'] = True         # "loaded" by the second look
            return None

    def spawn(cmd, **kw):
        calls.append((cmd, kw))
        return Proc()
    assert llamacpp.ensure(base=base, spawn=spawn, wait_s=5) is True
    cmd, kw = calls[0]
    assert kw['start_new_session'] is True and str(base) in kw['env']['LD_LIBRARY_PATH']
    assert llamacpp._pid_file().read_text() == str(Proc.pid)
    assert llamacpp.stop() is False, 'a pid that is not a llama-server is left alone'
    assert not llamacpp._pid_file().exists()


def test_chat_shapes_the_request_and_checks_the_answer():
    seen = {}

    def opener(req, timeout=None):
        seen.update(url=req.full_url, body=json.loads(req.data), timeout=timeout)
        return io.BytesIO(json.dumps({'choices': [{'message': {'content': 'ok'}}]}).encode())
    assert llamacpp.chat([{'role': 'user', 'content': 'x'}], schema={'type': 'object'}, opener=opener) == 'ok'
    assert seen['url'] == llamacpp.URL + '/v1/chat/completions'
    assert seen['body']['response_format'] == {'type': 'json_schema', 'json_schema': {'name': 'answer', 'schema': {'type': 'object'}}}
    with pytest.raises(ValueError):
        llamacpp.chat([], opener=lambda req, timeout=None: io.BytesIO(b'{"choices": []}'))
