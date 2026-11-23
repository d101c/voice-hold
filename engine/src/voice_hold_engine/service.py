"""The dictation engine proper (Engine) and its D-Bus face (VoiceHoldInterface).

Threads: audio arrives on a capture thread and is handed to the asyncio loop
with call_soon_threadsafe; the VAD runs on the loop (cheap); decodes run one
at a time on a single worker thread so results come back in order; the
optional LLM polish has its own worker so it never delays a decode; pw-dump
runs on the default executor.

A session is numbered (`_gen`): results of a cancelled session are dropped
when they come back, and a `stop()` that was waiting for decodes does not
finish a newer session.
"""
import asyncio
import gc
import os
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from dbus_fast import DBusError, Variant
from dbus_fast.service import ServiceInterface, method, signal

from . import INTERFACE, __version__, models, text as textmod
from .corrections import correct
from .lists import Lists
from .vocab import Vocabulary
from .audio import FileSource, MicSource
from .segmenter import Segmenter, rms

IDLE = 'idle'
LOADING = 'loading'
# The speech model, for the top-bar icon (signal Model).
ASLEEP = 'asleep'
READY = 'ready'
LISTENING = 'listening'
DECODING = 'decoding'

BUSY_ERROR = 'org.griffit.VoiceHold.Error.Busy'

# `Level` is emitted at most this often (the meter does not need more).
LEVEL_PERIOD_S = 0.1
# The final pass decodes the whole dictation at once up to this length
# (Parakeet at RTF ~0.13: about 12 s of waiting at the very most).
WHOLE_MAX_S = 90


class Busy(Exception):
    """Start() while a session is active or still finishing."""


def _opt(options, key, default):
    v = options.get(key)
    if isinstance(v, Variant):
        v = v.value
    return default if v is None else v


