"""Engine lifecycle on a fake recogniser and a fake VAD: no models needed."""
import asyncio
import threading
import time
import wave

import numpy as np
import pytest

from voice_hold_engine import models, service
from voice_hold_engine.audio import MicSource
from voice_hold_engine.service import Busy, Engine

RATE = 16000


class FakeVad:
    """Energy VAD: a chunk is speech when it is not silent; a segment is
    returned when speech stops."""

    max_speech_s = 8.0

    def __init__(self):
        self._buf = []
        self.in_speech = False

    def accept(self, chunk):
        out = []
        loud = float(np.abs(chunk).max()) > 0.01
        if loud:
            self._buf.append(np.asarray(chunk, dtype=np.float32))
        elif self._buf:
            out.append(np.concatenate(self._buf))
            self._buf = []
        self.in_speech = loud
        return out

    def flush(self):
        self.in_speech = False
        if self._buf:
            seg = np.concatenate(self._buf)
            self._buf = []
            return [seg]
        return []

    def reset(self):
        self._buf = []
        self.in_speech = False


class FakeRecognizer:
    def __init__(self, *, fail_load=False, gate=None, texts=None):
        self._loaded = False
        self.fail_load = fail_load
        self.gate = gate            # threading.Event every transcribe waits for
        self.texts = texts
        self.calls = 0
        self.load_seconds = 0.0

    @property
    def loaded(self):
        return self._loaded

    def load(self):
        if self.fail_load:
            raise RuntimeError('protobuf parsing failed')
        self._loaded = True

    def unload(self):
        self._loaded = False

    def transcribe(self, samples):
        self.calls += 1
        if self.gate is not None:
            self.gate.wait(timeout=10)
        tenths = len(samples) // (RATE // 10)
        if self.texts and tenths in self.texts:     # keyed by segment length in 0.1 s
            return self.texts[tenths]
        return f'seg{tenths}'


def write_wav(path, parts):
    """parts: list of (seconds, amplitude); amplitude 0 = silence."""
    audio = []
    for secs, amp in parts:
        n = int(secs * RATE)
        if amp:
            t = np.arange(n) / RATE
            audio.append((amp * np.sin(2 * np.pi * 220 * t)).astype(np.float32))
        else:
            audio.append(np.zeros(n, dtype=np.float32))
    a = np.concatenate(audio)
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((a * 32767).astype(np.int16).tobytes())
    return str(path)


@pytest.fixture
def speech_wav(tmp_path):
    return write_wav(tmp_path / 'speech.wav', [(0.3, 0), (1.0, 0.3), (0.5, 0), (0.8, 0.3), (0.4, 0)])


@pytest.fixture
def fake(monkeypatch):
    """Patch the engine to use the fakes; returns the recogniser so a test
    can tune it before start()."""
    rec = FakeRecognizer()
    monkeypatch.setattr(models, 'missing', lambda base=None: [])
    monkeypatch.delenv('VOICE_HOLD_AUDIO_FILE', raising=False)

    def ensure(self):
        if self._recognizer is None:
            self._recognizer = rec
        if self._vad is None:
            self._vad = FakeVad()
        else:
            self._vad.reset()

    monkeypatch.setattr(Engine, '_ensure_models', ensure)
    return rec


class Harness:
    def __init__(self, loop):
        self.events = []
        self.stopped = asyncio.Event()
        self.engine = Engine(self.emit, loop=loop, idle_unload_s=0)

    def emit(self, name, *args):
        self.events.append((name, *args))
        if name == 'Stopped':
            self.stopped.set()

    def names(self):
        return [e[0] for e in self.events]

    def of(self, name):
        return [e[1] for e in self.events if e[0] == name]

    async def wait_stopped(self, timeout=10):
        await asyncio.wait_for(self.stopped.wait(), timeout)
        self.stopped.clear()


def run(coro):
    return asyncio.run(coro)


# -- happy paths -------------------------------------------------------------

def test_file_end_gives_finals_then_stopped(fake, speech_wav):
    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': False})
        await h.wait_stopped()
        return h
    h = run(main())
    assert ('State', 'loading') in h.events[:2]
    assert ('Source', 'speech.wav') in h.events
    assert len(h.of('Final')) == 2
    assert h.events[-1] == ('Stopped', 'end-of-audio')
    assert h.names().index('Final') < h.names().index('Stopped')
    assert not h.engine.active


