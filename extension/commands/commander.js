// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import IBus from 'gi://IBus';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {modifierMask} from '../dictation.js';
import {EngineClient} from '../engine.js';
import {HoldMachine, IDLE, TOGGLE} from '../holdMachine.js';
import {installKeyHook} from '../keyHook.js';
import {llmLowMemory, speechLowMemory} from '../memoryText.js';
import {accentColor} from '../accentColor.js';
import {Paster} from '../paste.js';
import {selectedText} from '../textSink.js';
import {Actions} from './actions.js';
import {CommandEngineClient, commandHistory} from './commandEngine.js';
import {CommandHud} from './commandHud.js';
import {dispatch} from './dispatch.js';
import {Pointer} from './pointer.js';
import {captureWindow} from './screen.js';
import {keyLabel, toScreen} from './screenMap.js';
import {RECENT, recentLabel} from './recent.js';

// The voice commands, an optional second gesture of Voice Hold: hold the
// `command-shortcut`, say what to do, release. The speech engine listens (the
// same one as the dictation, through its own client), the sentence goes to
// the command helper (commandEngine.js), and the intent that comes back is
// executed here (GNOME actions) or shown and confirmed first (shell
// commands, power). One session at a time, and never while a dictation is
// running: extension.js keeps the two shortcuts apart.
//
// The gesture settings (mode, tap-ms, silence-stop-s), the microphone and
// the pill's settings are the dictation's; only the `command-*` keys are
// the commands' own.

const WATCH_MS = 50;
const END_GUARD_MS = 3000;
const SHOW_RESULT_MS = 2500;
const SHOW_ANSWER_MS = 6000;
const SHOW_JOB_MS = 4000;
const SHOW_OUTPUT_MS = 45000;     // a command's output stays until clicked, or this long
const SHOW_RECALL_MS = 30000;     // a history entry recalled from the menu

export class Commander {
    constructor(settings, iconPath, gettext) {
        this._settings = settings;
        this._ = gettext;
        this._pointer = new Pointer();
        this._paster = new Paster();
        this._machine = new HoldMachine(this._machineOptions());
        this._hud = new CommandHud(iconPath, this._, () => this._settings.get_string('hud-position'),
            () => this._settings.get_string('hud-effect'));
        this._actions = new Actions(this._);
        // The speech engine sends its signals to every client: everything
        // below is ignored unless the session is ours (a dictation has its
        // own client and its own pill).
        this._voice = new EngineClient({
            Owner: has => this._onVoiceOwner(has),
            State: s => this._onState(s),
            Level: v => this._live && this._hud.level(v),
            Speech: b => this._onSpeech(b),
            Final: t => this._onFinal(t),
            Stopped: r => this._onStopped(r),
            Error: m => this._onVoiceError(m),
        });
        this._engine = new CommandEngineClient({
            Owner: has => this._onEngineOwner(has),
            Job: (id, state, code, tail) => this._onJob(id, state, code, tail),
        });
        this._watchId = 0;
        this._silenceId = 0;
        this._guardId = 0;
        this._mask = modifierMask(settings.get_strv('command-shortcut')[0] ?? '');
        this._session = null;   // {ending, texts: [], window}
        this._busy = false;     // interpreting / confirming / executing
        this._epoch = 0;        // bumped when a request is dropped (yieldTo)
        this._queued = false;   // a start waiting for the dictation to finish
        this._elsewhere = null; // () => the dictation has the microphone
        this._onIdle = null;    // called once our session is over
        this._closeDialog = null;   // closes the confirmation that is open
        this._jobs = new Map(); // job id -> {command, id: history id}

        settings.connectObject(
            'changed::mode', () => this._reconfigure(),
            'changed::tap-ms', () => this._reconfigure(),
            'changed::command-shortcut', () => this._reconfigure(),
            this);
        this._keyHook = installKeyHook(IBus.InputContext.prototype, (keyval, state) => this._filterKey(keyval, state));
    }

    destroy() {
        this._pointer?.destroy();
        this._pointer = null;
        this._paster?.destroy();
        this._paster = null;
        this._run(this._machine.external('cancel'));
        this._endSession();
        this._closeDialog?.();
        this._closeDialog = null;
        this._keyHook.uninstall();
        this._keyHook = null;
        this._settings.disconnectObject(this);
        this._stopWatch();
        this._voice.destroy();
        this._voice = null;
        this._engine.destroy();
        this._engine = null;
        this._actions.destroy();
        this._actions = null;
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
        this._mask = modifierMask(this._settings.get_strv('command-shortcut')[0] ?? '');
    }

