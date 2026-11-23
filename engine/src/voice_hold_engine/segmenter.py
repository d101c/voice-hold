"""Cut a microphone stream into speech segments and live partial windows.

The segmenter is free of sherpa-onnx so it can be tested with a fake VAD.
A VAD object must provide:
  accept(chunk: np.ndarray) -> list[np.ndarray]   finished speech segments
  flush() -> list[np.ndarray]                      segments still open
  in_speech: bool                                  speech going on right now

Events returned by feed()/flush() are tuples:
  ('start',)            speech just started (one per segment)
  ('partial', samples)  the current segment so far (bounded window); decode
                        it to show live text
  ('final', samples, context)
                        a finished segment; decode it and commit the text.
                        `context` is the audio just before it (may be empty),
                        for a recogniser that can listen to it first.

When the VAD tells where its segments start (accept() returning
(start_sample, samples) pairs, as asr.SileroVad does), the finals are cut
from the stream itself and are contiguous: what the VAD took for silence
between two segments of a sentence (a quiet word, a breath) is still
decoded. A pause shorter than GAP_FILL_S belongs to the next segment; a
longer one is trimmed to PAD_BEFORE_S; PAD_AFTER_S is kept after each.
"""
import numpy as np

SAMPLE_RATE = 16000


# The partial window must be at least the VAD's longest segment (8 s in
# asr.SileroVad) plus the pre-roll, or the live text loses its first words
# before the final restores them. The engine passes the exact value.
DEFAULT_PARTIAL_WINDOW_S = 9.0

GAP_FILL_S = 1.0
PAD_BEFORE_S = 0.5
PAD_AFTER_S = 0.25
CONTEXT_S = 3.0


class Segmenter:
    # The VAD says "speech" 0.3 to 0.5 s after it began (min_speech_s plus
    # its own window): 0.3 s of pre-roll cut the first syllables of a
    # dictation. 0.8 s keeps them, at the cost of a little silence decoded.
    def __init__(self, vad, *, pre_roll_s=0.8, partial_window_s=DEFAULT_PARTIAL_WINDOW_S,
                 partial_min_new_s=0.7, sample_rate=SAMPLE_RATE):
        self._vad = vad
        self._rate = sample_rate
        self._pre_roll = int(pre_roll_s * sample_rate)
        self._window = int(partial_window_s * sample_rate)
        self._min_new = int(partial_min_new_s * sample_rate)
        self._tail = np.zeros(0, dtype=np.float32)   # audio kept for pre-roll
        self._current = None                         # samples of the open segment
        self._since_partial = 0
        # The stream, for finals cut from it: audio from absolute sample
        # self._kept_from to self._pos, and where the last final ended.
        self._kept = np.zeros(0, dtype=np.float32)
        self._kept_from = 0
        self._pos = 0
        self._last_end = 0
        self._keep_max = int((partial_window_s + GAP_FILL_S + CONTEXT_S + 2.0) * sample_rate)

    @property
    def in_speech(self):
        return self._current is not None

    @property
    def partial_window_s(self):
        return self._window / self._rate

    def _keep(self, chunk):
        self._kept = np.concatenate([self._kept, chunk])
        self._pos += len(chunk)
        extra = len(self._kept) - self._keep_max
        if extra > 0:
            self._kept = self._kept[extra:]
            self._kept_from += extra

    def _slice(self, a, b):
        a, b = max(a, self._kept_from), min(b, self._pos)
        if b <= a:
            return np.zeros(0, dtype=np.float32)
        return self._kept[a - self._kept_from:b - self._kept_from].copy()

    def _final(self, seg):
        """('final', samples, context) for a VAD segment: (start, samples)
        cut from the stream, or the bare samples of a VAD that does not say
        where they start."""
        if not isinstance(seg, tuple):
            return ('final', np.asarray(seg, dtype=np.float32), np.zeros(0, dtype=np.float32))
        start, samples = seg
        end = start + len(samples)
        gap = start - self._last_end
        a = self._last_end if gap < GAP_FILL_S * self._rate else start - int(PAD_BEFORE_S * self._rate)
        a = max(a, self._last_end)
        b = end + int(PAD_AFTER_S * self._rate)
        out = self._slice(a, b)
        context = self._slice(a - int(CONTEXT_S * self._rate), a)
        self._last_end = min(b, self._pos)
        return ('final', out, context)

    def feed(self, chunk):
        chunk = np.asarray(chunk, dtype=np.float32)
        events = []
        self._keep(chunk)
        finished = self._vad.accept(chunk)
        for seg in finished:
            if self._current is None:
                events.append(('start',))
            events.append(self._final(seg))
            self._current = None
            self._since_partial = 0

        if self._vad.in_speech:
            if self._current is None:
                events.append(('start',))
                self._current = self._tail[-self._pre_roll:] if self._pre_roll else np.zeros(0, np.float32)
                self._since_partial = 0
            self._current = np.concatenate([self._current, chunk])
            self._since_partial += len(chunk)
            if self._since_partial >= self._min_new:
                self._since_partial = 0
                events.append(('partial', self._current[-self._window:]))
        elif self._current is not None and not finished:
            # The VAD left speech without producing a segment (too short):
            # drop it quietly.
            self._current = None
            self._since_partial = 0

        self._tail = np.concatenate([self._tail, chunk])[-max(self._pre_roll, 1):]
        return events

    def flush(self):
        events = [self._final(seg) for seg in self._vad.flush()]
        if not events and self._current is not None and len(self._current) >= self._rate // 4:
            # The VAD had not closed the segment yet; use what we have.
            events.append(('final', self._current, np.zeros(0, dtype=np.float32)))
        self._current = None
        self._since_partial = 0
        return events


def rms(chunk):
    """Loudness of a chunk, 0..1, for the level meter."""
    chunk = np.asarray(chunk, dtype=np.float32)
    if chunk.size == 0:
        return 0.0
    v = float(np.sqrt(np.mean(chunk * chunk)))
    # Speech peaks around 0.1-0.3 RMS; scale so normal speech fills the meter.
    return min(1.0, v * 4.0)