def test_stop_decodes_what_is_left(fake, speech_wav):
    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        await asyncio.sleep(0.6)            # inside the first tone
        await h.engine.stop()
        return h
    h = run(main())
    assert h.events[-1] == ('Stopped', 'stop')
    assert h.of('Final'), 'the open segment was flushed and decoded'
    assert ('State', 'decoding') in h.events
    assert not h.engine.active


def test_cancel_drops_everything(fake, speech_wav):
    fake.gate = threading.Event()

    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        await asyncio.sleep(1.1)            # a partial decode is on the worker
        assert h.engine.busy
        h.engine.cancel()
        assert h.events[-1] == ('Stopped', 'cancel')
        fake.gate.set()                     # the partial decode now completes
        await asyncio.sleep(0.2)
        return h
    h = run(main())
    assert not h.of('Final')
    assert not h.of('Partial')
    assert h.names().count('Stopped') == 1


def test_level_is_throttled(fake, speech_wav):
    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        await h.wait_stopped(timeout=15)
        return h
    h = run(main())
    levels = h.of('Level')
    # 3.0 s of audio + 0.6 s of tail at ≤ 10/s (31/s unthrottled).
    assert 5 <= len(levels) <= 40, len(levels)


# -- start failures: always Error then Stopped('error') -------------------------

def test_models_missing(fake, monkeypatch):
    monkeypatch.setattr(models, 'missing', lambda base=None: ['silero_vad.onnx'])

    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({})
        return h
    h = run(main())
    assert h.events[-2:] == [('Error', 'models-missing'), ('Stopped', 'error')]
    assert not h.engine.active


def test_audio_failure(fake, monkeypatch):
    def boom(self):
        raise RuntimeError('pw-record not found: PipeWire is required')
    monkeypatch.setattr(MicSource, 'start', boom)

    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({})
        return h
    h = run(main())
    assert h.events[-2:] == [('Error', 'audio: pw-record not found: PipeWire is required'), ('Stopped', 'error')]
    assert not h.engine.active


def test_model_load_failure_stops_the_source(fake, speech_wav):
    fake.fail_load = True

    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        source = h.engine._source
        await h.wait_stopped()
        return h, source
    h, source = run(main())
    assert h.of('Error') == ['model: protobuf parsing failed']
    assert h.events[-1] == ('Stopped', 'error')
    assert source.stopped, 'the audio source was stopped'
    assert not h.engine.active


def test_dead_pw_record_is_an_error(fake, monkeypatch):
    # A "pw-record" that delivers 4 chunks then dies with status 3.
    monkeypatch.setattr(MicSource, 'CMD', ['sh', '-c', 'head -c 4096 /dev/zero; echo boom >&2; exit 3'])
    monkeypatch.setattr('voice_hold_engine.sources.describe', lambda name='': 'Fake mic')

    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({})
        await h.wait_stopped()
        return h
    h = run(main())
    errors = h.of('Error')
    assert len(errors) == 1 and errors[0].startswith('audio: pw-record exited with status 3')
    assert 'boom' in errors[0]
    assert h.events[-1] == ('Stopped', 'error')
    assert ('Source', 'Fake mic') in h.events


# -- concurrency -----------------------------------------------------------------

def test_start_while_active_is_busy(fake, speech_wav):
    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        with pytest.raises(Busy):
            await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        h.engine.cancel()
        return h
    h = run(main())
    assert h.names().count('Stopped') == 1


def test_start_while_stop_is_decoding_is_busy(fake, speech_wav):
    fake.gate = threading.Event()

    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        await asyncio.sleep(0.6)
        stopping = asyncio.ensure_future(h.engine.stop())
        await asyncio.sleep(0.1)
        assert h.engine.active and h.engine.state == 'decoding'
        with pytest.raises(Busy):
            await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        fake.gate.set()
        await stopping
        return h
    h = run(main())
    assert h.events[-1] == ('Stopped', 'stop')
    assert h.of('Final')


def test_stop_cancel_start_race_keeps_the_new_session(fake, speech_wav):
    """stop() is waiting for a decode; cancel() then start() happen meanwhile.
    When the old stop() resumes it must not finish the new session nor stop
    its source."""
    fake.gate = threading.Event()

    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        await asyncio.sleep(0.6)
        old_stop = asyncio.ensure_future(h.engine.stop())
        await asyncio.sleep(0.1)
        h.engine.cancel()
        assert h.events[-1] == ('Stopped', 'cancel')
        await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        new_source = h.engine._source
        fake.gate.set()
        await old_stop
        await asyncio.sleep(0.2)
        still_active = h.engine.active
        same_source = h.engine._source is new_source
        source_running = not new_source.stopped
        h.engine.cancel()
        return h, still_active, same_source, source_running
    h, still_active, same_source, source_running = run(main())
    assert still_active and same_source and source_running
    assert h.of('Stopped') == ['cancel', 'cancel']


