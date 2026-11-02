"""Audio sources: the microphone through PipeWire, or a WAV file replayed at
real speed (tests, demo). Both deliver float32 chunks at 16 kHz on a callback
called from a background thread; `None` means end of stream."""
import subprocess
import threading
import time
import wave

import numpy as np

SAMPLE_RATE = 16000
CHUNK = 512  # 32 ms


class MicSource:
    CMD = ['pw-record', '--rate', str(SAMPLE_RATE), '--channels', '1',
           '--format', 's16', '--latency', '20ms', '-']

    def __init__(self, on_chunk, target=''):
        self._on_chunk = on_chunk
        self._target = target          # PipeWire node name; '' = default source
        self._proc = None
        self._thread = None

    def start(self):
        cmd = list(self.CMD)
        if self._target:
            cmd[1:1] = ['--target', self._target]
        try:
            self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                          stderr=subprocess.DEVNULL)
        except FileNotFoundError as e:
            raise RuntimeError('pw-record not found: PipeWire is required') from e
        self._thread = threading.Thread(target=self._pump, daemon=True)
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
            self._on_chunk(None)

    def stop(self):
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=1)
        except Exception:
            proc.kill()


class FileSource:
    def __init__(self, path, on_chunk, realtime=True):
        self._path = path
        self._on_chunk = on_chunk
        self._realtime = realtime
        self._stop = threading.Event()
        self._thread = None

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