class Engine:
    def __init__(self, emit, *, loop=None, idle_unload_s=None):
        self._emit = emit                     # emit(signal, *args), loop thread only
        self._loop = loop or asyncio.get_event_loop()
        self._idle_unload_s = idle_unload_s if idle_unload_s is not None else \
            float(os.environ.get('VOICE_HOLD_IDLE_S', '300'))
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='decode')
        self._polish_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='polish')
        self._tts_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='tts')
        self._speaker = None                  # tts.Speaker, made on the first Speak
        self._speak_task = None
        self._recognizer = None
        self._vad = None
        self.state = IDLE
        self.model = ASLEEP                   # the speech model: asleep | loading | ready
        self._gen = 0                         # session generation
        self._source = None
        self._segmenter = None
        self._opts = {}
        self._vocab = Vocabulary()
        self._lists = Lists()
        self._pending = set()                 # futures of this session (decode, load, polish)
        self._inflight = 0                    # jobs on a worker, whatever their session
        self._partial_inflight = False
        self._last_speech = 0.0
        self._last_level = 0.0
        self._level_emitted = 0.0
        self._stopping = False
        self._stop_done = None                # set by _finish() for stop() callers that wait
        self._starting = False
        self._speaking = False
        self._idle_handle = None
        self._wake = None                     # wake.WakeListener while the wake word is listened for
        self._wake_error = ''
        self._wake_download = None            # the wake model being downloaded (a task)
        self.exit_event = asyncio.Event()
        self.quit_requested = False           # Quit(): exit even if busy

    # -- lifecycle ----------------------------------------------------------

    @property
    def active(self):
        return self._source is not None

    @property
    def busy(self):
        """A session is running, starting, or a worker still has a job."""
        return self.active or self._starting or self._inflight > 0

    def _set_state(self, state):
        if state != self.state:
            self.state = state
            self._emit('State', state)

    def _set_model(self, model):
        if model != self.model:
            self.model = model
            self._emit('Model', model)

    def _unload_in(self):
        """Seconds until the model is let go, -1 when not scheduled."""
        if self._idle_handle is None or self.model != READY:
            return -1.0
        return max(0.0, self._idle_handle.when() - self._loop.time())

    def status(self):
        miss = models.missing()
        return {
            'version': Variant('s', __version__),
            'state': Variant('s', self.state),
            'models_ready': Variant('b', not miss),
            'missing': Variant('as', miss),
            'loaded': Variant('b', bool(self._recognizer and self._recognizer.loaded)),
            'load_seconds': Variant('d', self._recognizer.load_seconds if self._recognizer else 0.0),
            'voices': Variant('as', models.voices_ready()),
            'speaking': Variant('b', bool(self._speaker and self._speaker.speaking)),
            'model': Variant('s', self.model),
            'unload_in_s': Variant('d', self._unload_in()),
            'wake': Variant('s', self._wake_state()),
        }

    # -- wake word ---------------------------------------------------------------

    def _wake_state(self):
        if self._wake is not None and self._wake.running:
            return 'listening'
        if self._wake is not None and self._wake.failure:
            return f'error: {self._wake.failure}'
        if self._wake_download is not None:
            return 'downloading'
        return self._wake_error or 'off'

    async def listen(self, options):
        """Listen for the wake word, or stop. options: enabled (b), phrases
        (JSON list), source (PipeWire node, '' = default), sensitivity (d).
        Returns '' or why not ('wake-model-missing', 'audio: …')."""
        self._cancel_idle()
        self._stop_listening()
        self._wake_error = ''
        self._wake_wanted = options            # what to do once a download ends
        if not bool(_opt(options, 'enabled', False)):
            self._schedule_idle()
            return ''
        from . import wakeword
        from .asr import SileroVad
        from .wake import WakeListener
        if wakeword.missing():
            # The small model (~54 MB) comes the first time the word is
            # switched on; listening starts once it is there.
            if self._wake_download is None:
                self._wake_download = self._loop.create_task(self._download_wake(options))
            self._wake_error = 'wake-downloading'
            return self._wake_error
        try:
            phrases = wakeword.phrases_from_json(str(_opt(options, 'phrases', '')))
            detector = await self._loop.run_in_executor(
                None, lambda: wakeword.Detector(phrases, sensitivity=float(_opt(options, 'sensitivity', 0.5))))
            vad = SileroVad(threshold=0.5, min_silence_s=0.25, max_speech_s=6.0)
        except Exception as e:
            self._wake_error = f'wake: {e}'
            self._schedule_idle()
            return self._wake_error

        def heard(phrase):
            try:
                self._loop.call_soon_threadsafe(self._on_wake, phrase)
            except RuntimeError:
                pass
        listener = WakeListener(detector, heard, vad=vad, target=str(_opt(options, 'source', '')))
        try:
            listener.start()
        except Exception as e:
            self._wake_error = f'audio: {e}'
            self._schedule_idle()
            return self._wake_error
        self._wake = listener
        if self.active:
            listener.suspend(True)
        self._schedule_idle()
        return ''

    async def _download_wake(self, options):
        try:
            miss = await self._loop.run_in_executor(None, lambda: models.setup_wake(log=lambda _m: None))
        except Exception as e:
            miss = [str(e)]
        self._wake_download = None
        if miss:
            self._wake_error = 'wake-model-missing'
            self._schedule_idle()
            return
        wanted = getattr(self, '_wake_wanted', options)
        if bool(_opt(wanted, 'enabled', False)):
            await self.listen(wanted)
        else:
            self._schedule_idle()

    def _stop_listening(self):
        if self._wake is not None:
            self._wake.stop()
            self._wake = None

    def _on_wake(self, phrase):
        if self.active or self._starting:
            return
        self._emit('Wake', phrase)

    # -- text-to-speech -------------------------------------------------------

    def _get_speaker(self):
        if self._speaker is None:
            from .tts import Speaker
            self._speaker = Speaker()
        return self._speaker

    async def rewrite(self, text, instruction, cloud=None):
        """`text` rewritten as `instruction` says (rewrite.py), or '' when
        no language model could do it. On the polish worker: one LLM job at
        a time, and never on the speech decoder's thread."""
        from .rewrite import rewrite
        self._cancel_idle()
        self._inflight += 1
        try:
            return await self._loop.run_in_executor(
                self._polish_executor, lambda: rewrite(text, instruction, cloud=cloud))
        finally:
            self._inflight -= 1
            self._schedule_idle()

    async def speak(self, text, lang='fr', speed=1.0):
        """Say `text` aloud. Returns '' when it started, else why not
        ('voice-missing', 'empty', 'failed'). A sentence being said is cut."""
        self._cancel_idle()
        text = ' '.join(str(text or '').split())
        if not text:
            return 'empty'
        lang = lang if lang in models.VOICES else 'fr'
        if not models.voice_ready(lang):
            self._schedule_idle()
            return 'voice-missing'
        speaker = self._get_speaker()
        self._inflight += 1
        try:
            proc = await self._loop.run_in_executor(self._tts_executor, speaker.speak, text, lang, speed)
        except Exception:
            self._schedule_idle()
            return 'failed'
        finally:
            self._inflight -= 1
        if proc is None:
            self._schedule_idle()
            return 'empty'
        self._emit('Speaking', True)
        if self._speak_task:
            self._speak_task.cancel()
        self._speak_task = self._loop.create_task(self._watch_player(proc))
        return ''

    async def _watch_player(self, proc):
        try:
            await self._loop.run_in_executor(None, proc.wait)
        finally:
            if self._speaker:
                self._speaker.finished()
            if not (self._speaker and self._speaker.speaking):
                self._emit('Speaking', False)
            self._schedule_idle()

    def stop_speaking(self):
        if self._speaker and self._speaker.speaking:
            self._speaker.stop()
            self._emit('Speaking', False)

    def _ensure_models(self):
        from .asr import Recognizer, SileroVad
        if self._recognizer is None:
            self._recognizer = Recognizer()
        if self._vad is None:
            self._vad = SileroVad()
        else:
            self._vad.reset()

    async def start(self, options=None):
        options = options or {}
        if self.active or self._starting:
            raise Busy()
        self._starting = True
        try:
            await self._start(options)
        finally:
            self._starting = False

    async def _start(self, options):
        self._cancel_idle()
        miss = models.missing()
        if miss:
            self._fail('models-missing')
            return
        if self._recognizer is None or not self._recognizer.loaded:
            # Not enough free memory for the speech model: say so instead
            # of pushing the whole desktop into swap.
            from . import memory
            short = memory.shortage(memory.ASR_NEED_MB)
            if short:
                self._fail(f'low-memory:{short}')
                return
        self._gen += 1
        gen = self._gen
        self._opts = {
            'polish': bool(_opt(options, 'polish', False)),
            'tidy': bool(_opt(options, 'tidy', True)),
            'silence_stop_s': float(_opt(options, 'silence-stop-s', 0.0)),
            'audio_file': str(_opt(options, 'audio-file', '')),
            'realtime': bool(_opt(options, 'realtime', True)),
            'source': str(_opt(options, 'source', '')),
            'corrections': bool(_opt(options, 'corrections', True)),
            'whole_pass': bool(_opt(options, 'whole-pass', False)),
            # Off by default: on the bench, the 3 s of audio context cost
            # more words at the block boundaries than they won (WER 10.9 %
            # against 10.5 % on read French, contiguous blocks alone).
            'context': bool(_opt(options, 'context', False)),
        }
        # The whole dictation's audio, for the final pass (whole_text()).
        self._audio = []
        self._audio_len = 0
        # Personal words and replacements (JSON strings), and the numbering
        # of a spoken list, for this session.
        self._vocab = Vocabulary.from_options(str(_opt(options, 'vocabulary', '')),
                                              str(_opt(options, 'replacements', '')))
        self._lists = Lists()
        # How long the model stays loaded once idle: the client's setting,
        # kept for the following sessions.
        keep = float(_opt(options, 'keep-loaded-s', -1.0))
        if keep >= 0:
            self._idle_unload_s = keep
        if self._opts['polish']:
            # Start the LLM server while the user talks (a few seconds).
            from . import polish
            self._loop.run_in_executor(self._polish_executor, polish.prepare)
        self._ensure_models()
        # The live window must cover a whole segment: the VAD cuts a segment
        # at max_speech_s, so a shorter window would drop the first words of
        # the preedit before the final restores them (M4).
        window = getattr(self._vad, 'max_speech_s', 8.0) + 1.0
        self._segmenter = Segmenter(self._vad, partial_window_s=window)
        self._pending = set()
        self._partial_inflight = False
        self._stopping = False
        self._last_speech = time.monotonic()
        self._last_level = 0.0
        self._level_emitted = 0.0
        self._speaking = False

        def on_chunk(chunk, g=gen):
            try:
                self._loop.call_soon_threadsafe(self._on_chunk, g, chunk)
            except RuntimeError:
                pass                          # loop closed: shutting down
        # Test harnesses replace the microphone with a WAV file.
        if not self._opts['audio_file'] and os.environ.get('VOICE_HOLD_AUDIO_FILE'):
            self._opts['audio_file'] = os.environ['VOICE_HOLD_AUDIO_FILE']
        if self._opts['audio_file']:
            source = FileSource(self._opts['audio_file'], on_chunk, realtime=self._opts['realtime'])
        elif bool(_opt(options, 'from-wake', False)) and self._wake is not None and self._wake.woken:
            # Started by the wake word: the listener's own stream, from the
            # end of the word, so a sentence said in one breath is whole.
            source = self._wake.lend(on_chunk)
        else:
            source = MicSource(on_chunk, target=self._opts['source'])
            if self._wake is not None:
                self._wake.suspend(True)      # the shortcut: no wake word in the middle of a dictation
        try:
            source.start()
        except Exception as e:
            self._fail(f'audio: {e}')
            return
        self._source = source
        if self._opts['audio_file']:
            self._emit('Source', os.path.basename(self._opts['audio_file']))
        else:
            # pw-dump can take a while: off the loop, reported when known.
            from .sources import describe
            fut = self._loop.run_in_executor(None, describe, self._opts['source'])
            fut.add_done_callback(lambda f, g=gen: self._on_described(g, f))

        if not self._recognizer.loaded:
            self._set_state(LOADING)
            self._set_model(LOADING)
            self._inflight += 1
            fut = self._loop.run_in_executor(self._executor, self._recognizer.load)
            self._pending.add(fut)
            # Future callbacks already run on the loop thread, in registration
            # order: ours is registered before stop()'s gather, so results are
            # emitted before `Stopped`.
            fut.add_done_callback(lambda f, g=gen: self._on_loaded(g, f))
        else:
            self._set_state(LISTENING)

    def _on_described(self, gen, fut):
        if gen != self._gen or not self.active:
            return
        try:
            self._emit('Source', fut.result())
        except Exception:
            pass

    def _on_loaded(self, gen, fut):
        self._pending.discard(fut)
        self._inflight -= 1
        if gen != self._gen:
            return
        try:
            fut.result()
        except Exception as e:
            self._set_model(ASLEEP)
            self._emit('Error', f'model: {e}')
            self._finish('error')
            return
        self._set_model(READY)
        if self.active and not self._stopping:
            self._set_state(LISTENING)

    # A start that went nowhere: the client gets Error then Stopped('error')
    # so it never waits for a session that does not exist.
    def _fail(self, message):
        self._emit('Error', message)
        self._set_state(IDLE)
        self._emit('Stopped', 'error')
        self._schedule_idle()

    async def stop(self, reason='stop'):
        if not self.active:
            return
        if self._stopping:
            # Already stopping (end of audio, silence, an earlier Stop) and
            # waiting for its decodes: this caller gets its answer when that
            # stop is over, not before. A client takes the answer to mean
            # that `Stopped` is out, and gives up on the session otherwise.
            await self._stop_done.wait()
            return
        self._stopping = True
        done = self._stop_done = asyncio.Event()
        gen = self._gen
        try:
            self._source.stop()
            if self._segmenter is not None:
                for ev in self._segmenter.flush():
                    self._handle_event(gen, ev)
            if self._pending:
                self._set_state(DECODING)
            # A decode may queue a polish job when it completes: loop until
            # the session has nothing left in flight. gather() of futures that
            # are already done returns without yielding (Python 3.12+), while
            # their own done-callbacks (_on_decoded, which emits Final and
            # drops them from _pending) are only queued: sleep(0) lets those
            # run first.
            while self._pending and gen == self._gen:
                await asyncio.gather(*list(self._pending), return_exceptions=True)
                await asyncio.sleep(0)
            if self._opts.get('whole_pass') and gen == self._gen and self._audio:
                await self._whole_pass(gen)
        except Exception:
            # A stop that dies must not keep the session "stopping" for ever,
            # nor the callers that wait for it: the next stop() starts over.
            if self._stop_done is done:
                self._stopping = False
                self._stop_done = None
            done.set()
            raise
        if gen != self._gen:
            return                            # cancelled meanwhile; maybe restarted
        if self._stop_done is not done:
            return                            # finished meanwhile (the model failed to load)
        self._finish(reason)

    async def _whole_pass(self, gen):
        """The whole dictation decoded at once: the words of each block now
        hear those around them (no word lost at a cut, sentences punctuated
        as one). Emitted as Whole(text) before Stopped; the client uses it
        where it held the text back. Too long (WHOLE_MAX_S): nothing."""
        if self._audio_len >= WHOLE_MAX_S * 16000:
            return
        audio = np.concatenate(self._audio)
        self._audio = []
        self._set_state(DECODING)
        self._inflight += 1
        try:
            raw = await self._loop.run_in_executor(self._executor, self._recognizer.transcribe, audio)
        except Exception as e:
            self._emit('Error', f'decode: {e}')
            return
        finally:
            self._inflight -= 1
        if gen != self._gen:
            return
        self._emit('Whole', self._shape(raw, Lists(), final=True))

    def _shape(self, raw, lists, final):
        """The text clean-up of a decoded block (or of the whole dictation)."""
        if raw and self._opts['tidy']:
            raw = textmod.tidy(raw)
        if raw and self._opts.get('corrections'):
            raw = correct(raw)
        if raw:
            raw = self._vocab.apply(raw)
        return lists.format(textmod.clean(raw), final) if raw else ''

    def cancel(self):
        if not self.active:
            return
        self._gen += 1                       # drop every result still in flight
        self._finish('cancel')

    def _finish(self, reason):
        if self._source is not None:
            self._source.stop()
            self._source = None
        if self._wake is not None:
            self._wake.suspend(False)
        if self._speaking:
            self._speaking = False
            self._emit('Speech', False)
        self._segmenter = None
        self._stopping = False
        self._pending = set()
        self._partial_inflight = False
        self._set_state(IDLE)
        self._emit('Stopped', reason)
        if self._stop_done is not None:
            self._stop_done.set()
            self._stop_done = None
        self._schedule_idle()

    # -- audio --------------------------------------------------------------

    def _on_chunk(self, gen, chunk):
        if gen != self._gen or not self.active or self._stopping:
            return
        if chunk is None:
            failure = getattr(self._source, 'failure', None)
            if failure:
                self._emit('Error', f'audio: {failure}')
                self._loop.create_task(self.stop('error'))
            else:
                self._loop.create_task(self.stop('end-of-audio'))
            return
        level = rms(chunk)
        # Smooth decay so the meter does not flicker; emit at ~10/s.
        self._last_level = max(level, self._last_level * 0.8)
        now = time.monotonic()
        if now - self._level_emitted >= LEVEL_PERIOD_S:
            self._level_emitted = now
            self._emit('Level', round(self._last_level, 3))
        if self._opts.get('whole_pass') and self._audio_len < WHOLE_MAX_S * 16000:
            self._audio.append(chunk)
            self._audio_len += len(chunk)
        for ev in self._segmenter.feed(chunk):
            self._handle_event(gen, ev)
        speaking = self._segmenter.in_speech
        if speaking != self._speaking:
            self._speaking = speaking
            self._emit('Speech', speaking)
        if speaking:
            self._last_speech = now
        stop_after = self._opts['silence_stop_s']
        if stop_after > 0 and now - self._last_speech > stop_after and not self._segmenter.in_speech:
            self._loop.create_task(self.stop('silence'))

    def _handle_event(self, gen, ev):
        kind = ev[0]
        if kind == 'start':
            self._last_speech = time.monotonic()
        elif kind == 'partial':
            if not self._partial_inflight and not self._pending:
                self._submit(gen, ev[1], final=False)
        elif kind == 'final':
            self._submit(gen, ev[1], final=True, context=ev[2] if len(ev) > 2 else None)

    # -- decoding -----------------------------------------------------------

    def _submit(self, gen, samples, final, context=None):
        if not final:
            self._partial_inflight = True
        self._inflight += 1
        if context is not None and len(context) and self._opts.get('context', False):
            fut = self._loop.run_in_executor(self._executor, self._recognizer.transcribe, samples, context)
        else:
            fut = self._loop.run_in_executor(self._executor, self._recognizer.transcribe, samples)
        self._pending.add(fut)
        fut.add_done_callback(lambda f: self._on_decoded(gen, final, f))

    def _on_decoded(self, gen, final, fut):
        self._pending.discard(fut)
        self._inflight -= 1
        if not final:
            self._partial_inflight = False
        if gen != self._gen:
            return
        try:
            raw = fut.result()
        except Exception as e:
            self._emit('Error', f'decode: {e}')
            return
        if raw and self._opts['tidy']:
            raw = textmod.tidy(raw)
        if raw and self._opts.get('corrections'):
            raw = correct(raw)
        if raw:
            raw = self._vocab.apply(raw)
        if final and raw and self._opts['polish']:
            from .polish import polish
            self._inflight += 1
            pf = self._loop.run_in_executor(self._polish_executor, polish, raw)
            self._pending.add(pf)
            pf.add_done_callback(lambda f: self._on_polished(gen, raw, f))
            return
        self._emit_text(raw, final)

    def _on_polished(self, gen, raw, fut):
        self._pending.discard(fut)
        self._inflight -= 1
        if gen != self._gen:
            return
        try:
            out = fut.result()
        except Exception:
            out = raw
        self._emit_text(out or raw, True)

    def _emit_text(self, raw, final):
        text = self._lists.format(textmod.clean(raw), final)
        if not text:
            return
        if final:
            self._emit('Final', text)
        elif text.strip() and self.active and not self._stopping:
            self._emit('Partial', text)

    # -- idle ---------------------------------------------------------------

    def _schedule_idle(self):
        self._cancel_idle()
        if self._idle_unload_s <= 0:
            return
        self._idle_handle = self._loop.call_later(self._idle_unload_s, self._on_idle)

    def _cancel_idle(self):
        if self._idle_handle is not None:
            self._idle_handle.cancel()
            self._idle_handle = None

    def _on_idle(self):
        self._idle_handle = None
        if self.busy:
            # A session, a Start, or a decode still on a worker: later.
            self._schedule_idle()
            return
        if self._recognizer is not None and self._recognizer.loaded:
            self.unload()
            self._emit('State', IDLE)
            self._schedule_idle()
        elif (self._wake is not None and self._wake.running) or self._wake_download is not None:
            self._schedule_idle()             # listening for the wake word, or fetching its model: stay
        else:
            self.exit_event.set()

    # -- model on demand (the top-bar menu) -------------------------------------

    async def preload(self, options=None):
        """Load the speech model now, so that the next dictation starts at
        once. Returns '' or why not (as Error messages: 'models-missing',
        'low-memory:…', 'model: …')."""
        options = options or {}
        self._cancel_idle()
        keep = float(_opt(options, 'keep-loaded-s', -1.0))
        if keep >= 0:
            self._idle_unload_s = keep
        try:
            if self._recognizer is not None and self._recognizer.loaded:
                return ''
            if models.missing():
                return 'models-missing'
            from . import memory
            short = memory.shortage(memory.ASR_NEED_MB)
            if short:
                return f'low-memory:{short}'
            from .asr import Recognizer
            if self._recognizer is None:
                self._recognizer = Recognizer()
            self._set_model(LOADING)
            self._inflight += 1
            try:
                await self._loop.run_in_executor(self._executor, self._recognizer.load)
            except Exception as e:
                self._set_model(ASLEEP)
                return f'model: {e}'
            finally:
                self._inflight -= 1
            self._set_model(READY)
            return ''
        finally:
            if not self.active:
                self._schedule_idle()

    def release(self):
        """Give the model's memory back now, unless a dictation or a
        decode is using it. True when released (or nothing was loaded)."""
        if self.busy:
            return False
        if self._recognizer is not None and self._recognizer.loaded:
            self.unload()
            self._emit('State', IDLE)
        self._schedule_idle()
        return True

    def unload(self):
        from .asr import release_memory
        if self._recognizer is not None:
            self._recognizer.unload()
        if self._speaker is not None:
            self._speaker.unload()
        self._vad = None
        gc.collect()
        release_memory()
        self._set_model(ASLEEP)


class VoiceHoldInterface(ServiceInterface):
    def __init__(self, engine):
        super().__init__(INTERFACE)
        self._engine = engine

    @method()
    async def Start(self, options: 'a{sv}'):
        self._engine.exit_event.clear()
        try:
            await self._engine.start(options)
        except Busy:
            raise DBusError(BUSY_ERROR, 'a dictation session is still active')

    @method()
    async def Stop(self):
        await self._engine.stop('stop')

    @method()
    def Cancel(self):
        self._engine.cancel()

    @method()
    def Status(self) -> 'a{sv}':
        return self._engine.status()

    @method()
    async def Load(self, options: 'a{sv}') -> 's':
        """Load the speech model now. options: keep-loaded-s. Returns ''
        or why not."""
        self._engine.exit_event.clear()
        return await self._engine.preload(options)

    @method()
    def Unload(self) -> 'b':
        """Release the speech model now; false while it is in use."""
        return self._engine.release()

    @method()
    def Quit(self):
        self._engine.quit_requested = True
        self._engine.exit_event.set()

    @method()
    async def Speak(self, text: 's', options: 'a{sv}') -> 's':
        """Say text aloud with the installed voice. options: lang ("fr" or
        "en"), speed (1.0). Returns '' or why it could not."""
        self._engine.exit_event.clear()
        return await self._engine.speak(text, str(_opt(options, 'lang', 'fr')),
                                        float(_opt(options, 'speed', 1.0)))

    @method()
    async def Rewrite(self, text: 's', instruction: 's', options: 'a{sv}') -> 's':
        """`text` rewritten as `instruction` says; '' when no language model
        could. options: cloud (b), cloud-provider, cloud-model."""
        self._engine.exit_event.clear()
        cloud = None
        if bool(_opt(options, 'cloud', False)):
            cloud = {'provider': str(_opt(options, 'cloud-provider', 'anthropic')),
                     'model': str(_opt(options, 'cloud-model', ''))}
        return await self._engine.rewrite(text, instruction, cloud)

    @method()
    async def Listen(self, options: 'a{sv}') -> 's':
        """Listen for the wake word (options: enabled, phrases as JSON,
        source, sensitivity), or stop with enabled false. '' or why not."""
        self._engine.exit_event.clear()
        return await self._engine.listen(options)

    @method()
    def StopSpeaking(self):
        self._engine.stop_speaking()

    @method()
    async def ListSources(self) -> 'aa{sv}':
        from .sources import list_sources
        sources = await asyncio.get_running_loop().run_in_executor(None, list_sources)
        return [{
            'name': Variant('s', s['name']),
            'description': Variant('s', s['description']),
            'default': Variant('b', s['default']),
        } for s in sources]

    @signal()
    def State(self, state: 's') -> 's':
        return state

    @signal()
    def Model(self, model: 's') -> 's':
        return model

    @signal()
    def Source(self, description: 's') -> 's':
        return description

    @signal()
    def Level(self, level: 'd') -> 'd':
        return level

    @signal()
    def Speech(self, speaking: 'b') -> 'b':
        return speaking

    @signal()
    def Partial(self, text: 's') -> 's':
        return text

    @signal()
    def Final(self, text: 's') -> 's':
        return text

    @signal()
    def Stopped(self, reason: 's') -> 's':
        return reason

    @signal()
    def Speaking(self, speaking: 'b') -> 'b':
        return speaking

    @signal()
    def Whole(self, text: 's') -> 's':
        return text

    @signal()
    def Wake(self, phrase: 's') -> 's':
        return phrase

    @signal()
    def Error(self, message: 's') -> 's':
        return message


async def serve():
    from dbus_fast import BusType, RequestNameReply
    from dbus_fast.aio import MessageBus
    from . import BUS_NAME, OBJECT_PATH

    loop = asyncio.get_running_loop()
    iface_box = {}

    def emit(name, *args):
        iface = iface_box.get('iface')
        if iface is not None:
            getattr(iface, name)(*args)

    engine = Engine(emit, loop=loop)
    iface = VoiceHoldInterface(engine)
    iface_box['iface'] = iface

    bus = await MessageBus(bus_type=BusType.SESSION).connect()
    bus.export(OBJECT_PATH, iface)
    reply = await bus.request_name(BUS_NAME)
    if reply not in (RequestNameReply.PRIMARY_OWNER, RequestNameReply.ALREADY_OWNER):
        raise SystemExit(f'{BUS_NAME} is already running')
    # Exit when idle for long enough even if nobody ever called us.
    engine._schedule_idle()
    gone = loop.create_task(bus.wait_for_disconnect())
    while True:
        done = loop.create_task(engine.exit_event.wait())
        await asyncio.wait({done, gone}, return_when=asyncio.FIRST_COMPLETED)
        if gone.done():
            done.cancel()
            break
        # A Start may have slipped in between the idle timer and here: stay.
        if engine.busy and not engine.quit_requested:
            engine.exit_event.clear()
            continue
        break
    if engine.active:
        engine.cancel()
    engine._stop_listening()
    gone.cancel()
    bus.disconnect()
