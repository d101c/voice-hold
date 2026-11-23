"""The wake word detector: a small streaming French recogniser (Kroko,
zipformer transducer, one thread) transcribes the start of each utterance
(wake.py only feeds it while someone speaks), and the first words are
compared with the wake phrase by sound, loosely (key()): "Hé Kodiak",
"et codiaque", "hey kodiak" all match. Any phrase works, without training,
as long as it is said the French way: Kroko writes nothing for English
speech.

Only the start of an utterance counts (the phrase within its first words):
the phrase said in the middle of a sentence is speech, not a call.

Kroko decodes about 1.3 s of audio at a time, so the last words of an
utterance only come out once the stream is finished: an isolated "Hé
Kodiak" followed by a pause is found by flush(), which wake.py calls when
the speech ends.

Choices measured on the wake-word bench (voice-hold-bench, results/
WAKE-REPORT.md, issue #16): an English keyword spotter never fires on
French speakers, Kroko used as a keyword spotter finds fewer wake words
than Kroko + this matching, and "Hé Kodiak" is the candidate Kroko
transcribes most consistently, with no false wake on 3 h of French and
English meetings at the default sensitivity.
"""
import json
import os
import re
import unicodedata
from pathlib import Path

import numpy as np

from . import models
from .audio import SAMPLE_RATE

LEAD_WORDS = 2          # words allowed before the phrase ("euh", "alors")
# Kroko's token times lag the audio by about a token: the start time of the
# phrase's last token is already close to the end of the word (bench: cut
# median +0.01 s, 80 % within -0.11..+0.10 s of the true end).
TAIL_S = 0.0
FLUSH_S = 1.5           # silence fed when the speech ends, so Kroko emits its last chunk


def phrases_from_json(text):
    try:
        v = json.loads(text) if text else []
    except ValueError:
        v = []
    phrases = [p.strip() for p in v if isinstance(p, str) and p.strip()] if isinstance(v, list) else []
    return phrases or [DEFAULT_PHRASE]


DEFAULT_PHRASE = 'Hé Kodiak'


def model_dir(base=None):
    return os.path.join(base or models.models_dir(), WAKE_MODEL)


WAKE_MODEL = models.WAKE_NAME   # pinned and downloaded by models.setup_wake (`setup --wake`)


def _files(base=None):
    d = model_dir(base)
    return {
        'tokens': os.path.join(d, 'tokens.txt'),
        'encoder': os.path.join(d, 'encoder.onnx'),
        'decoder': os.path.join(d, 'decoder.onnx'),
        'joiner': os.path.join(d, 'joiner.onnx'),
    }


def missing(base=None):
    """Model files absent or not of the pinned size."""
    return models.wake_missing(Path(base) if base else None)


# -- phonetic key ---------------------------------------------------------------
# Word by word, so that "hé", "hey", "et", "est" all become "e", and the
# French spellings of an English name meet it ("voïce", "vois" -> "vwa").
_RULES = [(re.compile(a), b) for a, b in [
    (r'ph', 'f'), (r'(?:ch|sh)', 'S'), (r'h', ''),
    (r'eau', 'o'), (r'au', 'o'), (r'ou', 'u'), (r'o[iy]', 'wa'),
    (r'(?:ai|ei|ay|ey)', 'e'), (r'(?<=.)(?:er|ez|et)$', 'e'), (r'^(?:et|est)$', 'e'),
    (r'qu', 'k'), (r'ck', 'k'), (r'c(?=[eiy])', 's'), (r'c', 'k'), (r'x', 'ks'),
    (r'gu(?=[ei])', 'g'), (r'ee', 'i'), (r'oo', 'u'), (r'y', 'i'), (r'(.)\1+', r'\1'),
    (r'(?<=..)e$', ''), (r'(?<=.)[sx]$', ''),
]]


def _strip_accents(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


def word_key(word):
    w = re.sub(r'[^a-z]', '', _strip_accents(word.lower()))
    for pattern, repl in _RULES:
        w = pattern.sub(repl, w)
    return w


def key(text):
    """Phonetic key of a phrase: the words' keys joined, doubled letters once.
    "Hé Kodiak", "et codiaque" -> "ekodiak"."""
    s = ''.join(word_key(w) for w in re.split(r"[\s'’\-.,;:!?…]+", text) if w)
    return re.sub(r'(.)\1+', r'\1', s)


def _distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def tolerance(n, sensitivity):
    """Edits allowed between two phonetic keys of length `n`. At the default
    0.5: 1 edit for a 5-letter key, 2 for "ekodiak" (7) or "okvwaold" (8),
    where the bench saw no false wake; short keys at 2 edits ("alold") fire
    on ordinary speech."""
    if n < 4:
        return 0
    s = max(0.0, min(1.0, sensitivity))
    return int(n * (0.1 + 0.3 * s) + 0.5)


def words_with_times(tokens, timestamps):
    """BPE tokens ('▁he', 'll', 'o', or ' he' as Kroko gives them) and their
    start times -> [(word, start, end)]. A punctuation token ends a word."""
    words = []
    cut = True
    for tok, t in zip(tokens, timestamps):
        piece = tok.replace('▁', ' ')
        core = piece.strip()
        if not core or not re.search(r'\w', core):
            cut = True
            continue
        if piece.startswith(' ') or cut:
            words.append([core, t, t])
        else:
            words[-1][0] += core
            words[-1][2] = t
        cut = False
    return [(w, s, e) for w, s, e in words if w]


def match(words, phrase_keys, sensitivity):
    """End time of the phrase when `words` start with it (after at most
    LEAD_WORDS others), else None. `phrase_keys`: [(key, n_words)]."""
    for k, n in phrase_keys:
        tol = tolerance(len(k), sensitivity)
        for lead in range(0, LEAD_WORDS + 1):
            for size in sorted({n, n + 1, max(1, n - 1)}, key=lambda s: abs(s - n)):
                run = words[lead:lead + size]
                if len(run) < size:
                    continue
                said = key(' '.join(w for w, _, _ in run))
                if said and _distance(said, k) <= tol:
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
        self._finished = False

    def accept(self, samples):
        """Feed audio; (phrase, end in seconds from the first sample fed
        since reset()) once the phrase is heard, else None."""
        if self._finished:
            return None
        self._stream.accept_waveform(SAMPLE_RATE, np.asarray(samples, dtype=np.float32))
        return self._decode()

    def flush(self):
        """The speech has ended: decode what Kroko still holds, the phrase
        said alone before a pause only comes out here. Same result as
        accept(); call reset() before the next utterance."""
        if self._finished:
            return None
        self._finished = True
        self._stream.accept_waveform(SAMPLE_RATE, np.zeros(int(FLUSH_S * SAMPLE_RATE), dtype=np.float32))
        self._stream.input_finished()
        return self._decode()

    def _decode(self):
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
