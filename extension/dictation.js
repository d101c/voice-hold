import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import IBus from 'gi://IBus';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {EngineClient} from './engine.js';
import {HoldMachine, IDLE, TOGGLE} from './holdMachine.js';
import {Hud} from './hud.js';
import {installKeyHook} from './keyHook.js';
import {TextSink} from './textSink.js';

// Glue between the gesture (holdMachine), the engine (D-Bus), the text field
// (textSink) and the pill (hud).
//
// A session lives from Start until the engine's `Stopped`. After Stop or
// Cancel it is "ending": the gesture machine is already idle, but the last
// block may still be decoding, so Final is still accepted and the sink is
// not reset. If the engine never answers (process died, Error without
// Stopped, Stop acknowledged but no Stopped within END_GUARD_MS) the session
// is ended locally: preedit cleared, pill hidden, timers stopped.

const WATCH_MS = 50;
const END_GUARD_MS = 3000;
const START_WAIT_MS = 3000;

// Engine errors after which no further signal is to be expected.
const FATAL_ERRORS = ['models-missing', 'audio:', 'model:'];

// Modifier masks named in an accelerator string such as '<Super>r'.
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
    constructor(settings, iconPath, gettext) {
        this._settings = settings;
        this._ = gettext || (s => s);
        this._machine = new HoldMachine(this._machineOptions());
        this._hud = new Hud(iconPath, this._);
        this._sink = new TextSink(Main.inputMethod, Clutter);
        this._engine = new EngineClient({
            Owner: has => this._onOwner(has),
            State: s => this._onState(s),
            Source: d => this._onSource(d),
            Level: v => this._hud.level(v),
            Speech: b => this._onSpeech(b),
            Partial: t => this._onPartial(t),
            Final: t => this._onFinal(t),
            Stopped: r => this._onStopped(r),
            Error: m => this._onError(m),
        });
        this._watchId = 0;
        this._silenceId = 0;
        this._guardId = 0;
        this._startWaitId = 0;
        this._mask = modifierMask(settings.get_strv('dictation-shortcut')[0] ?? '');
        this._session = null;        // {ending, window, focus}
        this._startQueued = false;
        this._mic = '';

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

    shortcut() {
        if (this._machine.state === IDLE && !this._sink.available) {
            this._hud.show(this._('Click in a text field first'), 'error');
            this._hud.hide(1800);
            return;
        }
        this._run(this._machine.shortcut(GLib.get_monotonic_time() / 1000));
    }

    // A session that is listening (not ending).
    get _live() {
        return !!this._session && !this._session.ending;
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

    // Entering hands-free mode: say so, and arm the silence timer.
    _afterTransition() {
        if (this._machine.state === TOGGLE && this._live) {
            this._hud.status(this._listeningHint(), 'listening');
            this._armSilence();
        }
    }

    _start() {
        if (this._session) {
            // The previous session is still ending: wait for its Stopped so
            // its last block lands before the sink is reset, at most
            // START_WAIT_MS, then end it locally and go on.
            this._startQueued = true;
            if (!this._startWaitId) {
                this._startWaitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, START_WAIT_MS, () => {
                    this._startWaitId = 0;
                    if (this._session)
                        this._finishLocally('error');
                    else if (this._startQueued)
                        this._startNow();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        this._startNow();
    }

    _startNow() {
        this._dropQueuedStart();
        const session = {
            ending: false,
            window: global.display.focus_window,
            focus: Main.inputMethod.currentFocus,
        };
        this._session = session;
        this._sink.begin();
        if (this._settings.get_boolean('show-hud'))
            this._hud.show(this._('Starting…'), 'listening');
        const options = {
            'silence-stop-s': 0,
            'polish': this._settings.get_boolean('polish'),
            'polish-model': this._settings.get_string('polish-model'),
            'polish-url': this._settings.get_string('polish-url'),
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
            this._dropQueuedStart();      // never started: nothing to stop
            return;
        }
        const session = this._session;
        if (!session || session.ending)
            return;
        session.ending = true;
        this._stopSilence();
        this._hud.status(this._('…'), 'listening');
        this._engine.stop().then(err => {
            if (this._session !== session)
                return;                   // Stopped already arrived
            if (err) {
                this._showEngineError(err);
                this._finishLocally('error');
                return;
            }
            this._armGuard(session);
        });
    }

    _cancel() {
        if (this._startQueued) {
            this._dropQueuedStart();
            return;
        }
        const session = this._session;
        if (!session)
            return;
        this._stopSilence();
        this._sink.end();
        this._hud.hideNow();
        if (session.ending)
            return;                       // Stop is on its way; let it finish
        session.ending = true;
        this._engine.cancel().then(err => {
            if (this._session !== session)
                return;
            if (err)
                this._finishLocally('cancel');
            else
                this._armGuard(session);
        });
    }

    _dropQueuedStart() {
        this._startQueued = false;
        if (this._startWaitId) {
            GLib.source_remove(this._startWaitId);
            this._startWaitId = 0;
        }
    }

    // -- session end ---------------------------------------------------------

    // Forget the session locally: preedit cleared, timers stopped.
    _endSession() {
        this._cancelGuard();
        this._stopSilence();
        this._session = null;
        this._sink.end();
    }

    _armGuard(session) {
        this._cancelGuard();
        this._guardId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, END_GUARD_MS, () => {
            this._guardId = 0;
            if (this._session === session) {
                console.warn('voice-hold: no Stopped from the engine, ending the session locally');
                this._finishLocally('error');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelGuard() {
        if (this._guardId) {
            GLib.source_remove(this._guardId);
            this._guardId = 0;
        }
    }

    _finishLocally(reason) {
        this._onStopped(reason);
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
            const held = (mods & this._mask) !== 0;
            this._run(this._machine.modifier(GLib.get_monotonic_time() / 1000, held));
            if (!this._watchId)
                return GLib.SOURCE_REMOVE;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopWatch() {
        if (this._watchId) {
            GLib.source_remove(this._watchId);
            this._watchId = 0;
        }
    }

    // -- silence timer (toggle mode) ---------------------------------------

    _armSilence() {
        this._stopSilence();
        const s = this._settings.get_double('silence-stop-s');
        if (s <= 0 || this._machine.state !== TOGGLE)
            return;
        this._silenceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(s * 1000), () => {
            this._silenceId = 0;
            this._run(this._machine.external('silence'));
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopSilence() {
        if (this._silenceId) {
            GLib.source_remove(this._silenceId);
            this._silenceId = 0;
        }
    }

    // -- focus ---------------------------------------------------------------

    // The dictated text only ever goes to the window and field focused at
    // start. A focus change cancels: the grey partial is dropped, blocks
    // already committed stay.
    _focusKept() {
        return !!this._session &&
            global.display.focus_window === this._session.window &&
            this._sink.focused;
    }

    _onFocusWindow() {
        if (this._live && !this._focusKept())
            this._run(this._machine.external('cancel'));
    }

    // -- engine events -----------------------------------------------------

    _listeningHint() {
        const how = this._machine.state === TOGGLE
            ? this._('press again or Esc to stop')
            : this._('release to stop');
        return this._mic ? `${this._mic} — ${how}` : `${this._('Listening')} — ${how}`;
    }

    _onOwner(hasOwner) {
        if (hasOwner || !this._session)
            return;
        this._hud.error(this._('Engine stopped unexpectedly'));
        this._finishLocally('error');
    }

    _onSource(description) {
        this._mic = description;
    }

    _onState(state) {
        if (!this._live)
            return;
        if (state === 'loading')
            this._hud.status(this._('Loading the model…'));
        else if (state === 'listening')
            this._hud.status(this._listeningHint(), 'listening');
        else if (state === 'decoding')
            this._hud.status(this._('…'), 'listening');
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
        if (!this._focusKept() || !this._sink.partial(text)) {
            this._run(this._machine.external('cancel'));
            return;
        }
        this._hud.live(text);
    }

    _onFinal(text) {
        if (!this._session)
            return;
        if (!this._focusKept() || !this._sink.commit(text)) {
            // Focus moved: this block goes nowhere rather than elsewhere.
            if (this._live)
                this._run(this._machine.external('cancel'));
            return;
        }
        this._hud.live(text);
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
        if (reason === 'error')
            this._hud.hide(2500);
        else
            this._hud.hide();
        if (this._startQueued)
            this._startNow();
    }

    _onError(message) {
        if (message === 'models-missing')
            this._showEngineError('models-missing');
        else
            this._hud.error(message.startsWith('audio') ? this._('Microphone unavailable') : message);
        // The engine sends Stopped('error') after these; an older engine does
        // not, so end the session ourselves if nothing follows.
        if (this._session && FATAL_ERRORS.some(p => message.startsWith(p)))
            this._armGuard(this._session);
    }

    _showEngineError(code) {
        const texts = {
            'not-installed': this._('Engine not installed — see the extension settings'),
            'spawn-failed': this._('Engine failed to start — see the extension settings'),
            'models-missing': this._('Models missing — run: voice-hold-engine setup'),
            'timeout': this._('Engine did not answer'),
            'busy': this._('Engine busy — try again'),
            'no-proxy': this._('D-Bus unavailable'),
        };
        if (code === 'cancelled')
            return;
        this._hud.error(texts[code] ?? code);
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
