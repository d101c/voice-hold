import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import IBus from 'gi://IBus';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {EngineClient} from './engine.js';
import {HoldMachine, IDLE, TOGGLE} from './holdMachine.js';
import {Hud} from './hud.js';
import {TextSink} from './textSink.js';

// Glue between the gesture (holdMachine), the engine (D-Bus), the text field
// (textSink) and the pill (hud).

const WATCH_MS = 50;

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

// Stand-in for the GAsyncResult of a key we swallowed (same trick as Accent
// Hold's pressHold.js).
const CONSUMED = {};

export class Dictation {
    constructor(settings, iconPath, gettext) {
        this._settings = settings;
        this._ = gettext || (s => s);
        this._machine = new HoldMachine(this._machineOptions());
        this._hud = new Hud(iconPath, this._);
        this._sink = new TextSink(Main.inputMethod, Clutter);
        this._engine = new EngineClient({
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
        this._mask = modifierMask(settings.get_strv('trigger')[0] ?? '');
        this._session = false;

        settings.connectObject(
            'changed::mode', () => this._reconfigure(),
            'changed::tap-ms', () => this._reconfigure(),
            'changed::trigger', () => this._reconfigure(),
            this);
        global.display.connectObject('notify::focus-window', () => this._run(this._machine.external('focus')), this);
        this._hookKeys();
    }

    destroy() {
        this._run(this._machine.external('cancel'));
        this._unhookKeys();
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._stopWatch();
        this._stopSilence();
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
        this._mask = modifierMask(this._settings.get_strv('trigger')[0] ?? '');
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

    get active() {
        return this._machine.state !== IDLE;
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
        // Entering hands-free mode: say so, and arm the silence timer.
        if (this._machine.state === TOGGLE && this._session) {
            this._hud.status(this._('Listening — press again or Esc to stop'), 'listening');
            this._armSilence();
        }
    }

    _start() {
        this._session = true;
        this._sink.begin();
        if (this._settings.get_boolean('show-hud'))
            this._hud.show(this._('Starting…'), 'listening');
        const options = {
            'silence-stop-s': 0,
            'polish': this._settings.get_boolean('polish'),
            'polish-model': this._settings.get_string('polish-model'),
            'polish-url': this._settings.get_string('polish-url'),
        };
        this._engine.start(options).then(err => {
            if (!err || !this._session)
                return;
            this._run(this._machine.external('cancel'));
            this._showEngineError(err);
        });
    }

    _stop() {
        this._stopSilence();
        this._hud.status(this._('…'), 'listening');
        this._engine.stop().then(err => {
            if (err)
                this._showEngineError(err);
        });
    }

    _cancel() {
        this._stopSilence();
        this._sink.end();
        this._engine.cancel();
        this._session = false;
        this._hud.hideNow();
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

    // -- engine events -----------------------------------------------------

    _onState(state) {
        if (!this._session)
            return;
        if (state === 'loading')
            this._hud.status(this._('Loading the model…'));
        else if (state === 'listening')
            this._hud.status(this._machine.state === TOGGLE
                ? this._('Listening — press again or Esc to stop')
                : this._('Listening — release to stop'), 'listening');
        else if (state === 'decoding')
            this._hud.status(this._('…'), 'listening');
    }

    _onSpeech(speaking) {
        if (!this._session)
            return;
        if (speaking)
            this._stopSilence();
        else
            this._armSilence();
    }

    _onPartial(text) {
        if (!this._session)
            return;
        this._sink.partial(text);
        this._hud.live(text);
    }

    _onFinal(text) {
        if (!this._session)
            return;
        this._sink.commit(text);
        this._hud.live(text);
    }

    _onStopped(reason) {
        if (!this._session)
            return;
        this._session = false;
        this._stopSilence();
        this._sink.end();
        this._run(this._machine.external('engine'));
        if (reason === 'error')
            this._hud.hide(2500);
        else
            this._hud.hide();
    }

    _onError(message) {
        if (message === 'models-missing') {
            this._showEngineError('models-missing');
            return;
        }
        this._hud.error(message.startsWith('audio') ? this._('Microphone unavailable') : message);
    }

    _showEngineError(code) {
        const texts = {
            'not-installed': this._('Engine not installed — see the extension settings'),
            'spawn-failed': this._('Engine failed to start — see the extension settings'),
            'models-missing': this._('Models missing — run: voice-hold-engine setup'),
            'timeout': this._('Engine did not answer'),
            'no-proxy': this._('D-Bus unavailable'),
        };
        if (code === 'cancelled')
            return;
        this._hud.error(texts[code] ?? code);
    }

    // -- Escape / shortcut inside text fields --------------------------------
    //
    // Keys typed into a text field go through IBus.InputContext.
    // process_key_event_async (see Accent Hold). While dictating we swallow
    // Escape (cancel) there; everything else goes through untouched.

    _hookKeys() {
        const proto = IBus.InputContext.prototype;
        this._origProcess = proto.process_key_event_async;
        this._origFinish = proto.process_key_event_async_finish;
        const self = this;
        proto.process_key_event_async = function (...args) {
            const callback = args[args.length - 1];
            if (typeof callback === 'function' && self._filterKey(args[0], args[2])) {
                callback(this, CONSUMED);
                return undefined;
            }
            return self._origProcess.apply(this, args);
        };
        proto.process_key_event_async_finish = function (res) {
            if (res === CONSUMED)
                return true;
            return self._origFinish.call(this, res);
        };
    }

    _unhookKeys() {
        const proto = IBus.InputContext.prototype;
        if (this._origProcess)
            proto.process_key_event_async = this._origProcess;
        if (this._origFinish)
            proto.process_key_event_async_finish = this._origFinish;
        this._origProcess = null;
        this._origFinish = null;
    }

    _filterKey(keyval, state) {
        try {
            if (this._machine.state === IDLE)
                return false;
            if (keyval !== Clutter.KEY_Escape)
                return false;
            if ((state & IBus.ModifierType.RELEASE_MASK) === 0)
                this._run(this._machine.escape());
            return true;
        } catch (e) {
            logError(e, 'voice-hold: key filter');
            return false;
        }
    }
}
