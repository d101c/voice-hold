"""MicSource against a stand-in for pw-record (a shell command)."""
import threading
import time

import numpy as np

from voice_hold_engine.audio import CHUNK, MicSource


class Sink:
    def __init__(self):
        self.chunks = []
        self.ended = threading.Event()

    def __call__(self, chunk):
        if chunk is None:
            self.ended.set()
        else:
            self.chunks.append(chunk)


def test_process_death_is_reported(monkeypatch):
    monkeypatch.setattr(MicSource, 'CMD', ['sh', '-c', f'head -c {CHUNK * 2 * 3} /dev/zero; echo "no such target" >&2; exit 7'])
    sink = Sink()
    src = MicSource(sink)
    src.start()
    assert sink.ended.wait(5)
    assert len(sink.chunks) == 3
    assert sink.chunks[0].dtype == np.float32 and len(sink.chunks[0]) == CHUNK
    assert src.returncode == 7
    assert src.failure == 'pw-record exited with status 7: no such target'


def test_clean_stop_is_not_a_failure_and_does_not_block(monkeypatch):
    # A process that streams for ever and exits on SIGTERM.
    monkeypatch.setattr(MicSource, 'CMD', ['sh', '-c', 'exec cat /dev/zero'])
    sink = Sink()
    src = MicSource(sink)
    src.start()
    deadline = time.monotonic() + 5
    while not sink.chunks and time.monotonic() < deadline:
        time.sleep(0.01)
    assert sink.chunks
    t0 = time.monotonic()
    src.stop()
    assert time.monotonic() - t0 < 0.1, 'stop() must not wait on the loop thread'
    assert sink.ended.wait(5)
    assert src.failure is None
    assert src.returncode is not None, 'the process was reaped'
    src.stop()                               # idempotent


def test_sigterm_ignored_gets_sigkill(monkeypatch):
    monkeypatch.setattr(MicSource, 'CMD', ['sh', '-c', 'trap "" TERM; exec cat /dev/zero'])
    monkeypatch.setattr('voice_hold_engine.audio.KILL_AFTER_S', 0.2)
    sink = Sink()
    src = MicSource(sink)
    src.start()
    deadline = time.monotonic() + 5
    while not sink.chunks and time.monotonic() < deadline:
        time.sleep(0.01)
    src.stop()
    assert sink.ended.wait(5)
    assert src.returncode == -9
    assert src.failure is None


def test_missing_binary(monkeypatch):
    monkeypatch.setattr(MicSource, 'CMD', ['/nonexistent/pw-record'])
    src = MicSource(Sink())
    try:
        src.start()
    except RuntimeError as e:
        assert 'PipeWire is required' in str(e)
    else:
        raise AssertionError('expected RuntimeError')


def test_target_is_passed(monkeypatch):
    seen = {}

    class FakeProc:
        def __init__(self, cmd, **kw):
            seen['cmd'] = cmd
            import io
            self.stdout = io.BytesIO(b'')
            self.returncode = 0

        def wait(self, timeout=None):
            return 0

        def poll(self):
            return 0

    monkeypatch.setattr('voice_hold_engine.audio.subprocess.Popen', FakeProc)
    sink = Sink()
    src = MicSource(sink, target='alsa_input.usb-mic')
    src.start()
    assert sink.ended.wait(5)
    assert seen['cmd'][:3] == ['pw-record', '--target', 'alsa_input.usb-mic']
