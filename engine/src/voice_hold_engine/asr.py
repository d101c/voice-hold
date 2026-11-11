"""Speech recognition (Parakeet TDT 0.6B int8) and voice activity detection
(Silero), both through sherpa-onnx."""
import ctypes
import os
import time

import numpy as np

from . import models

SAMPLE_RATE = 16000


class Recognizer:
    """Loads lazily, can be unloaded to give the memory back."""

    def __init__(self, threads=None, base=None):
        self._threads = threads or min(4, os.cpu_count() or 2)
        self._base = base
        self._rec = None
        self.load_seconds = 0.0

    @property
    def loaded(self):
        return self._rec is not None

    def load(self):
        if self._rec is not None:
            return
        import sherpa_onnx
        p = models.asr_paths(self._base)
        t0 = time.perf_counter()
        self._rec = sherpa_onnx.OfflineRecognizer.from_transducer(
            tokens=p['tokens'], encoder=p['encoder'], decoder=p['decoder'],
            joiner=p['joiner'], num_threads=self._threads, sample_rate=SAMPLE_RATE,
            feature_dim=80, model_type='nemo_transducer', decoding_method='greedy_search')
        self.load_seconds = time.perf_counter() - t0

    def unload(self):
        self._rec = None

    def transcribe(self, samples):
        self.load()
        samples = np.asarray(samples, dtype=np.float32)
        if samples.size < SAMPLE_RATE // 10:
            return ''
        s = self._rec.create_stream()
        s.accept_waveform(SAMPLE_RATE, samples)
        self._rec.decode_stream(s)
        return s.result.text.strip()


def release_memory():
    """Give freed heap back to the kernel. Dropping the recogniser frees the
    weights but glibc keeps ~600 MB of them resident until asked; without
    this the promise "the model leaves memory after 5 minutes" is false."""
    try:
        libc = ctypes.CDLL('libc.so.6')
        libc.malloc_trim(0)
    except (OSError, AttributeError):
        pass


class SileroVad:
    """Adapter with the interface segmenter.Segmenter expects."""

    WINDOW = 512  # samples per Silero frame at 16 kHz

    # Blocks are cut at pauses of min_silence_s; without a pause, at
    # max_speech_s (a long block costs max_speech_s × RTF to decode, so keep
    # it short enough to feel live).
    def __init__(self, base=None, threshold=0.5, min_silence_s=0.3,
                 min_speech_s=0.25, max_speech_s=8.0):
        import sherpa_onnx
        self.max_speech_s = max_speech_s
        cfg = sherpa_onnx.VadModelConfig()
        cfg.silero_vad.model = models.vad_path(base)
        cfg.silero_vad.threshold = threshold
        cfg.silero_vad.min_silence_duration = min_silence_s
        cfg.silero_vad.min_speech_duration = min_speech_s
        cfg.silero_vad.max_speech_duration = max_speech_s
        cfg.sample_rate = SAMPLE_RATE
        cfg.num_threads = 1
        self._vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=max_speech_s + 5)
        self._pending = np.zeros(0, dtype=np.float32)
        self.in_speech = False

    def _drain(self):
        out = []
        while not self._vad.empty():
            seg = self._vad.front
            out.append(np.asarray(seg.samples, dtype=np.float32))
            self._vad.pop()
        return out

    def accept(self, chunk):
        buf = np.concatenate([self._pending, np.asarray(chunk, dtype=np.float32)])
        n = (len(buf) // self.WINDOW) * self.WINDOW
        for i in range(0, n, self.WINDOW):
            self._vad.accept_waveform(buf[i:i + self.WINDOW])
        self._pending = buf[n:]
        self.in_speech = self._vad.is_speech_detected()
        return self._drain()

    def flush(self):
        self._vad.flush()
        self.in_speech = False
        self._pending = np.zeros(0, dtype=np.float32)
        return self._drain()

    def reset(self):
        self._vad.reset()
        self.in_speech = False
        self._pending = np.zeros(0, dtype=np.float32)
