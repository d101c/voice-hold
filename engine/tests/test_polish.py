"""polish() against a fake Ollama: the request shape and the output guards."""
import io
import json

import pytest

from voice_hold_engine import polish as mod
from voice_hold_engine.polish import acceptable, polish


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


@pytest.fixture
def ollama(monkeypatch):
    """Replace urlopen; `box['request']` is the last request, `box['reply']`
    what the model answers (or an exception to raise)."""
    box = {'reply': '', 'request': None}

    def urlopen(req, timeout=None):
        box['request'] = req
        box['timeout'] = timeout
        if isinstance(box['reply'], Exception):
            raise box['reply']
        return FakeResponse(json.dumps({'response': box['reply']}).encode())

    monkeypatch.setattr(mod.urllib.request, 'urlopen', urlopen)
    return box


def test_system_and_text_are_separate(ollama):
    ollama['reply'] = 'Bonjour, ça va ?'
    out = polish('bonjour ça va', url='http://127.0.0.1:11434/', model='m')
    assert out == 'Bonjour, ça va ?'
    req = ollama['request']
    assert req.full_url == 'http://127.0.0.1:11434/api/generate'
    body = json.loads(req.data)
    assert body['prompt'] == 'bonjour ça va', 'the dictated text alone'
    assert body['system'] == mod.SYSTEM
    assert body['model'] == 'm' and body['stream'] is False
    assert ollama['timeout'] == 2.5


def test_new_line_breaks_are_rejected(ollama):
    ollama['reply'] = 'Bonjour.\nÇa va ?'
    assert polish('bonjour ça va') == 'bonjour ça va'


def test_length_drift_is_rejected(ollama):
    ollama['reply'] = 'Bonjour, ça va ? Je suis un assistant et je peux vous aider.'
    assert polish('bonjour ça va') == 'bonjour ça va'
    ollama['reply'] = ''
    assert polish('bonjour ça va') == 'bonjour ça va'


def test_failures_return_the_text(ollama):
    ollama['reply'] = ConnectionRefusedError()
    assert polish('bonjour') == 'bonjour'
    ollama['reply'] = TimeoutError()
    assert polish('bonjour') == 'bonjour'


def test_quotes_around_the_answer_are_stripped(ollama):
    ollama['reply'] = '"Bonjour, ça va ?"'
    assert polish('bonjour ça va') == 'Bonjour, ça va ?'


def test_empty_text_is_not_sent(ollama):
    assert polish('   ') == '   '
    assert ollama['request'] is None


def test_acceptable():
    assert acceptable('un deux trois', 'Un, deux, trois.')
    assert not acceptable('un deux trois', 'Un\ndeux')
    assert not acceptable('un deux trois', '')
    assert acceptable('a\nb', 'A.\nB.'), 'existing line breaks may stay'
