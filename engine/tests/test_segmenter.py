import numpy as np

from voice_hold_engine.segmenter import Segmenter, rms

CHUNK = 512


class FakeVad:
    """Scripted VAD: `speech` is a list of (start_chunk, end_chunk) ranges; a
    segment is returned on the chunk after a range ends."""

    def __init__(self, speech):
        self._speech = speech
        self._i = 0
        self.in_speech = False
        self._buf = []
        self._open = None

    def accept(self, chunk):
        i = self._i
        self._i += 1
        out = []
        active = any(s <= i < e for s, e in self._speech)
        if active:
            self._buf.append(chunk)
        elif self._buf:
            out.append(np.concatenate(self._buf))
            self._buf = []
        self.in_speech = active
        return out

    def flush(self):
        self.in_speech = False
        if self._buf:
            seg = np.concatenate(self._buf)
            self._buf = []
            return [seg]
        return []


def chunks(n):
    return [np.full(CHUNK, 0.1, dtype=np.float32) for _ in range(n)]


def run(seg, n):
    evs = []
    for c in chunks(n):
        evs.extend(seg.feed(c))
    return evs


def test_tap_then_pause_gives_one_final():
    seg = Segmenter(FakeVad([(2, 40)]), partial_min_new_s=10)  # no partials
    evs = run(seg, 50)
    kinds = [e[0] for e in evs]
    assert kinds == ['start', 'final']
    assert len(evs[1][1]) == 38 * CHUNK


def test_partials_arrive_while_speaking_and_stop_at_final():
    seg = Segmenter(FakeVad([(0, 60)]), partial_min_new_s=0.5, pre_roll_s=0)
    evs = run(seg, 70)
    kinds = [e[0] for e in evs]
    assert kinds[0] == 'start'
    assert kinds[-1] == 'final'
    partials = [e for e in evs if e[0] == 'partial']
    # 60 chunks * 32 ms = 1.92 s of speech, one partial every 0.5 s
    assert 3 <= len(partials) <= 4
    # partial windows grow with the speech
    assert len(partials[0][1]) < len(partials[-1][1])
    assert all(e[0] != 'partial' for e in evs[kinds.index('final'):])


def test_partial_window_is_bounded():
    seg = Segmenter(FakeVad([(0, 400)]), partial_min_new_s=0.5, partial_window_s=2.0, pre_roll_s=0)
    evs = run(seg, 400)
    longest = max(len(e[1]) for e in evs if e[0] == 'partial')
    assert longest <= 2.0 * 16000


def test_pre_roll_is_prepended_to_partials():
    seg = Segmenter(FakeVad([(10, 60)]), partial_min_new_s=0.5, pre_roll_s=0.1)
    evs = run(seg, 70)
    first_partial = next(e for e in evs if e[0] == 'partial')
    # 0.1 s pre-roll (1600 samples) + at least 0.5 s of speech
    assert len(first_partial[1]) >= 1600 + 0.5 * 16000


def test_flush_closes_open_segment():
    seg = Segmenter(FakeVad([(0, 100)]), partial_min_new_s=10)
    run(seg, 50)
    evs = seg.flush()
    assert [e[0] for e in evs] == ['final']
    assert len(evs[0][1]) == 50 * CHUNK
    assert not seg.in_speech


def test_two_segments_two_finals():
    seg = Segmenter(FakeVad([(0, 30), (45, 80)]), partial_min_new_s=10)
    evs = run(seg, 90)
    assert [e[0] for e in evs] == ['start', 'final', 'start', 'final']


def test_default_partial_window_covers_the_longest_segment():
    # asr.SileroVad cuts at 8 s: the default window must not be shorter.
    seg = Segmenter(FakeVad([]))
    assert seg.partial_window_s >= 8.0 + 0.3


def test_rms_scale():
    assert rms(np.zeros(100)) == 0.0
    assert 0.3 < rms(np.full(100, 0.1)) < 0.5
    assert rms(np.full(100, 0.9)) == 1.0


class SpanVad(FakeVad):
    """As FakeVad, but says where each segment starts, as asr.SileroVad."""

    def __init__(self, speech):
        super().__init__(speech)
        self._first = None

    def accept(self, chunk):
        i = self._i
        out = super().accept(chunk)
        if self.in_speech and self._first is None:
            self._first = i
        if out:
            out = [(self._first * CHUNK, out[0])]
            self._first = None
        return out


def ramp(n):
    """Chunk i holds the value i, so a cut can be read off its samples."""
    return [np.full(CHUNK, float(i), dtype=np.float32) for i in range(n)]


def finals(seg, n):
    out = []
    for c in ramp(n):
        out += [e for e in seg.feed(c) if e[0] == 'final']
    return out


def test_finals_are_contiguous_across_a_short_pause():
    # speech chunks 10-20, a 0.5 s pause (16 chunks of 32 ms), speech 36-50
    seg = Segmenter(SpanVad([(10, 20), (36, 50)]), partial_min_new_s=100)
    f = finals(seg, 70)
    assert len(f) == 2
    first, second = f[0][1], f[1][1]
    # nothing between the two finals is left out
    assert second[0] == first[-1] or second[0] == first[-1] + 1
    assert set(np.unique(first)) | set(np.unique(second)) >= set(range(10, 50))


def test_a_long_silence_is_trimmed_before_the_next_final():
    seg = Segmenter(SpanVad([(10, 20), (100, 110)]), partial_min_new_s=100)
    f = finals(seg, 130)
    second = f[1][1]
    pad_chunks = int(0.5 * 16000 / CHUNK)
    assert second[0] >= 100 - pad_chunks - 1


def test_the_context_is_the_audio_just_before_the_final():
    seg = Segmenter(SpanVad([(10, 20), (36, 50)]), partial_min_new_s=100)
    f = finals(seg, 70)
    ctx, second = f[1][2], f[1][1]
    assert len(ctx) > 0 and ctx[-1] <= second[0]


def test_bare_segments_still_work_without_context():
    seg = Segmenter(FakeVad([(2, 40)]), partial_min_new_s=10)
    f = finals(seg, 50)
    assert len(f) == 1 and len(f[0][2]) == 0
