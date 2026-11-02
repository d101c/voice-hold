# voice-hold-engine

Local speech-to-text service for the [Voice Hold](../README.md) GNOME Shell
extension. Runs Parakeet TDT 0.6B v3 (int8, via sherpa-onnx) and the Silero
voice activity detector on the CPU, fully offline, and exposes a small session
D-Bus service (`org.griffit.VoiceHold`) that the extension talks to.

```
pipx install git+https://github.com/d101c/voice-hold#subdirectory=engine
voice-hold-engine setup        # downloads the models (~650 MB) and installs the D-Bus service
voice-hold-engine status
```

`uv tool install` works the same way. Needs Python ≥ 3.12 and PipeWire
(`pw-record`).

## D-Bus interface

Object `/org/griffit/VoiceHold`, interface `org.griffit.VoiceHold`:

| Member | Kind | Notes |
|---|---|---|
| `Start(a{sv})` | method | options: `source` (s, PipeWire node name, '' = default microphone), `silence-stop-s` (d), `polish` (b), `polish-model` (s), `polish-url` (s), `audio-file` (s, tests), `realtime` (b) |
| `ListSources() → aa{sv}` | method | microphones known to PipeWire: `name`, `description`, `default` |
| `Source(s)` | signal | human name of the microphone (or file) just opened |
| `Stop()` | method | finishes: decodes what is left, then `Stopped("stop")` |
| `Cancel()` | method | drops everything in flight, `Stopped("cancel")` |
| `Status() → a{sv}` | method | `models_ready`, `missing`, `loaded`, `state`, `version`, `load_seconds` |
| `Quit()` | method | exit the process |
| `State(s)` | signal | `idle`, `loading`, `listening`, `decoding` |
| `Level(d)` | signal | microphone loudness 0..1, every 32 ms while listening |
| `Speech(b)` | signal | the voice activity detector entered / left speech |
| `Partial(s)` | signal | live text of the segment being spoken (replace the previous partial) |
| `Final(s)` | signal | a finished block; `"\n"` for a spoken line break |
| `Stopped(s)` | signal | `stop`, `cancel`, `silence`, `end-of-audio`, `error` |
| `Error(s)` | signal | `models-missing`, `audio: …`, `model: …`, `decode: …` |

The process unloads the model after 5 minutes without dictation
(`VOICE_HOLD_IDLE_S`) and exits after 5 more; D-Bus activation brings it back.

## Development

```
cd engine
uv venv && uv pip install -e '.[test]'
.venv/bin/pytest
VOICE_HOLD_MODELS=/path/to/models .venv/bin/voice-hold-engine transcribe sample.wav
```
