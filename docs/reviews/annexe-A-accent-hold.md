# Annexe A — relecture indépendante d'Accent Hold 2.1 (rapport brut, 3/11/2026)

Rapport d'un agent relecteur sans accès à l'historique du projet, vérifié par
lui contre `inputMethod.js` des branches GNOME Shell 45/46/48/49/50/main,
`layout.js`, `meta-wayland-keyboard.c` de mutter 48/49/main et les règles de
revue de gjs.guide. Chemins relatifs à `~/DEVELOPEMENT/accent-hold/`.

## 1. Real bugs (ranked)

**B1 — "The held letter does not repeat" is only true on GNOME 49/50 with wl_keyboard v10 clients.** `extension/holdMachine.js` only swallows the *compositor-generated* repeats that reach the IM filter. On GNOME 45–48 mutter drops its own synthetic repeats before they reach clients and sends real `repeat_info`; the client repeats on its own timer. Compositor-side repeat exists only from mutter 49 and only for clients binding wl_keyboard ≥ v10; older GTK/Qt/Electron/Firefox builds still self-repeat even on 50. The press is forwarded immediately and the release is never sent while the popup is open, so: hold-ms 400 < repeat delay 500 → popup opens, from 500 ms the client inserts `e` at ~30/s until release → pick `è` → `_replace` removes one char → "eeeeeeè". The ibus/ engine ships an xkb per-key `norepeat` option precisely for this; the extension path has nothing. metadata.json claims 45–50 and README claims no repeat; README says it was only hand-tested on GNOME 50.

**B2 — Popup placement can be off-screen while keys are swallowed.** `pressHold.js` `_place()` clamps x only; `y = rect.y + rect.height + 6` is never clamped. Cursor on the last line of a maximized editor → popup below the monitor, invisible, yet digits/Return/space/arrows are consumed for up to 6 s. Same for `accentPicker.js` (pointer + 24, no clamping, while holding a modal grab). `Main.inputMethod._cursorRect` is never reset on focus-out/reset in any shell version, so after switching to a client that does not report a cursor rect, the popup appears at the previous app's cursor position, possibly on another monitor.

**B3 — Keybinding name `trigger` collides globally.** `extension.js` registers Meta keybinding `'trigger'`. mutter refuses a duplicate name (`Trying to re-add keybinding`) and removes by name. Any other extension using the keybinding name `trigger` either silently kills the Super+E picker or has its own killed, and the other extension's `removeKeybinding('trigger')` unbinds ours while `_bound` stays true. Rename to a namespaced key (`accent-hold-trigger`). `changed::trigger → rebind` is redundant: Meta already tracks the GSettings key.

**B4 — Prototype patch restore is order-dependent; stale wrapper logs an error on every keystroke.** `pressHold.js` unconditionally restores `proto.process_key_event_async` to the value captured at enable; voice-hold does the identical thing. The shell's LIFO disable protects the normal case, but any out-of-order teardown leaves A's wrapper installed with `self._settings === null`; `_filter()` then throws on every key event → `logError` per keystroke. Fix: in `destroy()` only restore if the prototype still holds *your* wrapper; otherwise neutralize your wrapper (pass-through).

**B5 — Space/Return as confirm keys silently insert accents.** A 400 ms pause on `e` followed by space → "thé" instead of "the "; in a chat app Enter sends `é` instead of submitting. Make space/Return dismiss (keep the plain letter, forward the key), or make it configurable.

**B6 — Pressing the held letter again while the popup is open is swallowed.** After hold → release → tap `e` again, the new press has `keyval === this.held` and is consumed. User wanting "ee" gets nothing and the popup stays open.

**B7 — Clipboard trick in the shortcut picker destroys non-text clipboards and can paste the old clipboard into the field.** `get_text` returns null for images/files → after 300 ms `set_text(CLIPBOARD, '')` wipes it. PRIMARY is overwritten and never restored. If the app processes the synthesized Shift+Insert after the 300 ms timer (slow Electron app, heavy load) it pastes the *restored* previous clipboard — e.g. a password. If `destroy()` runs inside that window the clipboard is left holding `é`.

**B8 — `_commitId` fires into whatever is focused.** BackSpace is forwarded now, `commit(text)` 120 ms later; `_cancel()` (focus change) does not remove `_commitId`, so an Alt-Tab inside the window commits the accent into the new window. On GNOME 45 this path is *always* taken: `getSurroundingText()` returns `[text, cursor]` only (anchor added in 46), so `cursor !== anchor` is always true and `delete_surrounding` is never used on 45.

**B9 — Table override is only validated as JSON.** `{"e": {"length": 1}}` arms then `holdElapsed()` throws inside the GLib timeout → machine stuck ARMED with presses consumed until release; non-string candidates reach `im.commit()`.

