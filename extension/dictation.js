// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import IBus from 'gi://IBus';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {accelLabel} from './accelLabel.js';
import {EngineClient} from './engine.js';
import {HoldMachine, IDLE, TOGGLE} from './holdMachine.js';
import {Hud} from './hud.js';
import {speechLowMemory} from './memoryText.js';
import {installKeyHook} from './keyHook.js';
import {HistoryWriter} from './history.js';
import {UsageWriter} from './usage.js';
import {VocabLearner, learned} from './vocabLearn.js';
import {MediaPause} from './media.js';
import {cleanupMode} from './modes.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {categoryOf, instructionFor} from './modes.js';
import {Paster} from './paste.js';
import {isTerminal} from './pasteKeys.js';
import {Cues} from './sounds.js';
import {joinBlock, TextSink} from './textSink.js';
import {WakeControl} from './wakeControl.js';

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
//
// A dictation mode other than "as said" (modes.js) also holds the words back:
// at the end the whole text is rewritten by a language model, then written.

const WATCH_MS = 50;
const END_GUARD_MS = 3000;
const START_WAIT_MS = 3000;
// How long the hands-free hint stays before the pill goes back to words only.
const HINT_MS = 2500;
// In hands-free mode, the last seconds before the silence stop are counted.
const COUNTDOWN_MS = 3000;
const SILENCE_TICK_MS = 250;
// A paste this soon after the previous one into the same window follows it.
const PASTE_FOLLOW_MS = 30 * 1000;
// "Paste the last dictation" from the menu waits for the menu to close and
// the focus to go back to the window.
const MENU_PASTE_DELAY_MS = 250;

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
        this._media = new MediaPause(settings, getMixerControl);
        this._paster = new Paster();
        this._history = new HistoryWriter();
        this._usage = new UsageWriter();
        this._followIds = new Set();
        // A word of the last dictation retyped another way joins the
        // vocabulary (vocabLearn.js).
        this._learnFocus = null;
        this._learner = new VocabLearner({
            read: () => Main.inputMethod.getSurroundingText()?.[0] ?? null,
            stillThere: () => !!this._learnFocus && Main.inputMethod.currentFocus === this._learnFocus &&
                global.display.focus_window === this._learnWindow,
            learn: (from, to) => this._learnWord(to),
        });
        this._pasteLastId = 0;
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
            Wake: p => this._onWake(p),
            Whole: t => this._onWhole(t),
            Error: m => this._onError(m),
        });
        this._fromWake = false;      // the next start was asked by the wake word
        this._wake = new WakeControl(settings, this._engine);
        this._watchId = 0;
        this._silenceId = 0;
        this._silenceDeadline = 0;
        this._countdown = 0;         // 1 while the ring runs
        this._hintId = 0;
        this._hint = false;          // a status hint is up, no words yet
        this._handsFreeShown = false;
        this._engineState = '';      // '' | 'loading' | 'listening' for this session
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
        this._learner.stop();
        this._learner = null;
        this._clearFollow();
        this._wake.destroy();
        this._wake = null;
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
        if (this._pasteLastId) {
            GLib.Source.remove(this._pasteLastId);
            this._pasteLastId = 0;
        }
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

    // Entering hands-free mode: how to finish, and the silence timer.
    _afterTransition() {
        if (this._machine.state !== TOGGLE || !this._live || this._handsFreeShown)
            return;
        this._handsFreeShown = true;
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
                this._hud.show('', 'listening');
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
            startedAt: Date.now(),
            endedAt: 0,
            window: global.display.focus_window,
            focus: Main.inputMethod.currentFocus,
            clipboard: !this._sink.available,   // no field: pasted at the end
            text: '',                           // what was said, for pasteLast() and the history
            instruction: this._modeInstruction(global.display.focus_window),
            // The words follow the cursor when the focus moves (_follow()).
            follow: this._settings.get_string('focus-change') === 'follow',
            held: [],                           // blocks waiting for a field
        };
        // Words held back until the end: no field to write into, or a mode.
        // "Accuracy first": the words show grey in the field while you speak,
        // and the whole dictation, decoded again at once, replaces them.
        session.writeAtEnd = !session.clipboard && !session.instruction &&
            this._settings.get_boolean('write-at-end');
        session.buffered = session.clipboard || !!session.instruction || session.writeAtEnd;
        session.whole = '';
        this._learner.stop();
        this._session = session;
        this._engineState = '';
        this._handsFreeShown = false;
        this._clearHint();
        this._sink.begin();
        this._cues.play('start');
        this._media.pause();
        if (this._settings.get_boolean('show-hud')) {
            this._hud.show('', 'listening');
        }
        // What cleans a block after the rules (cleanupMode()).
        const cleanup = cleanupMode(this._settings);
        const options = {
            'silence-stop-s': 0,
            'polish': cleanup !== 'rules',
            'polish-cloud': cleanup === 'cloud',
            'cloud-provider': this._settings.get_string('cloud-provider'),
            'tidy': this._settings.get_boolean('tidy'),
            'corrections': this._settings.get_boolean('corrections'),
            'vocabulary': JSON.stringify(this._settings.get_strv('vocabulary')),
            'replacements': JSON.stringify(this._settings.get_value('replacements').deepUnpack()),
            'keep-loaded-s': this._settings.get_int('keep-loaded-min') * 60,
            'source': this._settings.get_string('microphone'),
            'from-wake': this._fromWake,
            // Words held back anyway: the whole dictation is decoded again at
            // the end, with all its context (Whole signal).
            'whole-pass': session.buffered,
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

    // Where the words go when the focus moves during a dictation
    // (`focus-change`):
    //   follow  the dictation goes on and the words follow the cursor, into
    //           the field focused when each block is ready (Alt+Tab to
    //           another window, a click in another field). A block that
    //           finds no field waits (session.held) for the next one, or is
    //           pasted at the end.
    //   stop    the text only ever goes to the window and field focused at
    //           the start: a focus change cancels, the grey partial is
    //           dropped, blocks already written stay.
    _focusKept() {
        if (!this._session)
            return false;
        if (this._session.follow)
            return true;
        return global.display.focus_window === this._session.window &&
            (this._session.clipboard || this._sink.focused);
    }

    _onFocusWindow() {
        if (!this._live)
            return;
        if (!this._session.follow) {
            if (!this._focusKept())
                this._run(this._machine.external('cancel'));
            return;
        }
        // The new window's field takes the input focus a moment after the
        // window does (and the window switcher holds it meanwhile).
        this._follow();
        for (const ms of [150, 600])
            this._followLater(ms);
    }

    _followLater(ms) {
        const session = this._session;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._followIds.delete(id);
            if (this._session === session && this._live)
                this._follow();
            return GLib.SOURCE_REMOVE;
        });
        this._followIds.add(id);
    }

    _clearFollow() {
        for (const id of this._followIds)
            GLib.Source.remove(id);
        this._followIds.clear();
    }

    // Follow mode: aim at the field focused now, and write there the blocks
    // that were waiting for one. True when a field takes the words.
    _follow(session = this._session) {
        if (!session?.follow)
            return false;
        const win = global.display.focus_window;
        if (session.buffered) {
            session.window = win;
            session.focus = Main.inputMethod.currentFocus;
            return false;                 // written or pasted at the end
        }
        // The input focus is one object for every window: a move shows in
        // the focused window, not in it.
        if (win !== session.window || !this._sink.focused) {
            if (!win || !this._sink.retarget())
                return false;
            session.window = win;
        }
        session.focus = Main.inputMethod.currentFocus;
        while (session.held.length && this._sink.commit(session.held[0]))
            session.held.shift();
        return session.held.length === 0;
    }

    // -- engine events -----------------------------------------------------

    // The engine heard the wake word: a hands-free dictation, as after a tap
    // of the shortcut, on the engine's own listening stream.
    _onWake(_phrase) {
        if (!this._settings.get_boolean('wake-enabled') || this._machine.state !== IDLE ||
            this._session || this._startQueued || this._elsewhere?.())
            return;
        this._fromWake = true;
        this._run(this._machine.wake());
        this._fromWake = false;
    }

    _onOwner(hasOwner) {
        this._wake?.engineOwner(hasOwner);
        if (hasOwner || !this._session)
            return;
        this._hud.error(this._('Engine stopped unexpectedly'));
        this._onStopped('error');
    }

    // The model may still be loading after a few minutes idle
    // (keep-loaded-min). Nothing says so: the pill listens from the first
    // instant, what is said meanwhile is recorded and written once the
    // model is there.
    _onState(state) {
        if (!this._live)
            return;
        if (state === 'loading') {
            this._engineState = 'loading';
        } else if (state === 'listening') {
            this._engineState = 'listening';
            if (!this._hint)
                this._hud.status('', 'listening');
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
        const shown = session.buffered
            ? session.text + joinBlock(this._lastChar(session), text, {firstOfSession: !session.text}) : text;
        if (session.follow) {
            // No field right now (the window switcher is up): the pill
            // alone shows the words, nothing is lost.
            const field = this._follow();
            if (!session.buffered && field) {
                this._sink.partial(text);
            } else if (session.writeAtEnd) {
                if (!this._sink.focused)
                    this._sink.retarget();
                this._sink.partial(shown);
            }
        } else if (!this._focusKept() || (!session.buffered && !this._sink.partial(text)) ||
            (session.writeAtEnd && !this._sink.partial(shown))) {
            this._run(this._machine.external('cancel'));
            return;
        }
        this._clearHint();
        this._hud.live(shown);
    }

    // The last character written in this session ('' before the first block).
    _lastChar(session) {
        return Array.from(session.text).pop() ?? '';
    }

    _onFinal(text) {
        if (!this._session)
            return;
        const session = this._session;
        if (session.follow) {
            // A block that finds no field waits for the next one.
            if (!session.buffered && !(this._follow() && this._sink.commit(text)))
                session.held.push(text);
        } else if (!this._focusKept() || (!session.buffered && !this._sink.commit(text))) {
            // Focus moved: this block goes nowhere rather than elsewhere.
            if (this._live)
                this._run(this._machine.external('cancel'));
            return;
        }
        session.text += joinBlock(this._lastChar(session), text, {firstOfSession: !session.text});
        if (session.writeAtEnd)
            this._sink.partial(session.text);
        this._clearHint();
        this._hud.live(session.buffered ? session.text : text);
    }

    // The whole dictation decoded again at the end (whole-pass): it replaces
    // the blocks where the words were held back.
    _onWhole(text) {
        if (this._session)
            this._session.whole = text;
    }

    _onStopped(reason) {
        const session = this._session;
        if (!session)
            return;
        const wasEnding = session.ending;
        session.endedAt = Date.now();
        this._endSession();
        // The engine stopped on its own (silence, end of audio, error): the
        // gesture machine still thinks we are listening. After our own
        // Stop/Cancel it is already idle, or in the next gesture.
        if (!wasEnding)
            this._run(this._machine.external('engine'));
        const said = session.whole.trim() ? session.whole : session.text;
        const written = reason !== 'cancel' && reason !== 'error' && said.trim() ? said : '';
        if (written && (!session.instruction || session.yielding)) {
            this._last = written;
            this._remember(written, session);
            this._watchCorrections(written, session);
            this._cues.play('stop');
        }
        // Blocks that never found a field: one last try, then the clipboard.
        this._clearFollow();
        let held = '';
        if (written && session.held.length) {
            this._follow(session);
            held = session.held.join(' ');
        }
        if (held && !session.yielding) {
            this._deliver(this._pasteSpacing(held, global.display.focus_window), global.display.focus_window);
        } else if (written && session.buffered && session.yielding) {
            // A voice command takes over: the words held back are not lost,
            // they wait in the clipboard.
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, written);
            this._hud.hideNow();
        } else if (written && session.instruction) {
            this._rewriteAndWrite(written, session);
        } else if (written && session.writeAtEnd) {
            this._writeLate(written, session);
            this._hud.hide();
        } else if (written && session.clipboard) {
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

    // The mode of the application the text goes to: its instruction, or ''.
    _modeInstruction(window) {
        const cat = categoryOf(window?.get_wm_class?.() ?? '', window?.get_title?.() ?? '');
        return instructionFor(this._settings.get_string(`text-mode-${cat}`),
            this._settings.get_string('text-mode-custom'));
    }

    // The text goes to the history when it is kept; the usage only counts
    // its words and the time the dictation took.
    _remember(text, session) {
        this._history.add(text, session.window?.get_wm_class?.() ?? '', this._settings.get_int('history-days'));
        if (this._settings.get_boolean('usage-stats'))
            this._usage.add(text, (session.endedAt - session.startedAt) / 1000);
    }

    // Watch the field the words went to, for a correction of one of them.
    // Not after a mode: what was written is no longer what was recognised.
    _watchCorrections(text, session) {
        this._learner.stop();
        if (!this._settings.get_boolean('vocabulary-learn') || session.instruction || !session.focus)
            return;
        this._learnFocus = session.focus;
        this._learnWindow = session.window;
        this._learner.watch(text);
    }

    _learnWord(word) {
        this._learnFocus = null;
        if (!this._settings)
            return;
        this._settings.set_strv('vocabulary', learned(this._settings.get_strv('vocabulary'), word));
        // Said in the pill, briefly: the Vocabulary page lists and removes.
        if (this._settings.get_boolean('show-hud') && !this._session) {
            this._hud.show(this._('“%s” added to your vocabulary').format(word), 'listening');
            this._hud.hide(2600);
        }
    }

    // The cloud model, when it is switched on and its provider is one the
    // engine can talk to; else null (the local model).
    _cloud() {
        if (!this._settings.get_boolean('cloud-enabled') || this._settings.get_string('cloud-provider') !== 'anthropic')
            return null;
        return {provider: 'anthropic', model: this._settings.get_string('cloud-model')};
    }

    // A new dictation has started meanwhile: what ends late keeps away from
    // its pill and its field.
    get _busyAgain() {
        return !!this._session || this._startQueued;
    }

    // The pill for a status of our own, unless the user turned it off
    // (errors always show).
    _say(text, pseudo, hideMs) {
        if (this._busyAgain || (pseudo !== 'error' && !this._settings.get_boolean('show-hud')))
            return;
        this._hud.show(text, pseudo);
        this._hud.hide(hideMs);
    }

    // A mode: the whole text goes to the language model, and what comes back
    // is written where the dictation started (as said when no model could).
    async _rewriteAndWrite(said, session) {
        if (this._settings.get_boolean('show-hud'))
            this._hud.show(this._('Rewriting…'), 'loading');
        const out = ((await this._engine?.rewrite(said, session.instruction, this._cloud())) || '').trim();
        if (!this._hud)
            return;
        const text = out || said;
        this._last = text;
        this._remember(text, session);
        this._cues.play('stop');
        if (this._busyAgain) {
            // Never into the new dictation's field: the clipboard.
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
            return;
        }
        if (!out)
            this._say(this._('No language model for this mode: written as said'), 'error', 3500);
        if (this._writeLate(text, session) && out)
            this._hud.hide();
    }

    // Write the text of an ended session where it started: into its field if
    // it still has the focus, else by the clipboard. True when typed.
    _writeLate(text, session) {
        const late = new TextSink(Main.inputMethod, Clutter);
        late.begin(session.focus);
        const typed = !session.clipboard && global.display.focus_window === session.window && late.focused;
        if (typed)
            late.commit(text);
        late.destroy();
        if (!typed)
            this._deliver(this._pasteSpacing(text, session.window), session.window);
        return typed;
    }

    // Clipboard, then a virtual paste into `window` when it still has the
    // focus; the pill says which.
    _deliver(text, window) {
        this._paster.deliver(text, window).then(how => {
            if (!this._hud || this._busyAgain)
                return;
            if (how === 'pasted')
                this._hud.hide();
            else
                this._say(this._('Copied — paste it with Ctrl+V'), 'listening', 2500);
        });
    }

    // A pasted text cannot see what is before the cursor: when the previous
    // paste went to the same window a moment ago, the cursor is most likely
    // right after it, and a space separates the two.
    _pasteSpacing(text, window) {
        const prev = this._lastPaste;
        const now = GLib.get_monotonic_time() / 1000;
        const follows = prev && prev.window === window && now - prev.at < PASTE_FOLLOW_MS &&
            !isTerminal(window?.get_wm_class?.() ?? '');
        const out = follows ? joinBlock(prev.char, text) : text;
        this._lastPaste = {window, at: now, char: Array.from(out).pop() ?? ''};
        return out;
    }

    // The menu's "Paste the last dictation" (and its optional shortcut):
    // into the focused field when there is one, else as above.
    // From the menu, `delayed`: once it has closed and given the focus back.
    pasteLast(delayed = false) {
        if (!this._last || this._session)
            return;
        if (delayed) {
            if (this._pasteLastId)
                GLib.Source.remove(this._pasteLastId);
            this._pasteLastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MENU_PASTE_DELAY_MS, () => {
                this._pasteLastId = 0;
                this.pasteLast(false);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
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
