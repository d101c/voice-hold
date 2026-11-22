from types import SimpleNamespace

from voice_hold_engine import wakeword as ww
from voice_hold_engine.vocab import key


def keys(*phrases):
    return [(key(p), len(p.split())) for p in phrases]


def W(*words):
    return [(w, i * 0.3, i * 0.3 + 0.2) for i, w in enumerate(words)]


def test_words_from_bpe_tokens():
    out = ww.words_with_times(['▁hé', '▁hol', 'die', '▁je'], [0.1, 0.4, 0.6, 0.9])
    assert out == [('hé', 0.1, 0.1), ('holdie', 0.4, 0.6), ('je', 0.9, 0.9)]


def test_phrase_at_the_start_matches_loosely():
    k = keys('Hé Holdie')
    assert ww.match(W('hé', 'holdie', 'je', 'serai'), k, 0.5) is not None
    assert ww.match(W('et', 'oldie', 'je', 'serai'), k, 0.5) is not None
    assert ww.match(W('hey', 'holdy'), k, 0.5) is not None
    assert ww.match(W('euh', 'hé', 'holdie'), k, 0.5) is not None


def test_end_time_is_the_last_word_of_the_phrase():
    assert ww.match(W('hé', 'holdie', 'je'), keys('Hé Holdie'), 0.5) == 0.3 + 0.2


def test_ordinary_speech_does_not_match():
    k = keys('Hé Holdie')
    for words in [('je', 'serai', 'à', 'genève'), ('il', 'fait', 'beau'), ('hello', 'everyone'),
                  ('holà', 'tout', 'le', 'monde'), ('et', 'alors')]:
        assert ww.match(W(*words), k, 0.5) is None, words


def test_phrase_in_the_middle_of_a_sentence_is_not_a_call():
    assert ww.match(W('je', 'lui', 'ai', 'dit', 'hé', 'holdie'), keys('Hé Holdie'), 0.5) is None


def test_sensitivity_widens_the_tolerance():
    assert ww.tolerance(8, 0.0) < ww.tolerance(8, 1.0)
    assert ww.tolerance(3, 1.0) == 0


def test_phrases_from_json():
    assert ww.phrases_from_json('["Hé Holdie", " ", 3]') == ['Hé Holdie']
    assert ww.phrases_from_json('') == [ww.DEFAULT_PHRASE]
    assert ww.phrases_from_json('{bad') == [ww.DEFAULT_PHRASE]


class FakeRecognizer:
    def __init__(self, script):
        self.script = list(script)      # results returned one per accept

    def create_stream(self):
        return SimpleNamespace(accept_waveform=lambda rate, s: None)

    def is_ready(self, stream):
        return False

    def get_result_all(self, stream):
        text, tokens, times = self.script.pop(0) if self.script else ('', [], [])
        return SimpleNamespace(text=text, tokens=tokens, timestamps=times)


def test_detector_reports_the_phrase_and_its_end():
    rec = FakeRecognizer([
        ('hé', ['▁hé'], [0.2]),
        ('hé holdie je', ['▁hé', '▁hol', 'die', '▁je'], [0.2, 0.5, 0.7, 1.0]),
    ])
    d = ww.Detector(['Hé Holdie'], recognizer=rec)
    assert d.accept([0.0] * 10) is None
    text, end = d.accept([0.0] * 10)
    assert text == 'hé holdie je' and abs(end - (0.7 + ww.TAIL_S)) < 1e-9
