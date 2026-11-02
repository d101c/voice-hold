# Annexe B — relecture indépendante de Voice Hold 0.1 (rapport brut, 3/11/2026)

Rapport d'un agent relecteur sans accès à l'historique du projet. Vérifications
faites par lui : pytest (14 OK), tests gjs (OK), règles de revue gjs.guide
(copie en ligne), `inputMethod.js` et `layout.js` de GNOME 45/46/main,
`keybindings.c` et `clutter-input-method.h` de mutter 45. Hôte : GNOME
Shell 50.1, sherpa-onnx 2.0.1, dbus-fast 5.2.0, Python 3.14.4.

## 1. Extension bugs (ranked)

**C1. Holding Super+R stops the dictation after ~0.5 s (key autorepeat).** `extension.js` registers the binding with `Meta.KeyBindingFlags.NONE`. Mutter only suppresses repeats when `IGNORE_AUTOREPEAT` is set (opt-in, verified in mutter 45 `keybindings.c`). `holdMachine.js` treats any second activation as "stop". After the repeat delay the binding fires every ~30 ms → stop/start/stop… spam of Start/Stop, HUD flicker, no text. The headless harness never hits this because `inject.py` taps `r` and holds only `meta`. Fix: `Meta.KeyBindingFlags.IGNORE_AUTOREPEAT`.

**C2. Engine death mid-dictation leaves everything stuck.** `engine.js` only connects `g-signal`; no `notify::g-name-owner` watch. If the Python process dies, no `Stopped` ever arrives: `_session` stays true, the grey preedit stays in the app, the pill stays on screen for ever, the 60 ms decay timer runs indefinitely. Releasing the key → `Stop` → D-Bus activates a *fresh* engine whose `stop()` is a no-op → nothing cleaned. Fix: watch `g-name-owner`; on loss treat as `Stopped('error')`; also end the session locally if `Stop` returns without a `Stopped` within a few seconds.

**H1. Text is committed into whatever window has focus now, not where it was dictated.** `notify::focus-window` → `external('focus')` → `stop` → the engine decodes the last block → `Final` → commits into `Main.inputMethod.currentFocus` *at that moment*. A polkit/password dialog or notification stealing focus gets the dictated text. Fix: capture the focus window at `_start()`; refuse `commit`/`partial` when it differs, or cancel on focus change.

**H2. Pressing the shortcut while the previous session is still decoding silently does nothing.** After `_stop()` the machine is IDLE but the engine is DECODING for up to ~1 s (+2.5 s with polish). A new `shortcut()` → `Start` → `service.py` `if self.active: return` silently → extension believes the session started, then the *old* `Stopped('stop')` arrives and kills the new gesture. The user is holding the key, speaking, nothing is recorded. Also `_sink.begin()` resets `_blocks` before the old final lands → missing leading space. Fix: queue the start until `Stopped`, or make `Start` on an active engine a D-Bus error.

**H3. Accent Hold + Voice Hold: disabling Accent Hold first breaks both hooks.** Both patch `IBus.InputContext.prototype.process_key_event_async` and restore unconditionally. Order AH-enable, VH-enable, AH-disable: AH restores the original → VH's Escape filter is silently gone. Then VH-disable restores AH's *dead* wrapper → every keystroke throws and logs until re-login. Fix: only restore when the prototype still holds your wrapper; otherwise leave the chain and make your wrapper a pass-through. Same fix in Accent Hold.

**H4. Engine errors that don't emit `Stopped` leave the client half-open.** `models-missing` and `audio: …` return from `start()` with no `Stopped`: `_session` stays true, the 50 ms watch keeps polling, release → `Stop` → engine no-op. Fix: emit `Stopped('error')` from the engine; `_onError` ends the session if no `Stopped` follows.

**M1. Spacing wrong after a newline block / on GNOME 45.** `getSurroundingText()` returns a 2-tuple on GNOME 45 → `anchor` undefined → `prevChar()` always null → a space is prepended to every block after the first; same on 46+ in apps without surrounding text. "Bonjour nouvelle ligne ça va" → line starts with a space. Track the last committed char in the sink.

**M2. HUD destroyed right after re-show during fade-out.** `show()` cancels the hide timeout but not a running `ease`; pressing the shortcut during the fade → the old ease completes → `_destroyBox()` → no pill for the whole new session. Fix: `remove_all_transitions()` in `show()`.

**M3. Stop/cancel race in the engine tears down the *next* session and leaks pw-record.** `stop()` awaits `gather(...)` then `_finish()` without re-checking `gen`. `Cancel` during the await + new `Start` → the old `stop()` resumes and `_finish('stop')` drops `_source` of the *new* session without stopping it → pw-record keeps the mic open; spurious `Stopped('stop')` ends the new session. Same leak on model-load failure (`_finish('error')` never stops the source). Fix: `_finish` stops the source; `stop()` re-checks `gen` after the gather.

**M4. Preedit loses its first words between 6 s and 8 s of continuous speech.** Partial window 6 s while the VAD cuts at 8 s: the grey text visibly drops its beginning at ~6.7 s, then the final restores it. Make the partial window ≥ `max_speech_s`, or keep a text prefix.

**M5. Opening the panel menu spawns the engine.** `listSources()` without `NO_AUTO_START` activates a Python process that lives 5–10 min; contradicts "Nothing runs when you are not dictating". Use `Gio.DBusCallFlags.NO_AUTO_START` there.

