"""Speaker on a fake synthesizer and a fake player (a sleep): no voice, no
sound card needed."""
import os
import time

import pytest

from voice_hold_engine import models, tts


def fake_synth(text, lang, speed):
    return [0.0] * 220, 22050


@pytest.fixture
def speaker(monkeypatch):
    monkeypatch.setattr(models, 'voice_ready', lambda lang, base=None: lang == 'fr')
    return tts.Speaker(player=['sleep', '5'], synth=fake_synth)


def test_speak_writes_a_wav_plays_it_and_cuts_the_previous(speaker):
    p1 = speaker.speak('Bonjour')
    path1 = speaker._file
    assert speaker.speaking and os.path.isfile(path1)
    p2 = speaker.speak('Encore')
    assert p1.poll() is not None and not os.path.exists(path1)
    assert speaker.speaking and p2.poll() is None
    speaker.stop()
    assert not speaker.speaking and p2.poll() is not None and speaker._file is None


def test_empty_text_plays_nothing(speaker):
    assert speaker.speak('   ') is None
    assert not speaker.speaking


def test_finished_drops_the_file(monkeypatch):
    sp = tts.Speaker(player=['true'], synth=fake_synth)
    proc = sp.speak('x')
    path = sp._file
    proc.wait()
    sp.finished()
    assert not os.path.exists(path) and sp._file is None and not sp.speaking


def test_synthesize_bounds_and_normalizes(monkeypatch):
    seen = {}

    def synth(text, lang, speed):
        seen['text'] = text
        return [0.0], 1
    sp = tts.Speaker(synth=synth)
    sp.synthesize('  a \n b  ' + 'x' * 5000)
    assert seen['text'].startswith('a b x') and len(seen['text']) == tts.MAX_CHARS
    assert sp.synthesize('') == ([], 22050)
