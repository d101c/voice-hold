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
  ('final', samples)    a finished segment; decode it and commit the text
"""
import numpy as np

SAMPLE_RATE = 16000


class Segmenter:
    def __init__(self, vad, *, pre_roll_s=0.3, partial_window_s=8.0,
                 partial_min_new_s=0.7, sample_rate=SAMPLE_RATE):
        self._vad = vad
        self._rate = sample_rate
        self._pre_roll = int(pre_roll_s * sample_rate)
        self._window = int(partial_window_s * sample_rate)
        self._min_new = int(partial_min_new_s * sample_rate)
        self._tail = np.zeros(0, dtype=np.float32)   # audio kept for pre-roll
        self._current = None                         # samples of the open segment
        self._since_partial = 0

    @property
    def in_speech(self):
        return self._current is not None

    def feed(self, chunk):
        chunk = np.asarray(chunk, dtype=np.float32)
        events = []
        finished = self._vad.accept(chunk)
        for seg in finished:
            if self._current is None:
                events.append(('start',))
            events.append(('final', np.asarray(seg, dtype=np.float32)))
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
        events = [('final', np.asarray(seg, dtype=np.float32)) for seg in self._vad.flush()]
        if not events and self._current is not None and len(self._current) >= self._rate // 4:
            # The VAD had not closed the segment yet; use what we have.
            events.append(('final', self._current))
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
