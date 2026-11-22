"""The wake word detector: a small streaming recogniser transcribes the
start of each utterance (wake.py only feeds it while someone speaks), and
the words are compared with the wake phrase by sound, loosely (vocab.key):
"hé holdie", "et oldie", "hey holdy" all match "Hé Holdie". Any phrase works,
in any language the model knows, without training.

Only the start of an utterance counts (the phrase within its first words):
the phrase said in the middle of a sentence is speech, not a call.
"""
import json
import os
import re

from . import models
from .audio import SAMPLE_RATE
from .vocab import _distance, key

LEAD_WORDS = 2          # words allowed before the phrase ("euh", "alors")
TAIL_S = 0.15           # after the last token of the phrase, before what follows


def phrases_from_json(text):
    try:
        v = json.loads(text) if text else []
    except ValueError:
        v = []
    phrases = [p.strip() for p in v if isinstance(p, str) and p.strip()] if isinstance(v, list) else []
    return phrases or [DEFAULT_PHRASE]


DEFAULT_PHRASE = 'Hé Holdie'


def model_dir(base=None):
    return os.path.join(base or models.models_dir(), WAKE_MODEL)


WAKE_MODEL = 'sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06'


def _files(base=None):
    d = model_dir(base)
    return {
        'tokens': os.path.join(d, 'tokens.txt'),
        'encoder': os.path.join(d, 'encoder.onnx'),
        'decoder': os.path.join(d, 'decoder.onnx'),
        'joiner': os.path.join(d, 'joiner.onnx'),
    }


def missing(base=None):
    return [n for n, p in _files(base).items() if not os.path.exists(p)]


def tolerance(n, sensitivity):
    """Edits allowed between two phonetic keys of length `n`."""
    if n < 4:
        return 0
    allowed = n * (0.12 + 0.25 * max(0.0, min(1.0, sensitivity)))
    return int(allowed)


def words_with_times(tokens, timestamps):
    """BPE tokens ('▁he', 'll', 'o') and their start times -> [(word, start, end)]."""
    words = []
    for tok, t in zip(tokens, timestamps):
        piece = tok.replace('▁', ' ')
        if piece.startswith(' ') or not words:
            words.append([piece.strip(), t, t])
        else:
            words[-1][0] += piece
            words[-1][2] = t
    return [(w, s, e) for w, s, e in words if w]


def match(words, phrase_keys, sensitivity):
    """End time of the phrase when `words` start with it (after at most
    LEAD_WORDS others), else None. `phrase_keys`: [(key, n_words)]."""
    for k, n in phrase_keys:
        for lead in range(0, LEAD_WORDS + 1):
            for size in sorted({n, n + 1, max(1, n - 1)}, key=lambda s: abs(s - n)):
                run = words[lead:lead + size]
                if len(run) < size:
                    continue
                said = key(' '.join(w for w, _, _ in run))
                if said and _distance(said, k) <= tolerance(len(k), sensitivity):
                    return run[-1][2]
    return None


class Detector:
    def __init__(self, phrases, *, sensitivity=0.5, base=None, recognizer=None, threads=1):
        self.sensitivity = sensitivity
        self._keys = [(key(p), len(p.split())) for p in phrases if key(p)]
        if recognizer is None:
            import sherpa_onnx
            f = _files(base)
            recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                tokens=f['tokens'], encoder=f['encoder'], decoder=f['decoder'], joiner=f['joiner'],
                num_threads=threads, sample_rate=SAMPLE_RATE, feature_dim=80, decoding_method='greedy_search')
        self._recognizer = recognizer
        self._stream = None
        self.reset()

    def reset(self):
        self._stream = self._recognizer.create_stream()
        self._seen = ''

    def accept(self, samples):
        """Feed audio; (phrase, end in seconds from the first sample fed
        since reset()) once the phrase is heard, else None."""
        self._stream.accept_waveform(SAMPLE_RATE, samples)
        while self._recognizer.is_ready(self._stream):
            self._recognizer.decode_stream(self._stream)
        r = self._recognizer.get_result_all(self._stream)
        text = getattr(r, 'text', '') or ''
        if text == self._seen:
            return None
        self._seen = text
        words = words_with_times(list(getattr(r, 'tokens', []) or []), list(getattr(r, 'timestamps', []) or []))
        if not words:
            words = [(w, 0.0, 0.0) for w in re.findall(r"[\w'’-]+", text)]
        end = match(words, self._keys, self.sensitivity)
        if end is None:
            return None
        return text, end + TAIL_S
