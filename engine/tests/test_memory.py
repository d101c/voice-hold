"""Low memory: the engines refuse to load a model rather than swap."""
import asyncio

import pytest

from voice_hold_engine import llamacpp, memory
from voice_hold_engine.commands import llm
from voice_hold_engine.commands.interpreter import Interpreter


def test_available_reads_meminfo_and_the_override(monkeypatch):
    monkeypatch.delenv('VOICE_HOLD_MEM_AVAILABLE_MB', raising=False)
    assert memory.available_mb() > 0
    monkeypatch.setenv('VOICE_HOLD_MEM_AVAILABLE_MB', '640')
    assert memory.available_mb() == 640
    assert memory.shortage(1200) == '640:1200' and memory.shortage(600) == ''


def test_server_is_not_started_without_room(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_STATE_HOME', str(tmp_path))
    monkeypatch.setenv('VOICE_HOLD_MEM_AVAILABLE_MB', '900')
    monkeypatch.setattr(llamacpp, 'installed', lambda b=None: True)
    monkeypatch.setattr(llamacpp, 'healthy', lambda *a, **k: False)
    spawned = []
    assert llamacpp.ensure(spawn=lambda *a, **k: spawned.append(a)) is False and spawned == []
    assert llamacpp.blocked() == f'llm-low-memory:900:{memory.LLM_NEED_MB}'


def test_blocked_says_why(monkeypatch):
    monkeypatch.setenv('VOICE_HOLD_MEM_AVAILABLE_MB', '900')
    monkeypatch.setattr(llamacpp, 'healthy', lambda *a, **k: False)
    monkeypatch.setattr(llamacpp, 'installed', lambda b=None: False)
    assert llamacpp.blocked() == 'llm-not-installed'
    # Loaded and awake: the memory is already paid for.
    monkeypatch.setattr(llamacpp, 'healthy', lambda *a, **k: True)
    monkeypatch.setattr(llamacpp, 'sleeping', lambda *a, **k: False)
    assert llamacpp.blocked() == ''
    # Asleep: waking it reads the weights again.
    monkeypatch.setattr(llamacpp, 'sleeping', lambda *a, **k: True)
    assert llamacpp.blocked().startswith('llm-low-memory:900:')
    monkeypatch.setenv('VOICE_HOLD_MEM_AVAILABLE_MB', '8000')
    assert llamacpp.blocked() == ''


def test_interpreter_reports_the_reason(fake_apps_local, monkeypatch):
    monkeypatch.setattr(llamacpp, 'blocked', lambda b=None: 'llm-low-memory:900:2300')
    it = Interpreter(apps=fake_apps_local)
    out = it.interpret('optimise mon ordinateur')
    assert out['action'] == 'unknown' and out['reason'] == 'llm-low-memory:900:2300' and out['source'] == 'none'
    # The rules need no model: they still answer.
    assert it.interpret('verrouille l écran')['action'] == 'lock'
    with pytest.raises(llm.Unavailable):
        llm.interpret('x')


@pytest.fixture
def fake_apps_local():
    return [{'id': 'firefox_firefox.desktop', 'name': 'Firefox', 'name_fr': '', 'generic': 'Web Browser',
             'generic_fr': 'Navigateur Web', 'keywords': [], 'exec': 'firefox'}]
