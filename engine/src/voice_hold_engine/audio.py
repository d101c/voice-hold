"""Audio sources: the microphone through PipeWire, or a WAV file replayed at
real speed (tests, demo). Both deliver float32 chunks at 16 kHz on a callback
called from a background thread; `None` means end of stream. When the stream
ended because the capture process died, `failure` holds a message before the
final `None` is delivered."""
import subprocess
import tempfile
import threading
import time
import wave

import numpy as np

SAMPLE_RATE = 16000
CHUNK = 512  # 32 ms

# After SIGTERM, how long pw-record gets before SIGKILL.
KILL_AFTER_S = 1.0
STDERR_TAIL = 300


class MicSource:
    CMD = ['pw-record', '--rate', str(SAMPLE_RATE), '--channels', '1',
           '--format', 's16', '--latency', '20ms', '-']

    def __init__(self, on_chunk, target=''):
        self._on_chunk = on_chunk
        self._target = target          # PipeWire node name; '' = default source
        self._proc = None
        self._thread = None
        self._stderr = None
        self._stopped = False
        self.failure = None
        self.returncode = None

    def start(self):
        cmd = list(self.CMD)
        if self._target:
            cmd[1:1] = ['--target', self._target]
        # stderr goes to a temporary file (never a pipe: a chatty process
        # would block on a full pipe) and its tail is reported on failure.
        self._stderr = tempfile.TemporaryFile()
        try:
            self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=self._stderr)
        except FileNotFoundError as e:
            self._stderr.close()
            self._stderr = None
            raise RuntimeError(f'{cmd[0]} not found: PipeWire is required') from e
        self._thread = threading.Thread(target=self._pump, daemon=True, name='pw-record')
        self._thread.start()

    def _pump(self):
        proc = self._proc
        nbytes = CHUNK * 2
        try:
            while True:
                data = proc.stdout.read(nbytes)
                if not data:
                    break
                samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
                self._on_chunk(samples)
        finally:
            rc, tail = self._reap(proc)
            self.returncode = rc
            if not self._stopped:
                msg = f'pw-record exited with status {rc}'
                if tail:
                    msg += f': {tail}'
                self.failure = msg
            self._on_chunk(None)

    # Wait for the process (it is exiting: EOF on stdout), close the pipes,
    # return (exit code, tail of stderr). Runs on the pump thread, never on
    # the event loop.
    def _reap(self, proc):
        try:
            rc = proc.wait(timeout=KILL_AFTER_S + 1)
        except subprocess.TimeoutExpired:
            proc.kill()
            rc = proc.wait()
        try:
            proc.stdout.close()
        except Exception:
            pass
        tail = ''
        if self._stderr is not None:
            try:
                self._stderr.seek(0)
                tail = self._stderr.read()[-STDERR_TAIL:].decode(errors='replace').strip()
            except Exception:
                pass
            try:
                self._stderr.close()
            except Exception:
                pass
            self._stderr = None
        return rc, tail

    def stop(self):
        """Ask pw-record to exit. Never blocks: the pump thread reaps it when
        its stdout closes; a timer sends SIGKILL if SIGTERM is ignored."""
        self._stopped = True
        proc, self._proc = self._proc, None
        if proc is None:
            return
        if proc.poll() is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            timer = threading.Timer(KILL_AFTER_S, _kill_if_alive, args=(proc,))
            timer.daemon = True
            timer.start()


def _kill_if_alive(proc):
    try:
        if proc.poll() is None:
            proc.kill()
    except Exception:
        pass


class FileSource:
    def __init__(self, path, on_chunk, realtime=True):
        self._path = path
        self._on_chunk = on_chunk
        self._realtime = realtime
        self._stop = threading.Event()
        self._thread = None
        self.failure = None

    @staticmethod
    def read(path):
        with wave.open(path, 'rb') as w:
            rate, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
            raw = w.readframes(w.getnframes())
        if width != 2:
            raise RuntimeError('only 16-bit PCM WAV is supported')
        a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if ch > 1:
            a = a.reshape(-1, ch).mean(axis=1)
        if rate != SAMPLE_RATE:
            n = int(len(a) * SAMPLE_RATE / rate)
            a = np.interp(np.linspace(0, len(a), n, endpoint=False), np.arange(len(a)), a).astype(np.float32)
        return a

    @property
    def stopped(self):
        return self._stop.is_set()

    def start(self):
        audio = self.read(self._path)
        self._thread = threading.Thread(target=self._pump, args=(audio,), daemon=True)
        self._thread.start()

    def _pump(self, audio):
        t0 = time.perf_counter()
        try:
            for i in range(0, len(audio), CHUNK):
                if self._stop.is_set():
                    return
                self._on_chunk(audio[i:i + CHUNK])
                if self._realtime:
                    due = t0 + (i + CHUNK) / SAMPLE_RATE
                    delay = due - time.perf_counter()
                    if delay > 0:
                        time.sleep(delay)
            # A little silence so the VAD closes the last segment on its own.
            for _ in range(0, int(0.6 * SAMPLE_RATE), CHUNK):
                if self._stop.is_set():
                    return
                self._on_chunk(np.zeros(CHUNK, dtype=np.float32))
                if self._realtime:
                    time.sleep(CHUNK / SAMPLE_RATE)
        finally:
            self._on_chunk(None)

    def stop(self):
        self._stop.set()
