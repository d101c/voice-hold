"""Text-to-speech, offline: Piper voices run by sherpa-onnx, played through
PipeWire (`pw-play`). One utterance at a time; a new one cuts the previous.

Synthesis is CPU work (a sentence takes a few hundred milliseconds): it runs
on a worker thread, the player is a child process the loop watches."""
import os
import subprocess
import tempfile
import threading
import time

from . import models

PLAYER = ['pw-play']
MAX_CHARS = 1200
SPEED = 1.0


class Speaker:
    def __init__(self, *, player=PLAYER, synth=None):
        self._player = list(player)
        self._synth = synth              # for tests: fn(text, lang, speed) -> (samples, rate)
        self._tts = {}                   # lang -> sherpa_onnx.OfflineTts
        self._lock = threading.Lock()
        self._proc = None
        self._file = None
        self.load_seconds = 0.0

    # -- models ----------------------------------------------------------

    def available(self, lang):
        return models.voice_ready(lang)

    def _engine(self, lang):
        tts = self._tts.get(lang)
        if tts is not None:
            return tts
        import sherpa_onnx
        p = models.voice_paths(lang)
        t0 = time.perf_counter()
        config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=p['model'], lexicon='', tokens=p['tokens'], data_dir=p['data_dir']),
                provider='cpu', num_threads=2, debug=False),
            max_num_sentences=2)
        if not config.validate():
            raise RuntimeError(f'invalid TTS configuration for {lang}')
        tts = sherpa_onnx.OfflineTts(config)
        self.load_seconds = time.perf_counter() - t0
        self._tts[lang] = tts
        return tts

    def unload(self):
        self._tts.clear()

    @property
    def loaded(self):
        return bool(self._tts)

    # -- speaking ----------------------------------------------------------

    def synthesize(self, text, lang='fr', speed=SPEED):
        """Return (samples: list of float, sample_rate)."""
        text = ' '.join(str(text or '').split())[:MAX_CHARS]
        if not text:
            return [], 22050
        if self._synth:
            return self._synth(text, lang, speed)
        audio = self._engine(lang).generate(text, sid=0, speed=speed)
        return list(audio.samples), audio.sample_rate

    def speak(self, text, lang='fr', speed=SPEED):
        """Synthesize and start playing; returns the player's exit future-less
        handle (wait() on it). Any utterance still playing is cut first."""
        samples, rate = self.synthesize(text, lang, speed)
        self.stop()
        if not samples:
            return None
        import sherpa_onnx
        fd, path = tempfile.mkstemp(prefix='voice-hold-', suffix='.wav')
        os.close(fd)
        sherpa_onnx.write_wave(path, samples, rate)
        with self._lock:
            self._file = path
            self._proc = subprocess.Popen(self._player + [path], stdin=subprocess.DEVNULL,
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return self._proc

    @property
    def speaking(self):
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    def stop(self):
        """Cut the current utterance, if any."""
        with self._lock:
            proc, path = self._proc, self._file
            self._proc = self._file = None
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    proc.kill()
                except OSError:
                    pass
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass

    def finished(self):
        """Called when the player has exited: drop the temp file."""
        with self._lock:
            if self._proc is not None and self._proc.poll() is not None:
                path = self._file
                self._proc = self._file = None
            else:
                return
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass
