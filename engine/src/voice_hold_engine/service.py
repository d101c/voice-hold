"""The dictation engine proper (Engine) and its D-Bus face (VoiceHoldInterface).

Threads: audio arrives on a capture thread and is handed to the asyncio loop
with call_soon_threadsafe; the VAD runs on the loop (cheap); decodes run one
at a time on a single worker thread so results come back in order.
"""
import asyncio
import os
import time
from concurrent.futures import ThreadPoolExecutor

from dbus_fast import Variant
from dbus_fast.service import ServiceInterface, method, signal

from . import INTERFACE, __version__, models, text as textmod
from .audio import FileSource, MicSource
from .segmenter import Segmenter, rms

IDLE = 'idle'
LOADING = 'loading'
LISTENING = 'listening'
DECODING = 'decoding'


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
        self._recognizer = None
        self._vad = None
        self.state = IDLE
        self._gen = 0                         # session generation
        self._source = None
        self._segmenter = None
        self._opts = {}
        self._pending = set()                 # decode futures of this session
        self._partial_inflight = False
        self._last_speech = 0.0
        self._last_level = 0.0
        self._stopping = False
        self._speaking = False
        self._idle_handle = None
        self.exit_event = asyncio.Event()

    # -- lifecycle ----------------------------------------------------------

    @property
    def active(self):
        return self._source is not None

    def _set_state(self, state):
        if state != self.state:
            self.state = state
            self._emit('State', state)

    def status(self):
        miss = models.missing()
        return {
            'version': Variant('s', __version__),
            'state': Variant('s', self.state),
            'models_ready': Variant('b', not miss),
            'missing': Variant('as', miss),
            'loaded': Variant('b', bool(self._recognizer and self._recognizer.loaded)),
            'load_seconds': Variant('d', self._recognizer.load_seconds if self._recognizer else 0.0),
        }

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
        if self.active:
            return
        self._cancel_idle()
        miss = models.missing()
        if miss:
            self._emit('Error', 'models-missing')
            return
        self._gen += 1
        gen = self._gen
        self._opts = {
            'polish': bool(_opt(options, 'polish', False)),
            'polish_model': str(_opt(options, 'polish-model', '')),
            'polish_url': str(_opt(options, 'polish-url', '')),
            'silence_stop_s': float(_opt(options, 'silence-stop-s', 0.0)),
            'audio_file': str(_opt(options, 'audio-file', '')),
            'realtime': bool(_opt(options, 'realtime', True)),
        }
        self._ensure_models()
        self._segmenter = Segmenter(self._vad)
        self._pending = set()
        self._partial_inflight = False
        self._stopping = False
        self._last_speech = time.monotonic()
        self._last_level = 0.0
        self._speaking = False

        on_chunk = lambda chunk, g=gen: self._loop.call_soon_threadsafe(self._on_chunk, g, chunk)
        # Test harnesses replace the microphone with a WAV file.
        if not self._opts['audio_file'] and os.environ.get('VOICE_HOLD_AUDIO_FILE'):
            self._opts['audio_file'] = os.environ['VOICE_HOLD_AUDIO_FILE']
        if self._opts['audio_file']:
            source = FileSource(self._opts['audio_file'], on_chunk, realtime=self._opts['realtime'])
        else:
            source = MicSource(on_chunk)
        try:
            source.start()
        except Exception as e:
            self._emit('Error', f'audio: {e}')
            self._set_state(IDLE)
            return
        self._source = source

        if not self._recognizer.loaded:
            self._set_state(LOADING)
            fut = self._loop.run_in_executor(self._executor, self._recognizer.load)
            self._pending.add(fut)
            # Future callbacks already run on the loop thread, in registration
            # order: ours is registered before stop()'s gather, so results are
            # emitted before `Stopped`.
            fut.add_done_callback(lambda f, g=gen: self._on_loaded(g, f))
        else:
            self._set_state(LISTENING)

    def _on_loaded(self, gen, fut):
        self._pending.discard(fut)
        if gen != self._gen:
            return
        try:
            fut.result()
        except Exception as e:
            self._emit('Error', f'model: {e}')
            self._finish('error')
            return
        if self.active and not self._stopping:
            self._set_state(LISTENING)

    async def stop(self, reason='stop'):
        if not self.active or self._stopping:
            return
        self._stopping = True
        self._source.stop()
        if self._segmenter is not None:
            for ev in self._segmenter.flush():
                self._handle_event(self._gen, ev)
        if self._pending:
            self._set_state(DECODING)
            await asyncio.gather(*list(self._pending), return_exceptions=True)
        self._finish(reason)

    def cancel(self):
        if not self.active:
            return
        self._gen += 1                       # drop every result still in flight
        self._source.stop()
        self._finish('cancel')

    def _finish(self, reason):
        if self._speaking:
            self._speaking = False
            self._emit('Speech', False)
        self._source = None
        self._segmenter = None
        self._stopping = False
        self._pending = set()
        self._partial_inflight = False
        self._set_state(IDLE)
        self._emit('Stopped', reason)
        self._schedule_idle()

    # -- audio --------------------------------------------------------------

    def _on_chunk(self, gen, chunk):
        if gen != self._gen or not self.active or self._stopping:
            return
        if chunk is None:
            self._loop.create_task(self.stop('end-of-audio'))
            return
        level = rms(chunk)
        # Smooth decay so the meter does not flicker.
        self._last_level = max(level, self._last_level * 0.8)
        self._emit('Level', round(self._last_level, 3))
        for ev in self._segmenter.feed(chunk):
            self._handle_event(gen, ev)
        now = time.monotonic()
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
            self._submit(gen, ev[1], final=True)

    # -- decoding -----------------------------------------------------------

    def _submit(self, gen, samples, final):
        if final:
            job = lambda: self._decode_final(samples)
        else:
            self._partial_inflight = True
            job = lambda: self._recognizer.transcribe(samples)
        fut = self._loop.run_in_executor(self._executor, job)
        self._pending.add(fut)
        fut.add_done_callback(lambda f: self._on_decoded(gen, final, f))

    def _decode_final(self, samples):
        raw = self._recognizer.transcribe(samples)
        if raw and self._opts['polish']:
            from .polish import DEFAULT_MODEL, DEFAULT_URL, polish
            raw = polish(raw, url=self._opts['polish_url'] or DEFAULT_URL,
                         model=self._opts['polish_model'] or DEFAULT_MODEL)
        return raw

    def _on_decoded(self, gen, final, fut):
        self._pending.discard(fut)
        if not final:
            self._partial_inflight = False
        if gen != self._gen:
            return
        try:
            raw = fut.result()
        except Exception as e:
            self._emit('Error', f'decode: {e}')
            return
        text = textmod.clean(raw)
        if final:
            if not text and textmod.is_only_command(raw):
                text = '\n'
            if text:
                self._emit('Final', text)
        elif text and self.active and not self._stopping:
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
        if self.active:
            return
        if self._recognizer is not None and self._recognizer.loaded:
            self._recognizer.unload()
            self._vad = None
            self._emit('State', IDLE)
            self._idle_handle = self._loop.call_later(self._idle_unload_s, self._on_idle)
        else:
            self.exit_event.set()


class VoiceHoldInterface(ServiceInterface):
    def __init__(self, engine):
        super().__init__(INTERFACE)
        self._engine = engine

    @method()
    async def Start(self, options: 'a{sv}'):
        await self._engine.start(options)

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
    def Quit(self):
        self._engine.exit_event.set()

    @signal()
    def State(self, state: 's') -> 's':
        return state

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
    done = loop.create_task(engine.exit_event.wait())
    gone = loop.create_task(bus.wait_for_disconnect())
    await asyncio.wait({done, gone}, return_when=asyncio.FIRST_COMPLETED)
    if engine.active:
        engine.cancel()
    bus.disconnect()