**B10 — Capturing a bare letter as the shortcut hijacks that letter system-wide.** `Gtk.accelerator_valid('e', 0)` is TRUE, so pressing `e` in the capture sets `trigger = ['e']` → every `e` opens the picker. Unparsable text is stored verbatim. Require a modifier (or a function key) and reject parse failures.

Minor: `disable()` dereferences `this._pressHold` without a guard; prefs leaves `saveTimer` running when the window closes within 600 ms; `_active()` does `get_strv('layouts')` on every press *and* release; unmatched key releases are forwarded after `_choose`/Escape.

## 2. Review-guideline exposure

- Prototype patching of a GI class: the single thing a reviewer will ask about; at minimum unpatch when `press-and-hold` is off.
- Private shell member `Main.inputMethod._cursorRect`; `getSurroundingText()` arity changed between 45 and 46; `Main.layoutManager.findMonitorForPoint?.()` does not exist on 45 → wrong x on a secondary monitor; the `?.` hides a version split.
- Clipboard: declared in metadata, but B7 is what EGO-A-005 reviewers push back on; `docs/ego-review-reply.md` promises restoration that is not reliable.
- Virtual input device created in a constructor and never disposed: acceptable, reviewers usually ask for lazy creation and disposal in `destroy()`.
- "Extensions must not be AI-generated" vs README ("wrote most of the code") and the committed `docs/ego-review-reply.md`; keep the disclosure factual and make sure every line is explainable.
- metadata.json well-formed; description overlong. Schema: generic key names; `enabled` toggles only the *shortcut*, not press-and-hold; `layouts` also gates press-and-hold undocumented; `delay-ms` applies only to the picker, undocumented.
- Zip contents: 17 entries, nothing unnecessary. Repo-side dead weight: tracked `.mo`, `legacy/daemon/target/**` fingerprint files, `tools/*` referencing the dead daemon (`imports.byteArray`).
- No Gtk in the shell process, no deprecated modules, no spawning — clean.

## 3. UX / correctness of press-and-hold

- Dead keys: holding `e` after `dead_acute` arms on `e` but the client holds `é`; BackSpace path replaces the composed char — acceptable but undocumented.
- `ISO_Level5_Shift` layouts not in `SHORTCUT_MASK`.
- Numpad with NumLock off produces `KP_Left` etc., not in `NAV_KEYS` → dismisses instead of navigating.
- Terminals / apps without surrounding text: always the BackSpace path; wrong in a TUI in normal mode (vim). Consider skipping replacement when surrounding text is unavailable, or document.
- Qt usually routes through its own IBus client, bypassing the shell IM; "most Qt apps" unverified. Electron needs the Wayland backend; XWayland apps out.
- The two popups behave differently (clamping vs wrapping, Up/Down/Tab, placement); three separate modifier lists.
- Hard-coded dark colors ignore light theme/high contrast.

## 4. Tests and dead code

5 test cases. Missing: Escape, Tab/ISO_Left_Tab, keypad digits, digit ≥ candidates, wrap-around, `cancel()` from each state, `holdElapsed()` when not ARMED, `candidateClicked` bounds, modifier press while ARMED/OPEN, rollover, same-letter re-press while OPEN, Ctrl+digit while OPEN, >9 candidates, non-array table entries, compositor repeats while ARMED. Nothing covers `_key()` or `_canDeleteBeforeCursor`. No CI. Legacy `imports.system` inside an ES module. Dead: exported constants, unused param, `tools/*`, tracked `.mo` and `target/`; `ibus/engine.py` parses `defaultAccents.js` as data.

## 5. README / metadata overpromises

"The held letter does not repeat" (49/50 + v10 clients only); "GNOME 45 to 50" tested only on 50; "popup next to the text cursor" only for clients reporting a rect; "with the mouse" Wayland only; "GTK, most Qt apps, terminals" partly unverified; "restores your previous clipboard content" text-only, never PRIMARY, racy; the headless harness is not in the repo.

## Five fixes first

1. Key repeat (B1): send the release to the client when the popup opens / delete the actual count of inserted letters, or require the per-key xkb norepeat and state the GNOME 49+ / v10 requirement honestly.
2. Namespace the keybinding and settings key, drop the redundant rebind, restore the prototype only if still owned (B3, B4).
3. Clamp y and multi-monitor for both popups, reset the cursor-rect fallback on focus change (B2).
4. Space/Return dismiss instead of confirm; re-press of the held letter after release is a new key (B5, B6).
5. Validate the table shape, require a modifier in the shortcut capture, reject unparsable accelerators (B9, B10); add the missing tests.
