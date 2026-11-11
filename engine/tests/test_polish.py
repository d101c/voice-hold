"""polish() against a fake llama.cpp server: the request shape and the output guards."""
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
def server(monkeypatch):
    """Replace urlopen; `box['request']` is the last request, `box['reply']`
    what the model answers (or an exception to raise)."""
    box = {'reply': '', 'request': None}

    def urlopen(req, timeout=None):
        box['request'] = req
        box['timeout'] = timeout
        if isinstance(box['reply'], Exception):
            raise box['reply']
        return FakeResponse(json.dumps({'choices': [{'message': {'content': box['reply']}}]}).encode())

    monkeypatch.setattr(mod.llamacpp.urllib.request, 'urlopen', urlopen)
    return box


def test_system_and_text_are_separate(server):
    server['reply'] = 'Bonjour, ça va ?'
    out = polish('bonjour ça va')
    assert out == 'Bonjour, ça va ?'
    req = server['request']
    assert req.full_url == mod.llamacpp.URL + '/v1/chat/completions'
    body = json.loads(req.data)
    assert body['messages'] == [{'role': 'system', 'content': mod.SYSTEM},
                                {'role': 'user', 'content': 'bonjour ça va'}], 'the dictated text alone'
    assert body['stream'] is False and body['temperature'] == 0
    assert body['chat_template_kwargs'] == {'enable_thinking': False}
    assert 'response_format' not in body
    assert server['timeout'] == 4.0


def test_new_line_breaks_are_rejected(server):
    server['reply'] = 'Bonjour.\nÇa va ?'
    assert polish('bonjour ça va') == 'bonjour ça va'


def test_length_drift_is_rejected(server):
    server['reply'] = 'Bonjour, ça va ? Je suis un assistant et je peux vous aider.'
    assert polish('bonjour ça va') == 'bonjour ça va'
    server['reply'] = ''
    assert polish('bonjour ça va') == 'bonjour ça va'


def test_failures_return_the_text(server):
    server['reply'] = ConnectionRefusedError()
    assert polish('bonjour') == 'bonjour'
    server['reply'] = TimeoutError()
    assert polish('bonjour') == 'bonjour'


def test_quotes_around_the_answer_are_stripped(server):
    server['reply'] = '"Bonjour, ça va ?"'
    assert polish('bonjour ça va') == 'Bonjour, ça va ?'


def test_empty_text_is_not_sent(server):
    assert polish('   ') == '   '
    assert server['request'] is None


def test_acceptable():
    assert acceptable('un deux trois', 'Un, deux, trois.')
    assert not acceptable('un deux trois', 'Un\ndeux')
    assert not acceptable('un deux trois', '')
    assert acceptable('a\nb', 'A.\nB.'), 'existing line breaks may stay'