    // -- entry point -----------------------------------------------------------

    shortcut() {
        if (this._busy)
            return;
        this._run(this._machine.shortcut(GLib.get_monotonic_time() / 1000));
    }

    // Listening, thinking, confirming or running.
    get active() {
        return this._machine.state !== IDLE || !!this._session || this._busy || this._queued;
    }

    // The microphone is ours, or about to be.
    get usesVoice() {
        return !!this._session || this._queued;
    }

    setElsewhere(fn) {
        this._elsewhere = fn;
    }

    setOnIdle(fn) {
        this._onIdle = fn;
    }

    // The dictation shortcut was pressed: drop what is under way. The words
    // heard so far were meant for a command, not for the text field. A
    // command already started in a terminal goes on; only its pill goes.
    yieldTo() {
        this._queued = false;
        if (this._session || this._machine.state !== IDLE)
            this._run(this._machine.external('cancel'));
        if (this._busy) {
            this._epoch++;
            this._busy = false;
            this._closeDialog?.();
            this._closeDialog = null;
        }
        this._hud.hideNow();
    }

    // The dictation let go of the microphone: a start that waited for it
    // goes ahead.
    kick() {
        if (this._queued && !this._elsewhere?.()) {
            this._queued = false;
            this._start();
        }
    }

    // A dictation is starting: a result still on screen makes room for its
    // pill (both hang from the same place).
    dismiss() {
        if (!this.active)
            this._hud.hideNow();
    }

    // For the indicator's menu: the last requests, newest first, as
    // [{label, entry}]; `entry` is what recall() takes. Never starts the
    // helper: an empty list when it is not running.
    recent() {
        const exit = code => this._(' (exit %d)').format(code);
        return commandHistory(RECENT).then(entries => entries.map(entry => ({label: recentLabel(entry, exit), entry})));
    }

