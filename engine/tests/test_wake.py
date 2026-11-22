import threading
import time

import numpy as np

from voice_hold_engine import wake
from voice_hold_engine.wake import Ring, WakeListener

RATE = 16000
CHUNK = 512


class FakeMic:
    def __init__(self, on_chunk, target=''):
        self.on_chunk = on_chunk
        self.stopped = False
        self.failure = None

    def start(self):
        pass

    def stop(self):
        self.stopped = True


class FakeVad:
    """Speech while the chunk's first sample is > 0.5."""
    def __init__(self):
        self.in_speech = False
        self.resets = 0

    def accept(self, chunk):
        self.in_speech = bool(len(chunk)) and chunk[0] > 0.5
        return []

    def reset(self):
        self.resets += 1
        self.in_speech = False


class FakeDetector:
    """Detects once it has seen `need` samples of speech; the word ends at `end_s`."""
    def __init__(self, need, end_s):
        self.need, self.end_s, self.seen, self.resets = need, end_s, 0, 0

    def reset(self):
        self.seen = 0
        self.resets += 1

    def accept(self, samples):
        self.seen += len(samples)
        return ('hé hold', self.end_s) if self.seen >= self.need else None


def chunk(value):
    return np.full(CHUNK, value, dtype=np.float32)


def run(listener, values):
    for v in values:
        listener._pump(chunk(v))


def wait_for(cond, timeout=2.0):
    t0 = time.monotonic()
    while not cond():
        if time.monotonic() - t0 > timeout:
            return False
        time.sleep(0.005)
    return True


def make(detector, **kw):
    heard = []
    ev = threading.Event()
    lst = WakeListener(detector, lambda p: (heard.append(p), ev.set()), vad=FakeVad(), mic_factory=FakeMic, **kw)
    lst.start()
    return lst, heard, ev


def test_ring_keeps_the_last_seconds_with_positions():
    r = Ring(seconds=0.1)                       # 1600 samples
    r.push(np.arange(1000, dtype=np.float32))
    r.push(np.arange(1000, 2000, dtype=np.float32))
    assert r.end == 2000
    assert list(r.since(1990)) == list(range(1990, 2000))
    assert len(r.since(0)) == 1600             # older audio is gone


def test_detection_only_while_speaking_and_the_audio_after_the_word_is_handed_over():
    det = FakeDetector(need=CHUNK * 4, end_s=0.1)
    lst, heard, ev = make(det)
    run(lst, [0.0] * 10)                        # silence: the detector sees nothing
    assert wait_for(lambda: lst._queue.empty())
    assert det.seen == 0
    run(lst, [0.9] * 6)                         # speech: the word
    assert ev.wait(2)
    assert heard == ['hé hold'] and lst.woken
    run(lst, [0.7] * 3)                         # the sentence goes on meanwhile
    got = []
    src = lst.lend(got.append)
    src.start()
    kept = got[0]
    assert len(kept) > 3 * CHUNK                # from the end of the word, nothing lost
    run(lst, [0.8])
    assert got[-1][0] == np.float32(0.8)        # then straight through
    src.stop()
    assert not lst.woken
    lst.stop()


def test_speech_without_the_word_resets_the_detector():
    det = FakeDetector(need=CHUNK * 100, end_s=0.1)
    lst, heard, ev = make(det)
    run(lst, [0.9] * 3 + [0.0] * 2)
    assert wait_for(lambda: lst._queue.empty())
    time.sleep(0.05)
    assert det.resets >= 1 and not heard
    lst.stop()


def test_word_heard_but_no_dictation_comes(monkeypatch):
    now = [100.0]
    det = FakeDetector(need=CHUNK * 2, end_s=0.05)
    lst, heard, ev = make(det, clock=lambda: now[0])
    run(lst, [0.9] * 3)
    assert ev.wait(2)
    now[0] += wake.KEEP_AFTER_S + 1
    run(lst, [0.0])
    assert not lst.woken
    lst.stop()


def test_no_detection_during_the_cooldown_after_a_dictation():
    now = [100.0]
    det = FakeDetector(need=CHUNK * 2, end_s=0.05)
    lst, heard, ev = make(det, clock=lambda: now[0])
    src = lst.lend(lambda c: None)
    src.start()
    src.stop()
    run(lst, [0.9] * 4)
    assert wait_for(lambda: lst._queue.empty())
    time.sleep(0.05)
    assert not heard
    now[0] += wake.COOLDOWN_S + 0.1
    run(lst, [0.9] * 4)
    assert ev.wait(2)
    lst.stop()


def test_stream_end_reaches_the_dictation():
    det = FakeDetector(need=10 ** 9, end_s=0)
    lst, heard, ev = make(det)
    got = []
    lst.lend(got.append).start()
    lst._pump(None)
    assert got[-1] is None and lst.failure
    lst.stop()
