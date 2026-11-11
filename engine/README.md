# voice-hold-engine

Local speech-to-text service for the [Voice Hold](../README.md) GNOME Shell
extension. Runs Parakeet TDT 0.6B "Ultra" (int8, via sherpa-onnx) and the Silero
voice activity detector on the CPU, fully offline, and exposes a small session
D-Bus service (`org.griffit.VoiceHold`) that the extension talks to.

```
pipx install git+https://github.com/d101c/voice-hold#subdirectory=engine
voice-hold-engine setup        # downloads the models (~470 MB, SHA-256 checked) and installs the D-Bus service
voice-hold-engine status       # --verify also hashes the model files
voice-hold-engine uninstall    # removes the service file (--models: the models too)
```

`uv tool install` works the same way. Needs Python ≥ 3.12 and PipeWire
(`pw-record`).

## D-Bus interface

Object `/org/griffit/VoiceHold`, interface `org.griffit.VoiceHold`:

| Member | Kind | Notes |
|---|---|---|
| `Start(a{sv})` | method | options: `source` (s, PipeWire node name, '' = default microphone), `silence-stop-s` (d), `polish` (b, through the local llama.cpp server), `audio-file` (s, tests), `realtime` (b). Fails with `org.griffit.VoiceHold.Error.Busy` while a session is active or still decoding. A start that goes nowhere (models missing, microphone, model load) emits `Error` then `Stopped("error")`. |
| `ListSources() → aa{sv}` | method | microphones known to PipeWire: `name`, `description`, `default` |
| `Source(s)` | signal | human name of the microphone (or file) just opened |
| `Stop()` | method | finishes: decodes what is left, then `Stopped("stop")` |
| `Cancel()` | method | drops everything in flight, `Stopped("cancel")` |
| `Status() → a{sv}` | method | `models_ready`, `missing`, `loaded`, `state`, `version`, `load_seconds` |
| `Quit()` | method | exit the process |
| `State(s)` | signal | `idle`, `loading`, `listening`, `decoding` |
| `Level(d)` | signal | microphone loudness 0..1, about 10 times a second while listening |
| `Speech(b)` | signal | the voice activity detector entered / left speech |
| `Partial(s)` | signal | live text of the segment being spoken (replace the previous partial) |
| `Final(s)` | signal | a finished block; `"\n"` for a spoken line break |
| `Stopped(s)` | signal | `stop`, `cancel`, `silence`, `end-of-audio`, `error` |
| `Error(s)` | signal | `models-missing`, `audio: …` (microphone, or pw-record died: its exit status and stderr), `model: …`, `decode: …`. All but `decode` are followed by `Stopped("error")`. |

The process unloads the model after 5 minutes without dictation
(`VOICE_HOLD_IDLE_S`), gives the memory back to the kernel (`malloc_trim`)
and exits after 5 more; D-Bus activation brings it back. The service file
runs `<python of the install> -m voice_hold_engine serve`.

Security: this is an ordinary session-bus service; any process of the
user's session can call it and read its signals. Licence: GPL-2.0-or-later
(see `LICENSE`; the "or later" is what allows linking Apache-2.0
sherpa-onnx). Models: Parakeet Ultra (Moondream, CC-BY-4.0, post-trained from
NVIDIA's Parakeet TDT 0.6B v3) and Silero VAD (MIT), downloaded by the user,
verified against pinned SHA-256 sums.

## Voice commands (optional)

`voice-hold-engine setup --commands` downloads a llama.cpp server (MIT,
release b12284) and Qwen3.5-2B Q4_K_M (Apache-2.0, 1.2 GB) into
`~/.local/share/voice-hold/llm`, both pinned to a SHA-256, and installs a
second D-Bus service, `org.griffit.VoiceHold.Commands` (`voice-hold-engine
commands-serve`). It turns a transcript into an intent: rules first (under a
millisecond), the LLM for what they leave (constrained to a JSON schema),
then guard rails computed from the command text alone (refuse, confirm, or
run silently when read-only). The server listens on 127.0.0.1:18642
(`VOICE_HOLD_LLM_PORT`), is started on demand, unloads the model after ten
minutes without a request and is stopped when the helper exits.
`voice-hold-engine interpret "ouvre firefox"` shows what a sentence would
do, without doing it. The optional polish of dictated blocks uses the same
server.

## Development

```
cd engine
uv venv && uv pip install -e '.[test]'
.venv/bin/pytest
VOICE_HOLD_MODELS=/path/to/models .venv/bin/voice-hold-engine transcribe sample.wav
```