    get _live() {
        return !!this._session && !this._session.ending;
    }

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
        if (this._machine.state === TOGGLE && this._live) {
            this._hud.status(this._listeningHint(), 'listening');
            this._armSilence();
        }
    }

    // -- session --------------------------------------------------------------

    _start() {
        if (this._session)
            return;
        if (this._elsewhere?.()) {
            // The dictation is finishing its last block (yieldTo), its pill
            // still up: kick() starts this one, and shows its pill, then.
            this._queued = true;
            return;
        }
        const session = {ending: false, texts: [], window: global.display.focus_window,
            focus: Main.inputMethod.currentFocus, selection: this._selection()};
        // A picture of the window, for the cloud assistant: taken now, before
        // anything changes, sent only if the model asks to look.
        session.shot = this._settings.get_boolean('cloud-enabled') && this._settings.get_boolean('cloud-screen')
            ? captureWindow(session.window).catch(e => {
                logError(e, 'voice-hold: window picture');
                return null;
            })
            : null;
        this._pointer.hide();
        this._session = session;
        this._voice.stopSpeaking();
        if (this._settings.get_boolean('show-hud'))
            this._hud.show(this._listeningHint(), 'listening');
        // The local model is warmed up only when it is the one that answers:
        // with the cloud on, it is a fallback for when the network is down.
        if (this._settings.get_boolean('command-llm') && !this._settings.get_boolean('cloud-enabled'))
            this._engine.prepare();
        const options = {
            'silence-stop-s': 0,
            'polish': false,
            'source': this._settings.get_string('microphone'),
        };
        this._voice.start(options).then(err => {
            if (!err || this._session !== session || session.ending)
                return;
            this._run(this._machine.external('engine'));
            this._endSession();
            this._showVoiceError(err);
        });
    }

    _stop() {
        if (this._queued) {
            this._queued = false;         // released before it could start
            this._hud.hideNow();
            return;
        }
        const session = this._session;
        if (!session || session.ending)
            return;
        session.ending = true;
        this._stopSilence();
        this._hud.status('…', 'listening');
        this._voice.stop().then(err => {
            if (this._session !== session)
                return;
            if (err) {
                this._showVoiceError(err);
                this._onStopped('error');
                return;
            }
            this._armGuard(session);
        });
    }

    _cancel() {
        if (this._queued) {
            this._queued = false;
            this._hud.hideNow();
            return;
        }
        const session = this._session;
        if (!session)
            return;
        this._stopSilence();
        this._hud.hideNow();
        if (session.ending)
            return;
        session.ending = true;
        session.cancelled = true;
        this._voice.cancel().then(err => {
            if (this._session !== session)
                return;
            if (err)
                this._onStopped('cancel');
            else
                this._armGuard(session);
        });
    }

    _endSession() {
        this._cancelGuard();
        this._stopSilence();
        const had = !!this._session;
        this._session = null;
        if (had)
            this._onIdle?.();
    }

    _armGuard(session) {
        this._cancelGuard();
        this._guardId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, END_GUARD_MS, () => {
            this._guardId = 0;
            if (this._session === session)
                this._onStopped('error');
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelGuard() {
        if (this._guardId) {
            GLib.Source.remove(this._guardId);
            this._guardId = 0;
        }
    }

    // -- modifier polling / silence --------------------------------------------

    _startWatch() {
        this._stopWatch();
        if (!this._mask) {
            this._run(this._machine.modifier(GLib.get_monotonic_time() / 1000, false));
            return;
        }
        this._watchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCH_MS, () => {
            const [, , mods] = global.get_pointer();
            // Every modifier of the shortcut: letting go of one is letting go.
            const held = (mods & this._mask) === this._mask;
            this._run(this._machine.modifier(GLib.get_monotonic_time() / 1000, held));
            return this._watchId ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    _stopWatch() {
        if (this._watchId) {
            GLib.Source.remove(this._watchId);
            this._watchId = 0;
        }
    }

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
            GLib.Source.remove(this._silenceId);
            this._silenceId = 0;
        }
    }

    // -- voice events -------------------------------------------------------------

    _listeningHint() {
        return this._machine.state === TOGGLE
            ? this._('Listening — press again or Esc to stop')
            : this._('Listening — release to run');
    }

    _onVoiceOwner(hasOwner) {
        if (hasOwner || !this._session)
            return;
        this._hud.error(this._('Engine stopped unexpectedly'));
        this._onStopped('error');
    }

    _onState(state) {
        if (!this._live)
            return;
        if (state === 'loading' || state === 'listening')
            this._hud.status(this._listeningHint(), 'listening');
        else if (state === 'decoding')
            this._hud.status('…', 'listening');
    }

    _onSpeech(speaking) {
        if (!this._live)
            return;
        if (speaking)
            this._stopSilence();
        else
            this._armSilence();
    }

    _onFinal(text) {
        if (!this._session)
            return;
        const t = text.trim();
        if (!t)
            return;
        this._session.texts.push(t);
        this._hud.live(this._session.texts.join(' '));
    }

    _onStopped(reason) {
        const session = this._session;
        if (!session)
            return;
        const wasEnding = session.ending;
        this._endSession();
        if (!wasEnding)
            this._run(this._machine.external('engine'));
        if (session.cancelled || reason === 'cancel') {
            this._hud.hideNow();
            return;
        }
        const text = session.texts.join(' ').trim();
        if (reason === 'error') {
            this._hud.hide(2500);
            return;
        }
        if (!text) {
            this._hud.status(this._('Nothing heard'), '');
            this._hud.hide(1500);
            return;
        }
        if (session.selection)
            this._commandOrRewrite(text, session);
        else
            this._interpret(text, session.window, session.shot);
    }

    // With text selected, a known command ("open the settings", "volume
    // down") is still a command: the rules alone are asked first, and only
    // what they do not know rewrites the selection.
    async _commandOrRewrite(text, session) {
        const epoch = this._epoch;
        const res = await this._engine.interpret(text, {'llm': false, 'cloud': false,
            'work-dir': this._settings.get_string('command-work-dir')});
        if (this._stale(epoch))
            return;
        const action = res.ok ? res.value?.action : '';
        if (action && action !== 'unknown' && action !== 'run_shell')
            this._interpret(text, session.window, session.shot);
        else
            this._rewriteSelection(text, session);
    }

    // The text selected in the focused field, when the application reports
    // it (GNOME 46+, input-method fields), else null.
    _selection() {
        try {
            return selectedText(Main.inputMethod.getSurroundingText());
        } catch {
            return null;
        }
    }

    // Text selected when the shortcut was pressed: what was said is an
    // instruction for it ("shorter", "in English", "more polite"). The
    // rewritten text replaces the selection if it is still there; a question
    // ("what does it mean?") is answered in the pill and changes nothing.
    async _rewriteSelection(said, session) {
        const epoch = this._epoch;
        this._busy = true;
        const question = /\?\s*$/.test(said);
        this._hud.status(question ? this._('Thinking…') : this._('Rewriting the selection…'), 'loading');
        const cloud = this._settings.get_boolean('cloud-enabled') &&
            this._settings.get_string('cloud-provider') === 'anthropic'
            ? {provider: 'anthropic', model: this._settings.get_string('cloud-model')} : null;
        const instruction = question
            ? `Answer this question about the text, in at most three short sentences, in the language of the question: ${said}`
            : said;
        try {
            const out = (await this._voice.rewrite(session.selection, instruction, cloud)).trim();
            if (this._stale(epoch))
                return;
            if (!out) {
                this._hud.error(this._('No language model answered: switch on the cloud model or install the local one'));
                return;
            }
            if (question) {
                this._hud.result(said, out);
                this._hud.hide(15000);
                return;
            }
            const still = global.display.focus_window === session.window &&
                Main.inputMethod.currentFocus === session.focus && this._selection() === session.selection;
            if (still) {
                Main.inputMethod.commit(out);
                this._hud.status(this._('Selection rewritten'), 'listening');
                this._hud.hide(1200);
            } else {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, out);
                this._hud.status(this._('The selection changed: the new text is in the clipboard'), 'listening');
                this._hud.hide(3500);
            }
        } finally {
            if (epoch === this._epoch)
                this._busy = false;
        }
    }

    _onVoiceError(message) {
        if (!this._session)
            return;                       // a dictation's error, shown by its own pill
        const lowMemory = speechLowMemory(message, this._);
        if (message === 'models-missing')
            this._showVoiceError('models-missing');
        else if (lowMemory)
            this._hud.error(lowMemory);
        else
            this._hud.error(message.startsWith('audio') ? this._('Microphone unavailable') : message);
        this._armGuard(this._session);
    }

    _showVoiceError(code) {
        const texts = {
            'not-installed': this._('Speech engine not installed — see the extension settings'),
            'spawn-failed': this._('Engine failed to start — see the extension settings'),
            'models-missing': this._('Speech models missing — see the extension settings'),
            'timeout': this._('Engine did not answer'),
            'busy': this._('Engine busy — try again'),
            'no-proxy': this._('D-Bus unavailable'),
        };
        if (code === 'cancelled')
            return;
        this._hud.error(texts[code] ?? code);
    }

    // -- understanding and execution ------------------------------------------

    async _interpret(text, window, shot = null) {
        const epoch = this._epoch;
        this._busy = true;
        this._hud.status(this._('Thinking…'), 'loading');
        const options = {
            'llm': this._settings.get_boolean('command-llm'),
            'work-dir': this._settings.get_string('command-work-dir'),
            // The optional cloud assistant (Cloud page); its key is in the keyring.
            'cloud': this._settings.get_boolean('cloud-enabled'),
            'cloud-provider': this._settings.get_string('cloud-provider'),
            'cloud-model': this._settings.get_string('cloud-model'),
        };
        try {
            const screen = shot ? await shot : null;
            if (screen) {
                options['screen-path'] = screen.path;
                options['screen-width'] = screen.width;
                options['screen-height'] = screen.height;
            }
            const res = await this._engine.interpret(text, options);
            if (this._gone || epoch !== this._epoch)
                return;                   // dropped for a dictation meanwhile
            if (!res.ok) {
                this._showEngineError(res.error);
                return;
            }
            await this._execute(res.value, text, window, epoch, screen);
        } catch (e) {
            logError(e, 'voice-hold: interpret');
            this._hud?.error(e.message);
        } finally {
            if (epoch === this._epoch)
                this._busy = false;
        }
    }

    // destroy() ran while a call was awaited (the commands were switched
    // off, the extension disabled): nothing more may be touched.
    // Gone, or dropped for a dictation (yieldTo) since `epoch`.
    _stale(epoch) {
        return this._gone || epoch !== this._epoch;
    }

    get _gone() {
        return !this._hud;
    }

    async _execute(intent, text, window, epoch = this._epoch, screen = null) {
        const result = await dispatch(intent, this._actions);
        if (this._stale(epoch))
            return;
        const id = intent.id ?? '';
        switch (result.kind) {
        case 'done': {
            const say = intent.say || result.say || this._('Done');
            this._hud.status(say, 'listening');
            this._hud.hide(SHOW_RESULT_MS);
            this._engine.note(id, say);
            this._speak(say);
            return;
        }
        case 'answer':
            this._showText(text, result.text, SHOW_ANSWER_MS);
            this._engine.note(id, result.text);
            this._speak(result.text);
            return;
        case 'refused':
            this._hud.error(this._('Refused: %s').format(result.reason));
            this._engine.note(id, this._('Refused: %s').format(result.reason));
            return;
        case 'error':
            this._hud.error(result.reason);
            this._engine.note(id, result.reason);
            return;
        case 'unknown':
            this._hud.error(this._unknownText(result.reason, text));
            this._engine.note(id, this._unknownText(result.reason, text));
            return;
        case 'quiet':
            await this._runQuiet(result.intent, text, epoch);
            return;
        case 'type':
            await this._type(intent, window, epoch);
            return;
        case 'point': {
            const at = toScreen(screen, intent.x, intent.y);
            if (!at) {
                this._hud.error(this._('No picture of the window to point at'));
                return;
            }
            this._pointer.show(...at, intent.label, accentColor());
            const say = intent.say || intent.label;
            this._hud.status(say, 'listening');
            this._hud.hide(SHOW_ANSWER_MS);
            this._engine.note(id, say);
            this._speak(say);
            return;
        }
        case 'input':
            await this._input(intent, text, window, screen, epoch);
            return;
        case 'confirm':
            break;
        }
        this._hud.hideNow();
        const i = result.intent;
        if (i.action === 'power') {
            const names = {suspend: this._('Suspend'), reboot: this._('Restart'), shutdown: this._('Power off'), logout: this._('Log out')};
            const ok = await this._hud.confirm({
                title: this._('Voice Hold heard: “%s”').format(text),
                command: names[i.power_action] ?? i.power_action,
                warning: '',
                runLabel: names[i.power_action] ?? this._('Run'),
                cancelLabel: this._('Cancel'),
                onOpen: close => (this._closeDialog = close),
            });
            this._closeDialog = null;
            if (ok && !this._stale(epoch))
                this._actions.power(i.power_action);
            return;
        }
        const ok = await this._hud.confirm({
            title: this._('Voice Hold heard: “%s”').format(text),
            summary: i.summary ?? '',
            command: `$ ${i.command}`,
            warning: i.warning ? this._('Warning: this %s.').format(i.warning) : '',
            runLabel: this._('Run'),
            cancelLabel: this._('Cancel'),
            onOpen: close => (this._closeDialog = close),
        });
        this._closeDialog = null;
        if (!ok || this._stale(epoch))
            return;
        this._hud.show(this._('Running…'), 'loading');
        const run = await this._engine.run(i.command, i.cwd ?? '');
        if (this._stale(epoch))
            return;
        if (!run.ok) {
            this._showEngineError(run.error);
            return;
        }
        this._jobs.set(run.value, {command: i.command, id});
    }

    // Text the assistant wrote on request ("écris-moi ... ici"): pasted where
    // the user was when they spoke, or left in the clipboard if that window
    // lost the focus or takes no paste.
    async _type(intent, window, epoch) {
        const how = await this._paster.deliver(String(intent.text ?? ''), window);
        if (this._stale(epoch))
            return;
        const say = how === 'pasted'
            ? intent.say || this._('Written')
            : this._('Copied — paste it with Ctrl+V');
        this._hud.status(say, 'listening');
        this._hud.hide(SHOW_RESULT_MS);
        this._engine.note(intent.id ?? '', say);
    }

    // A click or a shortcut done for the user, one step, after they say yes
    // in the island; the ring shows where the click will land.
    async _input(intent, text, window, screen, epoch) {
        const click = intent.action === 'click';
        const at = click ? toScreen(screen, intent.x, intent.y) : null;
        if (click && !at) {
            this._hud.error(this._('No picture of the window to click on'));
            return;
        }
        if (at)
            this._pointer.show(...at, intent.label, accentColor());
        const ok = await this._hud.confirm({
            title: this._('Voice Hold heard: “%s”').format(text),
            summary: intent.say || '',
            command: click
                ? this._('Click: %s').format(intent.label || '?')
                : this._('Keys: %s (%s)').format(keyLabel(intent.keys), intent.label || ''),
            runLabel: click ? this._('Click') : this._('Press'),
            cancelLabel: this._('Cancel'),
            onOpen: close => (this._closeDialog = close),
        });
        this._closeDialog = null;
        if (!ok || this._stale(epoch)) {
            this._pointer.hide();
            return;
        }
        this._hud.hideNow();
        // Back to the user's window, then the input, once the island has let
        // go of the keyboard.
        if (window && global.display.focus_window !== window)
            window.activate(global.get_current_time());
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            r();
            return GLib.SOURCE_REMOVE;
        }));
        if (this._stale(epoch))
            return;
        const done = click ? (this._pointer.click(...at, !!intent.double), true) : this._pointer.keys(intent.keys);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._pointer?.hide();
            return GLib.SOURCE_REMOVE;
        });
        const say = done ? this._('Done') : this._('Unknown shortcut: %s').format(intent.keys);
        this._engine.note(intent.id ?? '', say);
        if (!done)
            this._hud.error(say);
    }

    // A read-only command: the engine runs it, the pill shows the output
    // under the command, several lines, scrollable, until clicked away.
    async _runQuiet(intent, text, epoch = this._epoch) {
        this._hud.status(`$ ${intent.command}`, 'loading');
        const run = await this._engine.runQuiet(intent.id ?? '', intent.command, intent.cwd ?? '');
        if (this._stale(epoch))
            return;
        if (!run.ok) {
            this._showEngineError(run.error);
            return;
        }
        const {code, output} = run.value;
        const header = code === 0 ? `$ ${intent.command}` : this._('$ %s — exit %d').format(intent.command, code);
        this._showOutput(header, output || this._('(no output)'), code === 0 ? 'listening' : 'error');
        if (!this._settings.get_boolean('command-speak') || !output || !this._settings.get_boolean('command-llm'))
            return;
        // Raw output is not for the ear: the LLM turns it into one sentence,
        // which replaces the status line and is said aloud. Not awaited: the
        // output is on screen, the shortcut is free again.
        this._engine.summarize(text, intent.command, output).then(sum => {
            if (this._stale(epoch) || !sum.ok || !sum.value || !this._hud.showingResult)
                return;
            this._hud.header(sum.value, code === 0 ? 'listening' : 'error');
            this._speak(sum.value);
        });
    }

    // -- spoken answers ------------------------------------------------------------

    _speakLang() {
        const v = this._settings.get_string('command-voice');
        if (v)
            return v;
        const lang = (GLib.get_language_names()[0] ?? '').toLowerCase();
        return lang.startsWith('fr') ? 'fr' : 'en';
    }

    _speak(text) {
        if (!this._settings.get_boolean('command-speak') || !text)
            return;
        this._voice.speak(text, this._speakLang()).then(err => {
            if (!this._hud)
                return;                   // destroyed meanwhile
            if (err === 'voice-missing')
                this._hud.error(this._('No voice installed — run: voice-hold-engine setup --tts'));
            else if (err && err !== 'cancelled')
                console.warn(`voice-hold: speak: ${err}`);
        });
    }

    // One short answer stays on the status line; a long or multi-line one
    // opens the result area.
    _showText(heard, answer, delay) {
        const long = answer.includes('\n') || answer.length > 72;
        if (!long) {
            this._hud.status(answer, 'listening');
            this._hud.hide(delay);
            return;
        }
        this._hud.result(this._('“%s”').format(heard), answer, {onDismiss: () => this._hud.hideNow()});
        this._hud.hide(SHOW_OUTPUT_MS);
    }

    _showOutput(header, output, pseudo) {
        this._hud.result(header, output, {pseudo, monospace: true, onDismiss: () => this._hud.hideNow()});
        this._hud.hide(SHOW_OUTPUT_MS);
    }

    // From the indicator's menu: show a past request again, with what it
    // produced.
    recall(entry) {
        if (this._busy || this._session)
            return;
        const heard = this._('“%s”').format(entry.transcript ?? '');
        if (entry.command) {
            const header = entry.exit === 0 || entry.exit === null
                ? `${heard}  $ ${entry.command}` : this._('%s  $ %s — exit %d').format(heard, entry.command, entry.exit);
            this._hud.result(header, entry.result || entry.say || this._('(no output)'),
                {pseudo: entry.exit ? 'error' : 'listening', monospace: !!entry.result, onDismiss: () => this._hud.hideNow()});
        } else {
            this._hud.result(heard, entry.result || entry.say || this._('(nothing)'), {onDismiss: () => this._hud.hideNow()});
        }
        this._hud.hide(SHOW_RECALL_MS);
    }

    // The pill shows one line and cuts its start: the reason goes last.
    _unknownText(reason, text) {
        const cloud = {
            'cloud-no-key': this._('No API key for the cloud model — settings, Cloud page'),
            'cloud-key-rejected': this._('The cloud provider refused the API key — settings, Cloud page'),
            'cloud-rate-limited': this._('The cloud provider asks to slow down — try again in a moment'),
            'cloud-timeout': this._('The cloud model took too long'),
            'cloud-unreachable': this._('The cloud model cannot be reached'),
            'cloud-sdk-missing': this._('Cloud support is not installed in the speech engine'),
            'cloud-provider-unsupported': this._('This cloud provider is not supported yet — choose Anthropic'),
            'cloud-refused': this._('The cloud model declined this request'),
        }[reason];
        if (cloud)
            return cloud;
        if (reason?.startsWith('cloud-error'))
            return this._('Cloud model error (%s)').format(reason.slice(13) || '?');
        if (reason === 'llm-off')
            return this._('“%s” — not a known action, and the language model is off').format(text);
        if (reason === 'llm-not-installed')
            return this._('Language model not installed — settings, Commands page');
        if (llmLowMemory(reason))
            return llmLowMemory(reason, this._);
        if (reason === 'llm-unavailable')
            return this._('“%s” — not a known action, and the language model is not available').format(text);
        if (reason === 'llm-timeout')
            return this._('“%s” — the language model took too long').format(text);
        if (reason === 'nothing to do')
            return this._('OK');
        return this._('Not understood: “%s”').format(text);
    }

    _onEngineOwner(hasOwner) {
        if (hasOwner)
            return;
        if (this._busy)
            this._hud.error(this._('Command helper stopped unexpectedly'));
        for (const id of this._jobs.keys())
            this._jobs.delete(id);
    }

    _onJob(id, state, code, tail) {
        if (!this._jobs.has(id))
            return;
        // Not over a dictation's pill: they hang from the same place.
        const quiet = !!this._elsewhere?.();
        if (state === 'running') {
            if (quiet)
                return;
            this._hud.show(this._('Running…'), 'loading');
            return;
        }
        const job = this._jobs.get(id);
        this._jobs.delete(id);
        const detail = tail ? ` — ${tail}` : '';
        const text = state === 'done'
            ? this._('Done ✓%s').format(detail)
            : this._('Failed ✗ (exit %d)%s').format(code, detail);
        this._engine.note(job?.id ?? '', text, code);
        if (quiet)
            return;
        this._hud.show(text, state === 'done' ? 'listening' : 'error');
        this._hud.hide(SHOW_JOB_MS);
    }

    _showEngineError(code) {
        const texts = {
            'not-installed': this._('Command helper not installed — see the extension settings'),
            'spawn-failed': this._('Command helper failed to start — see the extension settings'),
            'no-terminal': this._('No terminal found (install Ptyxis or GNOME Terminal)'),
            'timeout': this._('Command helper did not answer'),
            'no-proxy': this._('D-Bus unavailable'),
        };
        if (code === 'cancelled')
            return;
        if (code.startsWith('refused: ')) {
            this._hud.error(this._('Refused: %s').format(code.slice(9)));
            return;
        }
        this._hud.error(texts[code] ?? code);
    }

    // -- Escape inside text fields (hands-free mode) ----------------------------

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
