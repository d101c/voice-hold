// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import IBus from 'gi://IBus';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {accelLabel} from './accelLabel.js';
import {EngineClient} from './engine.js';
import {HoldMachine, IDLE, TOGGLE} from './holdMachine.js';
import {Hud} from './hud.js';
import {speechLowMemory} from './memoryText.js';
import {installKeyHook} from './keyHook.js';
import {MediaPause} from './media.js';
import {Paster} from './paste.js';
import {Cues} from './sounds.js';
import {joinBlock, TextSink} from './textSink.js';

// Glue between the gesture (holdMachine), the engine (D-Bus), the text field
// (textSink) and the pill (hud).
//
// A session lives from Start until the engine's `Stopped`. After Stop or
// Cancel it is "ending": the gesture machine is already idle, but the last
// block may still be decoding, so Final is still accepted and the sink is
// not reset. If the engine never answers (process died, Error without
// Stopped, Stop acknowledged but no Stopped within END_GUARD_MS) the session
// is ended locally: preedit cleared, pill hidden, timers stopped.
//
// No text field takes input-method text (many Electron and X11 apps, or no
// window at all): the dictation goes on, the words show in the pill only,
// and at the end the whole text goes to the clipboard and is pasted into the
// window that had the focus (paste.js).

const WATCH_MS = 50;
const END_GUARD_MS = 3000;
const START_WAIT_MS = 3000;
// Until a load has been timed in this session of the Shell.
const DEFAULT_LOAD_MS = 5000;
// How long the hands-free hint stays before the pill goes back to words only.
const HINT_MS = 2500;
// In hands-free mode, the last seconds before the silence stop are counted.
const COUNTDOWN_MS = 3000;
const SILENCE_TICK_MS = 250;
// A paste this soon after the previous one into the same window follows it.
const PASTE_FOLLOW_MS = 5 * 60 * 1000;

// Engine errors after which no further signal is to be expected.
const FATAL_ERRORS = ['models-missing', 'low-memory:', 'audio:', 'model:'];

// Modifier masks named in an accelerator string such as '<Control>space'.
export function modifierMask(accel) {
    let mask = 0;
    const s = accel.toLowerCase();
    if (s.includes('<super>') || s.includes('<mod4>'))
        mask |= Clutter.ModifierType.MOD4_MASK;
    if (s.includes('<control>') || s.includes('<ctrl>') || s.includes('<primary>'))
        mask |= Clutter.ModifierType.CONTROL_MASK;
    if (s.includes('<alt>') || s.includes('<mod1>'))
        mask |= Clutter.ModifierType.MOD1_MASK;
    if (s.includes('<shift>'))
        mask |= Clutter.ModifierType.SHIFT_MASK;
    return mask;
}

export class Dictation {
    constructor(settings, gettext, openSetup = null, dir = '.') {
        this._settings = settings;
        this._cues = new Cues(dir, settings);
        this._media = new MediaPause(settings);
        this._paster = new Paster();
        this._last = '';             // the text of the last dictation, see pasteLast()
        this._lastPaste = null;      // {window, at, char}: the last text pasted at the end of a dictation
        this._openSetup = openSetup;
        this._ = gettext;
        this._machine = new HoldMachine(this._machineOptions());
        this._hud = new Hud(this._, () => settings.get_string('hud-position'),
            () => settings.get_string('hud-effect'));
        // The preferences' Preview button: show the pill once, as it would
        // look while listening.
        settings.connectObject('changed::hud-preview', () => this._preview(), this);
        this._sink = new TextSink(Main.inputMethod, Clutter);
        this._engine = new EngineClient({
            Owner: has => this._onOwner(has),
            State: s => this._onState(s),
            Level: v => this._hud.level(v),
            Speech: b => this._onSpeech(b),
            Partial: t => this._onPartial(t),
            Final: t => this._onFinal(t),
            Stopped: r => this._onStopped(r),
            Error: m => this._onError(m),
        });
        this._watchId = 0;
        this._silenceId = 0;
        this._silenceDeadline = 0;
        this._countdown = 0;         // 1 while the ring runs
        this._hintId = 0;
        this._hint = false;          // a status hint is up, no words yet
        this._handsFreeShown = false;
        this._engineState = '';      // '' | 'loading' | 'listening' for this session
        this._loadStartedAt = 0;
        this._loadMs = DEFAULT_LOAD_MS;
        this._guardId = 0;
        this._startWaitId = 0;
        this._mask = modifierMask(settings.get_strv('dictation-shortcut')[0] ?? '');
        this._session = null;        // {ending, window, focus}
        this._startQueued = false;
        this._elsewhere = null;      // see setElsewhere()
        this._onIdle = null;         // see setOnIdle()

        settings.connectObject(
            'changed::mode', () => this._reconfigure(),
            'changed::tap-ms', () => this._reconfigure(),
            'changed::dictation-shortcut', () => this._reconfigure(),
            this);
        global.display.connectObject('notify::focus-window', () => this._onFocusWindow(), this);
        this._keyHook = installKeyHook(IBus.InputContext.prototype, (keyval, state) => this._filterKey(keyval, state));
    }

