"""Hands-free start: listen all the time for a wake word, on a microphone
stream of its own, and hand that same stream to the dictation once the
word is heard, so that a sentence said in one breath after it loses
nothing.

    pw-record ─► pump thread ─► detection thread: Silero VAD; while someone
                                speaks, the detector (wakeword.py) gets the
                                audio, from a little before the speech
                                started
                         └────► when lent to a dictation: straight to it,
                                after the audio kept since the end of the word

The detector only runs while someone speaks; in silence the cost is the
VAD's (well under 1 % of a core). The GNOME microphone indicator stays on
while the word is listened for: that is the honest price of it.
"""
import queue
import threading
import time

import numpy as np

from .audio import SAMPLE_RATE, MicSource

PRE_ROLL_S = 0.6          # audio fed to the detector from before the VAD said "speech"
RING_S = 8.0              # audio kept, for the pre-roll and what follows the word
KEEP_AFTER_S = 4.0        # the word was heard but no dictation took the stream: drop it
MAX_UTTERANCE_S = 4.0     # the detector gives up on a long run of speech without the word
COOLDOWN_S = 1.0          # after a dictation, before the word may be heard again


class Ring:
    """The last `seconds` of audio with absolute sample positions."""

    def __init__(self, seconds=RING_S):
        self._buf = np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)
        self.end = 0                        # absolute position of the next sample

    def push(self, chunk):
        n = len(chunk)
        if n >= len(self._buf):
            self._buf[:] = chunk[-len(self._buf):]
        else:
            self._buf = np.roll(self._buf, -n)
            self._buf[-n:] = chunk
        self.end += n

    def since(self, pos):
        """The audio from absolute position `pos` to now (what is still kept)."""
        n = max(0, min(self.end - pos, len(self._buf), self.end))
        return self._buf[len(self._buf) - n:].copy() if n else np.zeros(0, dtype=np.float32)


class LentSource:
    """What a dictation gets instead of its own MicSource: the listener's
    stream, starting with the audio kept since the end of the word."""

    def __init__(self, listener, on_chunk):
        self._listener = listener
        self._on_chunk = on_chunk
        self.failure = None

    def start(self):
        self._listener._lend(self._on_chunk)

    def stop(self):
        self._listener._take_back(self._on_chunk)


class WakeListener:
    def __init__(self, detector, on_wake, *, vad, target='', mic_factory=MicSource, clock=time.monotonic):
        self._detector = detector          # wakeword.py: reset(), accept(samples) -> end offset in s or None
        self._on_wake = on_wake            # called on the detection thread with the phrase heard
        self._vad = vad
        self._target = target
        self._mic_factory = mic_factory
        self._clock = clock
        self._mic = None
        self._ring = Ring()
        self._lock = threading.Lock()
        self._lent = None                  # the dictation's callback while it has the stream
        self._woken_at = None              # absolute position of the end of the word, once heard
        self._woken_time = 0.0
        self._cooldown_until = 0.0
        self._queue = queue.Queue(maxsize=200)
        self._thread = None
        self._running = False
        self._seg_start = None             # absolute position fed to the detector from
        self._fed = 0                      # samples fed to the detector for this utterance
        self._suspended = False            # a dictation started by the shortcut has the microphone
        self._reset_pending = False
        self.failure = None

    # -- control -------------------------------------------------------------

    @property
    def running(self):
        return self._running

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._detect_loop, daemon=True, name='wake')
        self._thread.start()
        self._mic = self._mic_factory(self._pump, target=self._target)
        self._mic.start()

    def stop(self):
        self._running = False
        mic, self._mic = self._mic, None
        if mic is not None:
            mic.stop()
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass

    @property
    def woken(self):
        """The word was heard and the audio since is waiting for a dictation."""
        with self._lock:
            return self._woken_at is not None

    def lend(self, on_chunk):
        return LentSource(self, on_chunk)

    def suspend(self, on):
        """No detection while a dictation started otherwise is under way."""
        with self._lock:
            was, self._suspended = self._suspended, on
            if was and not on:
                self._cooldown_until = self._clock() + COOLDOWN_S
        if was and not on:
            self._restart_detection()

    # -- the stream ----------------------------------------------------------

    def _pump(self, chunk):
        """pw-record's thread."""
        if chunk is None:
            if self._running:
                self.failure = getattr(self._mic, 'failure', None) or 'microphone stream ended'
                self._running = False
            lent = self._lent
            if lent is not None:
                lent(None)
            return
        with self._lock:
            self._ring.push(chunk)
            lent = self._lent
            if self._woken_at is not None and lent is None and \
                    self._clock() - self._woken_time > KEEP_AFTER_S:
                self._woken_at = None          # nobody came for it
        if lent is not None:
            lent(chunk)
            return
        try:
            self._queue.put_nowait(chunk)
        except queue.Full:
            pass                               # the detector is behind: drop, never block the stream

    def _lend(self, on_chunk):
        with self._lock:
            start = self._woken_at if self._woken_at is not None else self._ring.end
            kept = self._ring.since(start)
            self._woken_at = None
            self._lent = on_chunk
        if len(kept):
            on_chunk(kept)

    def _take_back(self, on_chunk):
        with self._lock:
            if self._lent is on_chunk:
                self._lent = None
            self._cooldown_until = self._clock() + COOLDOWN_S
        self._restart_detection()

    def _restart_detection(self):
        # Done by the detection thread itself, which owns the VAD and the
        # detector, at its next chunk.
        self._reset_pending = True

    def _reset_now(self):
        self._reset_pending = False
        self._seg_start = None
        try:
            self._vad.reset()
        except Exception:
            pass
        self._detector.reset()

    # -- detection thread ----------------------------------------------------

    def _detect_loop(self):
        while self._running:
            chunk = self._queue.get()
            if chunk is None:
                break
            try:
                self._detect(chunk)
            except Exception as e:      # a detector error must not kill the listener
                self.failure = f'wake: {e}'

    def _detect(self, chunk):
        if self._reset_pending:
            self._reset_now()
        with self._lock:
            if self._lent is not None or self._woken_at is not None or self._suspended:
                return
            if self._clock() < self._cooldown_until:
                return
            end = self._ring.end
        self._vad.accept(chunk)                # segments are not needed, only in_speech
        if not self._vad.in_speech:
            if self._seg_start is not None:
                # Speech over without the word: the next one starts afresh.
                self._seg_start = None
                self._detector.reset()
            return
        if self._seg_start is None:
            self._seg_start = max(0, end - int(PRE_ROLL_S * SAMPLE_RATE) - len(chunk))
            with self._lock:
                audio = self._ring.since(self._seg_start)
            self._fed = len(audio)
        else:
            audio = chunk
            self._fed += len(chunk)
        if self._fed > MAX_UTTERANCE_S * SAMPLE_RATE:
            return                             # a long sentence: the word starts an utterance
        hit = self._detector.accept(audio)
        if hit is None:
            return
        phrase, end_s = hit
        with self._lock:
            self._woken_at = min(self._ring.end, self._seg_start + int(end_s * SAMPLE_RATE))
            self._woken_time = self._clock()
        self._seg_start = None
        self._detector.reset()
        self._on_wake(phrase)
