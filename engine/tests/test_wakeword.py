import hashlib
import io
import tarfile
from types import SimpleNamespace

from voice_hold_engine import models
from voice_hold_engine import wakeword as ww


def keys(*phrases):
    return [(ww.key(p), len(p.split())) for p in phrases]


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
        s = SimpleNamespace(fed=0, finished=False)
        s.accept_waveform = lambda rate, x: setattr(s, 'fed', s.fed + len(x))
        s.input_finished = lambda: setattr(s, 'finished', True)
        return s

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


# -- measured choices (wake-word bench, issue #16) -------------------------------

def test_default_phrase_and_the_ways_kroko_writes_it():
    assert ww.DEFAULT_PHRASE == 'Hé Kodiak'
    k = ww.key(ww.DEFAULT_PHRASE)
    assert k == 'ekodiak'
    # what Kroko wrote for "Hé Kodiak" on the bench
    for said in ['Écodiaque', 'Et Codiaque', 'est codiaque', 'hey kodiak', 'Hé, Kodiak !']:
        assert ww._distance(ww.key(said), k) <= ww.tolerance(len(k), 0.5), said


def test_per_word_key_meets_french_spellings_of_english_names():
    assert ww.key('Ok Voice Hold') == ww.key('oké voïsse hold') == ww.key('ok vois hold')
    assert ww.key('Hé Holdie') == ww.key('et oldie') == ww.key('hey holdy')


def test_default_sensitivity_allows_two_edits_on_long_keys_only():
    assert ww.tolerance(7, 0.5) == 2          # "ekodiak"
    assert ww.tolerance(5, 0.5) == 1          # "eoldi", "alold": short keys stay strict
    assert ww.tolerance(7, 0.0) == 1


def test_default_phrase_not_in_ordinary_speech():
    k = keys(ww.DEFAULT_PHRASE)
    for words in [('et', 'alors'), ('écoute', 'jeff'), ('et', 'qu', 'est-ce', 'que', 'tu', 'dis'),
                  ('hey', 'guys'), ('et', 'aujourd', 'hui'), ('et', 'alors', 'quoi', 'de', 'neuf')]:
        assert ww.match(W(*words), k, 0.5) is None, words


def test_known_near_miss_at_the_default_sensitivity():
    # "zodiaque", "Kodak" are 2 edits from "ekodiak": they wake at 0.5 when they
    # start an utterance (none did in the 3 h of negatives of the bench), not at 0
    k = keys(ww.DEFAULT_PHRASE)
    for words in [('zodiaque', 'du', 'jour'), ('et', 'alors', 'kodak')]:
        assert ww.match(W(*words), k, 0.5) is not None, words
        assert ww.match(W(*words), k, 0.0) is None, words


def test_punctuation_tokens_end_a_word():
    out = ww.words_with_times([' Et', ' Cod', 'iaque', ',', 'je'], [0.1, 0.3, 0.5, 0.6, 0.7])
    assert [w for w, _, _ in out] == ['Et', 'Codiaque', 'je']


def test_flush_finds_the_phrase_said_alone():
    # Kroko only emits its last ~1.3 s chunk once the stream is finished
    rec = FakeRecognizer([('', [], []), (' Écodiaque.', [' É', 'cod', 'iaque', '.'], [0.4, 0.5, 0.7, 0.9])])
    d = ww.Detector(['Hé Kodiak'], recognizer=rec)
    assert d.accept([0.0] * 512) is None
    text, end = d.flush()
    assert text == ' Écodiaque.' and abs(end - (0.7 + ww.TAIL_S)) < 1e-9
    assert d._stream.finished and d._stream.fed >= ww.FLUSH_S * 16000
    assert d.accept([0.0] * 512) is None and d.flush() is None     # finished until reset()
    d.reset()
    assert not d._stream.finished


# -- setup --wake -------------------------------------------------------------------

def test_setup_wake_installs_the_pinned_model(monkeypatch, tmp_path):
    files = {'encoder.onnx': b'E' * 300, 'decoder.onnx': b'D' * 50, 'joiner.onnx': b'J' * 20,
             'tokens.txt': b'<blk> 0\n'}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:bz2') as tar:
        for name, data in list(files.items()) + [('test_wavs/0.wav', b'RIFF'), ('README.md', b'x')]:
            ti = tarfile.TarInfo(f'{models.WAKE_NAME}/{name}')
            ti.size = len(data)
            tar.addfile(ti, io.BytesIO(data))
    archive = buf.getvalue()
    sha = lambda b: hashlib.sha256(b).hexdigest()
    monkeypatch.setattr(models, 'WAKE_MODEL', {
        'archive_size': len(archive), 'archive_sha256': sha(archive),
        'files': {n: (len(d), sha(d)) for n, d in files.items()}})

    class Resp(io.BytesIO):
        headers = {'Content-Length': '0'}
        def __enter__(self):
            return self
        def __exit__(self, *a):
            self.close()

    urls = []
    monkeypatch.setattr(models.urllib.request, 'urlopen',
                        lambda req, timeout=None: (urls.append(req.full_url), Resp(archive))[1])
    base = tmp_path / 'models'
    assert ww.missing(base) and models.wake_missing(base)
    assert models.setup_wake(base, lambda s: None) == []
    assert urls == [models.RELEASES + models.WAKE_NAME + '.tar.bz2']
    assert ww.missing(base) == [] and models.wake_verify(base) == []
    assert not (base / models.WAKE_NAME / 'test_wavs').exists()
    assert models.setup_wake(base, lambda s: None) == [] and len(urls) == 1     # nothing to do twice
    (base / models.WAKE_NAME / 'joiner.onnx').write_bytes(b'X' * 20)               # same size, other bytes
    assert models.wake_verify(base) == [f'{models.WAKE_NAME}/joiner.onnx']


def test_real_wake_pins_are_well_formed():
    assert ww.WAKE_MODEL == models.WAKE_NAME
    assert len(models.WAKE_MODEL['archive_sha256']) == 64 and models.WAKE_MODEL['archive_size'] > 50_000_000
    assert set(models.WAKE_MODEL['files']) == {'encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'}
