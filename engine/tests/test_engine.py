"""End-to-end on the real models with a WAV file (skipped when the models are
not installed)."""
import asyncio
import os
import wave
from pathlib import Path

import numpy as np
import pytest

from voice_hold_engine import models
from voice_hold_engine.service import Engine

HERE = Path(__file__).parent
SAMPLE = HERE / 'data' / 'cafe.wav'

needs_models = pytest.mark.skipif(bool(models.missing()), reason='models not installed')


def _collect(audio_file, realtime=False, **opts):
    events = []

    async def run():
        loop = asyncio.get_running_loop()
        done = asyncio.Event()

        def emit(name, *args):
            events.append((name, *args))
            if name == 'Stopped':
                done.set()

        engine = Engine(emit, loop=loop, idle_unload_s=0)
        await engine.start({'audio-file': audio_file, 'realtime': realtime, **opts})
        await asyncio.wait_for(done.wait(), timeout=120)

    asyncio.run(run())
    return events


@needs_models
def test_wav_gives_partials_then_finals():
    assert SAMPLE.exists()
    # Real time: partials only make sense while audio is still coming in.
    events = _collect(str(SAMPLE), realtime=True)
    names = [e[0] for e in events]
    assert ('Source', 'cafe.wav') in events
    assert ('State', 'loading') in events[:3]
    assert 'Level' in names
    finals = [e[1] for e in events if e[0] == 'Final']
    partials = [e[1] for e in events if e[0] == 'Partial']
    assert finals, events[-10:]
    assert partials, 'no live partial was emitted'
    joined = ' '.join(finals).lower()
    assert 'café' in joined or 'cafe' in joined
    assert events[-1] == ('Stopped', 'end-of-audio')
    # Every partial precedes the final of its segment.
    last_partial = max(i for i, e in enumerate(events) if e[0] == 'Partial')
    last_final = max(i for i, e in enumerate(events) if e[0] == 'Final')
    assert last_partial < last_final


@needs_models
def test_silence_only_gives_no_final(tmp_path):
    path = tmp_path / 'silence.wav'
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(np.zeros(16000 * 2, dtype=np.int16).tobytes())
    events = _collect(str(path))
    assert not [e for e in events if e[0] in ('Final', 'Partial')]
    assert events[-1] == ('Stopped', 'end-of-audio')
