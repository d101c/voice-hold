import io
import json

from voice_hold_engine.commands import llm
from voice_hold_engine.commands.interpreter import Interpreter


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener_returning(content):
    calls = []

    def opener(req, timeout=None):
        calls.append(json.loads(req.data.decode()))
        body = {'choices': [{'message': {'role': 'assistant', 'content': content}}]}
        return FakeResponse(json.dumps(body).encode())
    opener.calls = calls
    return opener


def test_interpret_sends_schema_and_parses():
    op = opener_returning('{"action":"run_shell","command":"df -h ~","needs_confirmation":false}')
    out = llm.interpret('combien de place sur le disque', opener=op, timeout=5)
    assert out == {'action': 'run_shell', 'command': 'df -h ~', 'needs_confirmation': False}
    sent = op.calls[0]
    assert sent['response_format']['json_schema']['schema'] == llm.SCHEMA
    assert sent['chat_template_kwargs'] == {'enable_thinking': False} and sent['stream'] is False
    assert sent['cache_prompt'] is True and sent['temperature'] == 0
    assert sent['messages'][0]['content'] == llm.SYSTEM


def test_parse_tolerates_fences_and_prose():
    assert llm.parse('```json\n{"action":"lock"}\n```') == {'action': 'lock'}
    assert llm.parse('Sure! {"action":"unknown"} there you go') == {'action': 'unknown'}
    assert llm.parse('{"action":"fly"}') is None
    assert llm.parse('not json') is None
    assert llm.parse(None) is None


def test_unreachable_gives_none():
    def opener(req, timeout=None):
        raise OSError('connection refused')
    assert llm.interpret('x', opener=opener) is None


def test_interpreter_falls_back_and_guards(fake_apps):
    seen = []

    def fake_llm(text):
        seen.append(text)
        return {'action': 'run_shell', 'command': 'rm -rf /', 'needs_confirmation': False}
    it = Interpreter(apps=fake_apps, llm_fn=fake_llm)
    out = it.interpret('optimise mon ordinateur')
    assert seen == ['optimise mon ordinateur']
    assert out['action'] == 'run_shell' and out['refused'] and out['needs_confirmation']
    assert out['source'] == 'llm'
    # rules decide without the LLM
    out = it.interpret('ouvre firefox')
    assert out['source'] == 'rules' and out['app_id'] == 'firefox_firefox.desktop' and seen == ['optimise mon ordinateur']


def test_interpreter_llm_off_and_unavailable(fake_apps):
    it = Interpreter(apps=fake_apps, use_llm=False)
    assert it.interpret('optimise mon ordinateur')['reason'] == 'llm-off'
    it = Interpreter(apps=fake_apps, llm_fn=lambda *a, **k: None)
    assert it.interpret('optimise mon ordinateur')['reason'] == 'llm-unavailable'


def test_interpreter_maps_llm_app_names_to_installed(fake_apps):
    it = Interpreter(apps=fake_apps, llm_fn=lambda *a, **k: {'action': 'open_app', 'name': 'chrome'})
    out = it.interpret('je veux naviguer avec chrome')
    assert out['app_id'] == 'google-chrome.desktop'
    it = Interpreter(apps=fake_apps, llm_fn=lambda *a, **k: {'action': 'open_app', 'name': 'photoshop'})
    assert it.interpret('je veux photoshop')['action'] == 'unknown'


def test_warm_up_runs_the_system_prompt_with_the_cold_timeout():
    seen = []

    def opener(req, timeout=None):
        seen.append((req.full_url.rsplit('/', 1)[-1], json.loads(req.data.decode()), timeout))
        return FakeResponse(json.dumps({'choices': [{'message': {'content': '{"action":"unknown"}'}}]}).encode())
    assert llm.warm_up(opener=opener) is True
    path, payload, timeout = seen[0]
    assert path == 'completions' and timeout == llm.COLD_TIMEOUT_S
    assert payload['messages'][0] == {'role': 'system', 'content': llm.SYSTEM}
    assert payload['response_format']['json_schema']['schema'] == llm.SCHEMA
    assert payload['max_tokens'] <= 16
    llm.interpret('verrouille', opener=opener)
    assert seen[1][2] == llm.TIMEOUT_S


def test_interpret_raises_timeout_when_the_server_is_slow():
    import urllib.error
    import pytest

    def url_error(req, timeout=None):
        raise urllib.error.URLError(TimeoutError('timed out'))

    def plain(req, timeout=None):
        raise TimeoutError()
    for opener in (url_error, plain):
        with pytest.raises(llm.Timeout):
            llm.interpret('x', opener=opener)


def test_garbage_from_the_server_gives_none():
    def opener(req, timeout=None):
        return FakeResponse(b'{"error": "boom"}')
    assert llm.interpret('x', opener=opener) is None


def test_interpreter_reports_llm_timeout(fake_apps):
    from voice_hold_engine.commands.interpreter import Interpreter

    def slow(text, **kw):
        raise llm.Timeout()
    it = Interpreter(apps=fake_apps, use_llm=True, llm_fn=slow)
    out = it.interpret('optimise mon ordinateur')
    assert out['action'] == 'unknown' and out['reason'] == 'llm-timeout'


def test_summarize_goes_through_the_answer_action():
    seen = {}

    def opener(req, timeout):
        import io, json as _json
        seen['payload'] = _json.loads(req.data)
        return io.BytesIO(_json.dumps({'choices': [{'message': {'content': '{"action":"answer","text":"Il reste  28 Go libres."}'}}]}).encode())
    out = llm.summarize('place disque', 'df -h ~', 'Filesystem Size Used Avail\n/dev/sda5 358G 312G 28G', timeout=1, opener=opener)
    assert out == 'Il reste 28 Go libres.'
    msgs = seen['payload']['messages']
    assert msgs[0]['content'] == llm.SYSTEM and 'df -h ~' in msgs[1]['content'] and '28G' in msgs[1]['content']
    assert seen['payload']['max_tokens'] == 80


def test_summarize_returns_empty_on_anything_else():
    import io, json as _json
    def unknown(req, timeout):
        return io.BytesIO(_json.dumps({'choices': [{'message': {'content': '{"action":"unknown"}'}}]}).encode())
    assert llm.summarize('x', 'ls', 'a', timeout=1, opener=unknown) == ''

    def boom(req, timeout):
        raise OSError('down')
    assert llm.summarize('x', 'ls', 'a' * 5000, timeout=1, opener=boom) == ''
