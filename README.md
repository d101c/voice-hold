# Voice Hold

**Hold a key, speak, and the words appear where your cursor is.**
Press-and-hold dictation for GNOME, fully offline.

[Version française](README.fr.md)

![Hold Super+X and speak](docs/demo-dictation.gif)

- **Hold `Super+X`** and talk; release to stop. **Tap** it instead to dictate
  hands-free (tap again, `Esc`, or a few seconds of silence stop it).
- The text lands **in the field under your cursor**, block by block, while
  you speak: a grey live preview, then each phrase is typed for good.
- A pill slides out of the top bar while you dictate, with the microphone
  level and the words, and goes back into it when you stop. Always in the
  same place; it can follow the text cursor instead (settings).
- **Offline.** French, English and 23 other European languages, with
  punctuation and capitals, recognised on your CPU by Parakeet TDT 0.6B v3
  (via sherpa-onnx). No account, no network, no cloud. It works on a plane.
- Say *nouvelle ligne* / *new line* / *new paragraph* for a line break: on
  its own, or at the end of a phrase ("see you tomorrow, new line"). Inside
  a sentence it stays text ("the new line of products").
- Optional: a local LLM (Ollama) can polish each block. Off by default.
- Nothing runs when you are not dictating; the model leaves memory after
  5 minutes of inactivity.

Second member of the *Hold* family after
[Accent Hold](https://github.com/d101c/accent-hold).

## Install

Two parts: the engine (a small Python program) and the extension.

```bash
pipx install git+https://github.com/d101c/voice-hold#subdirectory=engine
voice-hold-engine setup
```

`setup` downloads the models (~470 MB, 650 MB unpacked, once; every file is
checked against a pinned SHA-256) and registers the engine as a D-Bus
service that GNOME Shell starts on demand. `uv tool install` works too.
Needs Python ≥ 3.12 and PipeWire (any recent GNOME).

Then install the extension from extensions.gnome.org (soon), or from source:

```bash
git clone https://github.com/d101c/voice-hold && cd voice-hold
./pack.sh && gnome-extensions install --force voice-hold@griffit.gmail.com.shell-extension.zip
```

Log out and back in (Wayland), enable *Voice Hold*, click in a text field,
hold `Super+X` and speak.

Optional voices, for other programs that want the engine to speak:

```bash
voice-hold-engine setup --tts        # French and English (~65 MB each), or: --tts fr
voice-hold-engine speak "Bonjour"    # a quick check
```

They are [Piper](https://github.com/rhasspy/piper) voices (fr_FR-siwis,
en_US-lessac) run by sherpa-onnx and played through PipeWire; a sentence is
synthesised in a few hundred milliseconds on a laptop CPU. The engine pins
sherpa-onnx below 2.0, which dropped the espeak-ng front end these voices need.

## Requirements and limits

- GNOME Shell 45 – 51 on Wayland.
- Works in applications that use the Wayland text-input protocol (GTK 4,
  GTK 3, Qt, Electron with Wayland, Firefox…). Terminals get the final
  blocks but not the grey preview. X11 applications are not supported.
- CPU only. On a 2019 quad-core laptop a 5-second phrase is typed about
  half a second after you pause; the model takes ~1.1 GB of RAM while
  loaded and ~5 s to load the first time.

## Uninstall, update

```bash
voice-hold-engine uninstall --models   # removes the D-Bus service file and the models
pipx uninstall voice-hold-engine       # or: uv tool uninstall voice-hold-engine
```

Without `--models` the models stay (`~/.local/share/voice-hold/models`).
To update the engine, `pipx reinstall voice-hold-engine` (or `pipx install
--force git+…`) is enough: the service file points at the interpreter of
the pipx environment, whose path does not change. `voice-hold-engine status
--verify` checks the model files against their pinned checksums.

## Settings

Shortcut, gesture (hold / tap / both), tap threshold, silence timeout,
optional Ollama polish (model, URL), pill (on or off, under the top bar or
next to the text cursor) and top-bar indicator. The settings page also shows
the engine status and the install command. The engine's `Speak` method
(text, language) is there for other programs on the session bus;
`voice-hold-engine status` lists the installed voices.

## How it works

The extension hooks GNOME Shell's input method (`Main.inputMethod`), the
same object Accent Hold uses: live text goes in as *preedit* (the
application underlines it), finished blocks are *committed*. The engine
captures the microphone with `pw-record`, cuts speech at pauses with the
Silero voice activity detector, decodes each finished segment with Parakeet
and, while you are still speaking, re-decodes the current segment every
~0.8 s for the preview. See
[docs/superpowers/specs/2026-11-02-voice-hold-design.md](docs/superpowers/specs/2026-11-02-voice-hold-design.md).

The engine is a session D-Bus service (`org.griffit.VoiceHold`), like any
other user service: every process of your session can call it and read its
signals, with your own privileges. Nothing is written to disk by the engine
and nothing leaves the machine, but another local process could start a
dictation or read the recognised text; the session bus has no finer access
control than that.

## Development

```bash
for t in extension/tests/*.test.js; do gjs -m "$t"; done
cd engine && uv venv && uv pip install -e '.[test]' && .venv/bin/pytest
tools/headless/run.sh            # end-to-end in a headless GNOME Shell, with a WAV
```

`engine/tests/data/cafe.wav` is a sentence synthesised with Piper
(text-to-speech) and recorded by us for the tests and the demo; it contains
no one's voice.

## Transparency

Written with an AI coding assistant (Claude), designed, reviewed and tested
by hand by the author, who maintains it.

## Licences

Voice Hold (extension and engine) is **GPL-2.0-or-later**: the GPLv2 text
is in [LICENSE](LICENSE) and [engine/LICENSE](engine/LICENSE), and you may
use any later version. The "or later" matters: the engine links sherpa-onnx,
which is Apache-2.0, a licence compatible with GPLv3 but not with GPLv2
alone; the combination is distributed under the terms of GPLv3.

What the engine uses:

| Component | Licence | Notes |
|---|---|---|
| [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (int8 export by sherpa-onnx) | CC-BY-4.0, NVIDIA | Downloaded by you at `setup` from the sherpa-onnx releases; not redistributed here. Attribution: NVIDIA NeMo. |
| [Silero VAD](https://github.com/snakers4/silero-vad) | MIT | Downloaded by you at `setup`; not redistributed here. |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 | Speech recognition and VAD runtime. |
| [onnxruntime](https://github.com/microsoft/onnxruntime) | MIT | Through sherpa-onnx. |
| [dbus-fast](https://github.com/Bluetooth-Devices/dbus-fast) | MIT | D-Bus. |
| [numpy](https://numpy.org) | BSD-3-Clause | Audio buffers. |

The model files are fetched from the `asr-models` release of sherpa-onnx
and verified against SHA-256 checksums pinned in `engine/src/voice_hold_engine/models.py`
(taken from the GitHub release digests and confirmed by a download on
2026-11-03).