    destroy() {
        this._run(this._machine.external('cancel'));
        this._dropQueuedStart();
        this._endSession();
        this._keyHook.uninstall();
        this._keyHook = null;
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._stopWatch();
        this._engine.destroy();
        this._engine = null;
        this._sink.destroy();
        this._sink = null;
        this._paster.destroy();
        this._paster = null;
        this._hud.destroy();
        this._hud = null;
        this._settings = null;
    }

    _machineOptions() {
        return {
            mode: this._settings.get_string('mode'),
            tapMs: this._settings.get_int('tap-ms'),
        };
    }

    _reconfigure() {
        const o = this._machineOptions();
        this._machine.mode = o.mode;
        this._machine.tapMs = o.tapMs;
        this._mask = modifierMask(this._settings.get_strv('dictation-shortcut')[0] ?? '');
    }

    // -- entry points ------------------------------------------------------

    // `beforeStart` runs when this press starts a dictation (not when it
    // stops one, nor when there is no text field): the voice commands give
    // way then (extension.js).
    shortcut(beforeStart = null) {
        if (this._machine.state === IDLE)
            beforeStart?.();
        this._run(this._machine.shortcut(GLib.get_monotonic_time() / 1000));
    }

    // The microphone is ours, or about to be.
    get usesVoice() {
        return !!this._session || this._startQueued;
    }

    // The command shortcut was pressed: finish (the last block is still
    // written), or drop a start that was waiting.
    yieldTo() {
        if (this._machine.state === IDLE && this._startQueued && !this._session) {
            this._dropQueuedStart();
            this._hud.hide(0);
            return;
        }
        if (this._live)
            this._session.yielding = true;
        this._run(this._machine.external('stop'));
    }

    // Called once a session is over: the commands may start.
    setOnIdle(fn) {
        this._onIdle = fn;
    }

    // The commands let go of the microphone: a start that waited for them
    // goes ahead.
    kick() {
        if (this._startQueued && !this._session && !this._elsewhere?.())
            this._startNow();
    }

    // A session that is listening (not ending).
    get _live() {
        return !!this._session && !this._session.ending;
    }

    _preview() {
        if (this.active || this._hud.visible)
            return;
        this._hud.show(this._('Listening…'), 'listening');
        this._hud.hide(1800);
    }

    // Dictating, or finishing a dictation: the voice commands, when they
    // are switched on, leave the microphone alone meanwhile (extension.js).
    get active() {
        return this._machine.state !== IDLE || !!this._session || this._startQueued;
    }

    // `fn()` is true while someone else is using the speech engine (the
    // voice commands): the engine sends its signals to every client, and an
    // error of theirs is theirs to show. Never set unless the commands are
    // switched on.
    setElsewhere(fn) {
        this._elsewhere = fn;
    }

    // -- actions -----------------------------------------------------------