**L1.** `findMonitorForPoint` does not exist on GNOME 45 → pill clamped to the primary monitor. **L2.** `Main.inputMethod._cursorRect` is private and can be stale ("Starting…" drawn at an old location). **L3.** `Level` emitted on every 32 ms chunk (31 signals/s) even when `show-hud` is off; throttle to ~10/s. **L4.** 15 s timeout on `Stop` can expire legitimately (cold load + decode + polish) → "Engine did not answer" then `Stopped` arrives. **L5.** cancelled proxy init logs an error on quick enable/disable. **L6.** `set_preedit_text(text, cursor, anchor, mode)` correct for Mutter 45+; `global.get_pointer()` mask and `ease()` fine 45–50; `Shell.ActionMode.NORMAL` correctly keeps the shortcut out of password dialogs.

## 2. Engine bugs

- `audio.py`: `stderr=DEVNULL`, exit code never checked; pw-record dying (PipeWire restart, bad `--target`) is reported as a normal `Stopped('end-of-audio')`. `stop()` blocks the loop up to 1 s, never `wait()`s after `kill()` (zombie), never closes `stdout`.
- `describe()` runs `pw-dump` synchronously inside `Start` (loop thread, up to 5 s); `ListSources` sync too. Move to the executor.
- polish runs inside the single decode worker → every final blocks partials/finals up to 2.5 s; with Ollama cold the first call always times out.
- `_on_idle` unloads while a cancelled decode may still be on the worker; exit at 2×idle races a concurrent `Start` → `NoReply`.
- `models.py`: HTTPS without checksum, from the *rolling* `asr-models` tag; VAD `.part` left behind on failure; `test_wavs/` (756 kB) kept; Python < 3.12 fallback dead.
- `text.py`: whole-phrase matching inside sentences: "The new line of products" → "The\nof products"; "Il a une nouvelle ligne de vêtements" → "Il a une\nde vêtements"; "à la ligne 12" → "\n12". `test_text.py` has an `or True` dead assertion documenting exactly this. Honour commands only at block boundaries or when the block is only the command.
- `polish.py`: dictated text straight into the prompt; the length guard is the only defence; `polish-url` is a free string so "on this computer" is only true by default. Use a system/user split; reject outputs with new newlines.
- `cli.py`: the service file hard-codes the first `voice-hold-engine` in `PATH`, not the one running `setup`. Prefer `sys.executable -m voice_hold_engine serve`.

## 3. EGO / packaging

- Zip clean; schema conforms; all 59 `_()` msgids present in `fr.po`.
- `shell-version` stops at "50"; GNOME 51 is released — test and add it.
- Description: "Dictate the macOS way" is a trademark reference; reword. Clipboard use in prefs (copy button) must be declared.
- External helper: allowed if the extension only shows the command. Say nothing works without it and that it is a separate GPL project.
- Prototype patching and `_cursorRect`: expect a reviewer question; comment why, guard the restore.
- AI disclosure in README: be ready to answer for every line.
- `pack.sh` msgfmt loop redundant with `--podir`.
- Document `uninstall` and that `pipx reinstall` keeps the service path.

## 4. Security / privacy

- Session bus, no auth: any user process can Start/Stop/Quit and read Final/Partial/Level/Speech; a process squatting the bus name before activation can inject text into the focused field while `_session` is true. Same privilege level as the user; worth one README sentence.
- Nothing written to disk by the engine; subprocess args list-form, safe. Downloads: no checksum.

## 5. Licensing

README must add: Parakeet TDT 0.6B v3 — NVIDIA, CC-BY-4.0 (attribution; downloaded by the user, not redistributed); Silero VAD — MIT (v4+); sherpa-onnx — Apache-2.0, incompatible with GPL-2.0-only: the "or-later" is what makes the engine distributable (GPLv3 terms) — say so; dbus-fast MIT; numpy BSD-3; onnxruntime MIT. `engine/tests/data/cafe.wav` has no stated origin.

## 6. Resources

- 4 threads = all cores during every decode; partials up to 6 s every 0.7 s at RTF ≈ 0.10 → ~60–85 % duty on all cores while speaking; finals queue behind an in-flight partial (+0.6 s). Cap threads at cpus−1, shorten the partial window, or give finals their own worker.
- Measured RSS: 37 MB → 1.09 GB loaded → **682 MB still resident after `unload()`**; `malloc_trim(0)` brings it to 70 MB. "The model leaves memory after 5 minutes" is false for the following 5 minutes. Call `malloc_trim(0)` after unload, or exit at idle.

## 7. Test gaps / dead code

No test of `service.py` with a fake recognizer; none for `audio.py` failures, `sources.py`, `polish.py`, `models.setup`; `TextSink` class, `dictation.js`, `engine.js` untested; `test_engine.py` skipped without models. Dead: `test_text.py` `or True`; `Dictation.active`; `Hud.visible`; `EngineClient.status()`; `dictate` plumbing in the indicator; `models.py` < 3.12 fallback; pack.sh msgfmt loop; `run.sh` promises `engine.log`.

## 8 fixes before publishing

1. `Meta.KeyBindingFlags.IGNORE_AUTOREPEAT`.
2. Watch `g-name-owner`; on owner loss (and on `Error` with no `Stopped`) end the session.
3. `service.py`: `_finish()` stops the source; `stop()` re-checks `gen`; `Start` while active is a D-Bus error; `Stopped('error')` on start failures; report pw-record's exit code.
4. Capture the focus window at `_start()`; refuse commit/partial when focus changed.
5. Guarded prototype restore with inert-wrapper fallback, in both extensions.
6. `TextSink`: remember the last committed character; handle GNOME 45's 2-tuple.
7. `malloc_trim(0)` after unload; throttle `Level`; `NO_AUTO_START` for the panel's `ListSources`; `remove_all_transitions()` in `Hud.show()`.
8. README/metadata: licences, drop "macOS", declare clipboard, SHA-256 pinning, add "51" after testing.