def test_idle_does_not_unload_during_a_decode(fake, speech_wav):
    fake.gate = threading.Event()

    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        await asyncio.sleep(1.1)
        h.engine.cancel()                   # a partial decode is still on the worker
        assert h.engine.busy
        h.engine._on_idle()
        assert fake.loaded, 'not unloaded while a job is in flight'
        assert not h.engine.exit_event.is_set()
        fake.gate.set()
        await asyncio.sleep(0.2)
        assert not h.engine.busy
        h.engine._on_idle()
        assert not fake.loaded, 'unloaded once idle'
        h.engine._on_idle()
        assert h.engine.exit_event.is_set(), 'exit at the second idle'
        return h
    run(main())


def test_polish_runs_off_the_decode_worker(fake, speech_wav, monkeypatch):
    seen = []

    def fake_polish(text, url, model):
        seen.append((threading.current_thread().name, text, url, model))
        time.sleep(0.05)
        return text.upper()
    monkeypatch.setattr('voice_hold_engine.polish.polish', fake_polish)

    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': False, 'polish': True,
                              'polish-url': 'http://x', 'polish-model': 'm'})
        await h.wait_stopped()
        return h
    h = run(main())
    assert h.of('Final') == ['SEG10', 'SEG8']
    assert all(name.startswith('polish') for name, *_ in seen)
    assert seen[0][2:] == ('http://x', 'm')
    assert h.events[-1] == ('Stopped', 'end-of-audio'), 'Stopped waits for the polish'


def test_partial_window_covers_a_whole_segment(fake, speech_wav):
    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': True})
        window = h.engine._segmenter.partial_window_s
        h.engine.cancel()
        return window
    assert run(main()) >= FakeVad.max_speech_s + 0.3


def test_only_command_block_is_a_newline(fake, speech_wav):
    fake.texts = {10: 'nouvelle ligne', 8: 'Bonjour à tous, à la ligne'}   # the 1.0 s and 0.8 s segments

    async def main():
        h = Harness(asyncio.get_running_loop())
        await h.engine.start({'audio-file': speech_wav, 'realtime': False})
        await h.wait_stopped()
        return h
    h = run(main())
    assert h.of('Final') == ['\n', 'Bonjour à tous\n']


def test_interface_start_busy_is_a_dbus_error(fake, speech_wav):
    from dbus_fast import DBusError

    async def main():
        h = Harness(asyncio.get_running_loop())
        iface = service.VoiceHoldInterface(h.engine)
        # dbus_fast's decorator hides the return value; call the function itself.
        start = service.VoiceHoldInterface.Start.__wrapped__
        await start(iface, {'audio-file': speech_wav, 'realtime': True})
        with pytest.raises(DBusError) as info:
            await start(iface, {})
        assert info.value.type == service.BUSY_ERROR
        h.engine.cancel()
        return h
    run(main())


def test_speak_reports_missing_voice_then_speaks_on_a_fake_player(monkeypatch):
    asyncio.run(_speak_scenario(monkeypatch))


async def _speak_scenario(monkeypatch):
    from voice_hold_engine import tts
    loop = asyncio.get_running_loop()
    emitted = []
    eng = Engine(lambda *a: emitted.append(a), loop=loop, idle_unload_s=0)
    monkeypatch.setattr(models, 'voice_ready', lambda lang, base=None: False)
    assert await eng.speak('bonjour') == 'voice-missing'
    assert await eng.speak('') == 'empty'
    monkeypatch.setattr(models, 'voice_ready', lambda lang, base=None: True)
    eng._speaker = tts.Speaker(player=['sleep', '0.2'], synth=lambda t, l, s: ([0.0] * 10, 22050))
    assert await eng.speak('bonjour', 'xx') == ''
    assert ('Speaking', True) in emitted and eng.status()['speaking'].value is True
    await eng._speak_task
    assert ('Speaking', False) in emitted and eng.status()['speaking'].value is False
    assert await eng.speak('encore') == ''
    eng.stop_speaking()
    assert eng.status()['speaking'].value is False
    eng._speak_task.cancel()