    _run(actions) {
        for (const [kind] of actions) {
            if (kind === 'start')
                this._start();
            else if (kind === 'stop')
                this._stop();
            else if (kind === 'cancel')
                this._cancel();
            else if (kind === 'watch')
                this._startWatch();
            else if (kind === 'unwatch')
                this._stopWatch();
        }
        this._afterTransition();
    }

    // Entering hands-free mode: the lock, how to finish (once the model
    // is there: a loading pill keeps its hint and bar), and the silence
    // timer.
    _afterTransition() {
        if (this._machine.state !== TOGGLE || !this._live || this._handsFreeShown)
            return;
        this._handsFreeShown = true;
        if (this._engineState !== 'loading')
            this._showHint(this._handsFreeHint(), 'listening');
        this._armSilence();
    }

    _handsFreeHint() {
        const accel = accelLabel(this._settings.get_strv('dictation-shortcut')[0] ?? '', this._);
        return this._('Hands-free — %s to finish').format(accel);
    }

    // A hint in the pill until the first words, or HINT_MS.
    _showHint(text, pseudo) {
        this._clearHint();
        this._hud.status(text, pseudo);
        this._hint = true;
        this._hintId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HINT_MS, () => {
            this._hintId = 0;
            if (this._hint && this._live && !this._countdown)
                this._hud.status('', 'listening');
            this._hint = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearHint() {
        this._hint = false;
        if (this._hintId) {
            GLib.Source.remove(this._hintId);
            this._hintId = 0;
        }
    }

    _start() {
        if (!this._session && this._elsewhere?.()) {
            // A voice command is giving the microphone back (yieldTo):
            // kick() starts this one then. Shown at once, so the press
            // is seen to have worked.
            this._startQueued = true;
            if (this._settings.get_boolean('show-hud'))
                this._hud.show(this._('Starting…'), 'loading');
            this._armStartWait();
            return;
        }
        if (this._session) {
            // The previous session is still ending: wait for its Stopped so
            // its last block lands before the sink is reset, at most
            // START_WAIT_MS, then end it locally and go on.
            this._startQueued = true;
            this._armStartWait();
            return;
        }
        this._startNow();
    }

    _armStartWait() {
        if (this._startWaitId)
            return;
        this._startWaitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, START_WAIT_MS, () => {
            this._startWaitId = 0;
            if (this._session)
                this._onStopped('error');
            else if (this._startQueued)
                this._startNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startNow() {
        this._dropQueuedStart();
        const session = {
            ending: false,
            window: global.display.focus_window,
            focus: Main.inputMethod.currentFocus,
            clipboard: !this._sink.available,   // no field: pasted at the end
            text: '',                           // what was written, for pasteLast()
        };
        this._session = session;
        this._engineState = '';
        this._handsFreeShown = false;
        this._clearHint();
        this._sink.begin();
        this._cues.play('start');
        this._media.pause();
        if (this._settings.get_boolean('show-hud')) {
            this._hud.show(this._('Starting…'), 'loading');
        }
        const options = {
            'silence-stop-s': 0,
            'polish': this._settings.get_boolean('polish'),
            'tidy': this._settings.get_boolean('tidy'),
            'corrections': this._settings.get_boolean('corrections'),
            'vocabulary': JSON.stringify(this._settings.get_strv('vocabulary')),
            'replacements': JSON.stringify(this._settings.get_value('replacements').deepUnpack()),
            'keep-loaded-s': this._settings.get_int('keep-loaded-min') * 60,
            'source': this._settings.get_string('microphone'),
        };
        this._engine.start(options).then(err => {
            if (!err || this._session !== session || session.ending)
                return;
            // Nothing started on the engine side: end here, no Stopped will come.
            this._run(this._machine.external('engine'));
            this._endSession();
            this._showEngineError(err);
        });
        this._afterTransition();
    }

    _stop() {
        if (this._startQueued) {
            // Never started (its own session still ending, or a voice
            // command still giving the microphone back): nothing to stop.
            this._dropQueuedStart();
            if (!this._session)
                this._hud.hide(0);
            return;
        }
        const session = this._session;
        if (!session || session.ending)
            return;
        session.ending = true;
        this._stopSilence();
        this._cancelGuard();              // the answer to Stop arms it again
        this._hud.pending();
        this._engine.stop().then(err => {
            if (this._session !== session)
                return;                   // Stopped already arrived
            if (err) {
                this._showEngineError(err);
                this._onStopped('error');
                return;
            }
            this._armGuard(session);
        });
    }

    _cancel() {
        if (this._startQueued) {
            // Never started (its own session still ending, or a voice
            // command still giving the microphone back): nothing to stop.
            this._dropQueuedStart();
            if (!this._session)
                this._hud.hide(0);
            return;
        }
        const session = this._session;
        if (!session)
            return;
        this._stopSilence();
        this._sink.end();
        this._hud.hide(0);
        if (session.ending)
            return;                       // Stop is on its way; let it finish
        session.ending = true;
        this._engine.cancel().then(err => {
            if (this._session !== session)
                return;
            if (err)
                this._onStopped('cancel');
            else
                this._armGuard(session);
        });
    }

    _dropQueuedStart() {
        this._startQueued = false;
        if (this._startWaitId) {
            GLib.Source.remove(this._startWaitId);
            this._startWaitId = 0;
        }
    }

    // -- session end ---------------------------------------------------------

    // Forget the session locally: preedit cleared, timers stopped.
    _endSession() {
        this._cancelGuard();
        this._stopSilence();
        this._clearHint();
        this._engineState = '';
        const had = !!this._session;
        this._session = null;
        this._sink.end();
        if (had)
            this._media.resume();
        if (had && !this._startQueued)
            this._onIdle?.();
    }

    _armGuard(session) {
        this._cancelGuard();
        this._guardId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, END_GUARD_MS, () => {
            this._guardId = 0;
            if (this._session === session) {
                console.warn('voice-hold: no Stopped from the engine, ending the session locally');
                this._onStopped('error');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelGuard() {
        if (this._guardId) {
            GLib.Source.remove(this._guardId);
            this._guardId = 0;
        }
    }

    // -- modifier polling (hold mode) --------------------------------------

    _startWatch() {
        this._stopWatch();
        if (!this._mask) {
            // No modifier to watch (e.g. a function key): behave as a tap.
            this._run(this._machine.modifier(GLib.get_monotonic_time() / 1000, false));
            return;
        }
        this._watchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCH_MS, () => {
            const [, , mods] = global.get_pointer();
            // Every modifier of the shortcut: with two of them, letting go
            // of one is letting go.
            const held = (mods & this._mask) === this._mask;
            this._run(this._machine.modifier(GLib.get_monotonic_time() / 1000, held));
            if (!this._watchId)
                return GLib.SOURCE_REMOVE;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopWatch() {
        if (this._watchId) {
            GLib.Source.remove(this._watchId);
            this._watchId = 0;
        }
    }

    // -- silence timer (toggle mode) ---------------------------------------

    // In the last COUNTDOWN_MS a ring empties in the pill, so the stop
    // never comes as a surprise; speaking again takes it away.
    _armSilence() {
        this._stopSilence();
        const s = this._settings.get_double('silence-stop-s');
        // Not before the model is there: what is said while it loads is
        // not silence, it just cannot be heard yet.
        if (s <= 0 || this._machine.state !== TOGGLE || this._engineState !== 'listening')
            return;
        this._silenceDeadline = GLib.get_monotonic_time() / 1000 + s * 1000;
        this._silenceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SILENCE_TICK_MS, () => {
            const left = this._silenceDeadline - GLib.get_monotonic_time() / 1000;
            if (left <= 0) {
                this._silenceId = 0;
                this._countdown = 0;
                this._run(this._machine.external('silence'));
                return GLib.SOURCE_REMOVE;
            }
            if (left <= COUNTDOWN_MS && !this._countdown) {
                this._countdown = 1;
                this._hud.countdown(left);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopSilence() {
        if (this._silenceId) {
            GLib.Source.remove(this._silenceId);
            this._silenceId = 0;
        }
        if (this._countdown) {
            this._countdown = 0;
            this._hud.stopCountdown();
        }
    }

    // -- focus ---------------------------------------------------------------

    // The dictated text only ever goes to the window and field focused at
    // start. A focus change cancels: the grey partial is dropped, blocks
    // already committed stay.
    _focusKept() {
        return !!this._session &&
            global.display.focus_window === this._session.window &&
            (this._session.clipboard || this._sink.focused);
    }

    _onFocusWindow() {
        if (this._live && !this._focusKept())
            this._run(this._machine.external('cancel'));
    }

    // -- engine events -----------------------------------------------------

    _onOwner(hasOwner) {
        if (hasOwner || !this._session)
            return;
        this._hud.error(this._('Engine stopped unexpectedly'));
        this._onStopped('error');
    }

    // The model loads after a few minutes idle (keep-loaded-min): a bar
    // that fills over the last load's time, then a clear "ready". What is
    // said meanwhile is recorded and transcribed once the model is there.
    _onState(state) {
        if (!this._live)
            return;
        const now = GLib.get_monotonic_time() / 1000;
        if (state === 'loading') {
            this._engineState = 'loading';
            this._loadStartedAt = now;
            this._hud.loading(this._('Loading the model… speak, nothing is lost'), this._loadMs);
        } else if (state === 'listening') {
            const wasLoading = this._engineState === 'loading';
            this._engineState = 'listening';
            if (wasLoading) {
                this._loadMs = Math.round(now - this._loadStartedAt);
                this._hud.ready('');
                this._showHint(this._machine.state === TOGGLE ? this._handsFreeHint() : this._('Ready'),
                    'listening');
            } else if (!this._hint) {
                this._hud.status('', 'listening');
            }
            this._armSilence();
        } else if (state === 'decoding') {
            this._hud.pending();
        }
    }

    _onSpeech(speaking) {
        if (!this._live)
            return;
        if (speaking)
            this._stopSilence();
        else
            this._armSilence();
    }

    _onPartial(text) {
        if (!this._live)
            return;
        const session = this._session;
        if (!this._focusKept() || (!session.clipboard && !this._sink.partial(text))) {
            this._run(this._machine.external('cancel'));
            return;
        }
        this._clearHint();
        this._hud.live(session.clipboard ? joinBlock(this._lastChar(session), text, {firstOfSession: !session.text}) : text);
    }

    // The last character written in this session ('' before the first block).
    _lastChar(session) {
        return Array.from(session.text).pop() ?? '';
    }

    _onFinal(text) {
        if (!this._session)
            return;
        const session = this._session;
        if (!this._focusKept() || (!session.clipboard && !this._sink.commit(text))) {
            // Focus moved: this block goes nowhere rather than elsewhere.
            if (this._live)
                this._run(this._machine.external('cancel'));
            return;
        }
        session.text += joinBlock(this._lastChar(session), text, {firstOfSession: !session.text});
        this._clearHint();
        this._hud.live(session.clipboard ? session.text : text);
    }

    _onStopped(reason) {
        const session = this._session;
        if (!session)
            return;
        const wasEnding = session.ending;
        this._endSession();
        // The engine stopped on its own (silence, end of audio, error): the
        // gesture machine still thinks we are listening. After our own
        // Stop/Cancel it is already idle, or in the next gesture.
        if (!wasEnding)
            this._run(this._machine.external('engine'));
        const written = reason !== 'cancel' && reason !== 'error' && session.text.trim() ? session.text : '';
        if (written) {
            this._last = written;
            this._cues.play('stop');
        }
        if (written && session.clipboard && !session.yielding) {
            this._deliver(this._pasteSpacing(written, session.window), session.window);
        } else if (reason === 'error') {
            this._hud.hide(2500);
        } else if (session.yielding) {
            this._hud.hideNow();          // the command's pill takes its place
        } else {
            this._hud.hide();
        }
        if (this._startQueued)
            this._startNow();
    }

    // Clipboard, then a virtual paste into `window` when it still has the
    // focus; the pill says which.
    _deliver(text, window) {
        this._paster.deliver(text, window).then(how => {
            if (!this._hud)
                return;
            if (how === 'pasted') {
                this._hud.hide();
            } else if (!this._session) {
                this._hud.show(this._('Copied — paste it with Ctrl+V'), 'listening');
                this._hud.hide(2500);
            }
        });
    }

    // A pasted text cannot see what is before the cursor: when the previous
    // paste went to the same window a moment ago, the cursor is most likely
    // right after it, and a space separates the two.
    _pasteSpacing(text, window) {
        const prev = this._lastPaste;
        const now = GLib.get_monotonic_time() / 1000;
        const out = prev && prev.window === window && now - prev.at < PASTE_FOLLOW_MS
            ? joinBlock(prev.char, text) : text;
        this._lastPaste = {window, at: now, char: Array.from(out).pop() ?? ''};
        return out;
    }

    // The menu's "Paste the last dictation" (and its optional shortcut):
    // into the focused field when there is one, else as above.
    pasteLast() {
        if (!this._last || this._session)
            return;
        if (this._sink.available) {
            this._sink.begin();
            this._sink.commit(this._last);
            this._sink.end();
        } else {
            this._deliver(this._last, global.display.focus_window);
        }
    }

    get hasLast() {
        return !!this._last;
    }

    _onError(message) {
        if (!this._session && this._elsewhere?.())
            return;
        const fatal = FATAL_ERRORS.some(p => message.startsWith(p));
        const lowMemory = speechLowMemory(message, this._);
        if (message === 'models-missing') {
            this._showEngineError('models-missing');
        } else if (lowMemory) {
            // No room to load the speech model: the engine refused rather
            // than freeze the desktop. Left on screen long enough to read.
            this._hud.error(lowMemory);
            this._hud.hide(7000);
        } else if (!fatal && this._live && this._hud.visible) {
            // One block failed, the dictation goes on: say so in the pill
            // without closing it under a session that is still listening.
            this._hud.status(message, 'error');
        } else {
            this._hud.error(message.startsWith('audio') ? this._('Microphone unavailable') : message);
        }
        // The engine sends Stopped('error') after these; an older engine does
        // not, so end the session ourselves if nothing follows. Not while a
        // Stop or Cancel is in flight: its answer arms the guard, and the
        // last block may take longer than the guard to decode.
        if (this._session && !this._session.ending && fatal)
            this._armGuard(this._session);
    }

    _showEngineError(code) {
        const texts = {
            'not-installed': this._('Speech engine not installed yet — opening the installer'),
            'spawn-failed': this._('Engine failed to start — see the extension settings'),
            'models-missing': this._('Speech models missing — opening the installer'),
            'timeout': this._('Engine did not answer'),
            'busy': this._('Engine busy — try again'),
            'no-proxy': this._('D-Bus unavailable'),
        };
        if (code === 'cancelled')
            return;
        this._hud.error(texts[code] ?? code);
        // Nothing can be dictated until the engine is there: take the user to
        // the Installation page instead of leaving them to look for it.
        if (code === 'not-installed' || code === 'models-missing')
            this._openSetup?.();
    }

    // -- Escape inside text fields ---------------------------------------------
    //
    // Keys typed into a text field go through IBus.InputContext.
    // process_key_event_async (see keyHook.js). While dictating we swallow
    // Escape (cancel) there; everything else goes through untouched.

    _filterKey(keyval, state) {
        if (!this._machine || this._machine.state === IDLE)
            return false;
        if (keyval !== Clutter.KEY_Escape)
            return false;
        if ((state & IBus.ModifierType.RELEASE_MASK) === 0)
            this._run(this._machine.escape());
        return true;
    }
}
