// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// D-Bus client of the command helper (org.griffit.VoiceHold.Commands), a
// second activatable service of voice-hold-engine: it turns a sentence into
// an intent, runs confirmed shell commands and reports their jobs. The local
// LLM (a llama.cpp server) is entirely its business: nothing to configure
// from here but on or off.

export const BUS_NAME = 'org.griffit.VoiceHold.Commands';
export const OBJECT_PATH = '/org/griffit/VoiceHold/Commands';
export const INTERFACE = 'org.griffit.VoiceHold.Commands';
export const NO_TERMINAL_ERROR = `${INTERFACE}.Error.NoTerminal`;
export const REFUSED_ERROR = `${INTERFACE}.Error.Refused`;

const IFACE_XML = `
<node>
  <interface name="${INTERFACE}">
    <method name="Interpret">
      <arg type="s" name="text" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="a{sv}" name="intent" direction="out"/>
    </method>
    <method name="Run">
      <arg type="s" name="command" direction="in"/>
      <arg type="s" name="cwd" direction="in"/>
      <arg type="s" name="job_id" direction="out"/>
    </method>
    <method name="RunQuiet">
      <arg type="s" name="id" direction="in"/>
      <arg type="s" name="command" direction="in"/>
      <arg type="s" name="cwd" direction="in"/>
      <arg type="(is)" name="result" direction="out"/>
    </method>
    <method name="Note">
      <arg type="s" name="id" direction="in"/>
      <arg type="s" name="result" direction="in"/>
      <arg type="i" name="exit_code" direction="in"/>
    </method>
    <method name="Summarize">
      <arg type="s" name="transcript" direction="in"/>
      <arg type="s" name="command" direction="in"/>
      <arg type="s" name="output" direction="in"/>
      <arg type="s" name="sentence" direction="out"/>
    </method>
    <method name="History">
      <arg type="i" name="n" direction="in"/>
      <arg type="s" name="entries" direction="out"/>
    </method>
    <method name="Status"><arg type="a{sv}" name="status" direction="out"/></method>
    <method name="Prepare"/>
    <method name="ReloadApps"/>
    <method name="Quit"/>
    <signal name="Job">
      <arg type="s" name="id"/><arg type="s" name="state"/><arg type="i" name="exit_code"/><arg type="s" name="tail"/>
    </signal>
  </interface>
</node>`;

const Proxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);
// A cold start of the model can take 90 s on the helper's side; the pill
// says "Thinking…" meanwhile.
const INTERPRET_TIMEOUT_MS = 100000;
const CALL_TIMEOUT_MS = 10000;
const QUIET_TIMEOUT_MS = 20000;   // the helper kills the command after 12 s

export class CommandEngineClient {
    // handlers: {Owner, Job}
    constructor(handlers) {
        this._handlers = handlers;
        this._proxy = null;
        this._signalId = 0;
        this._ownerId = 0;
        this._cancellable = new Gio.Cancellable();
        try {
            this._proxy = new Proxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
                (proxy, error) => {
                    if (error && !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(error, 'voice-hold: command proxy');
                }, this._cancellable,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION);
            this._signalId = this._proxy.connect('g-signal', (_p, _sender, name, params) => {
                const fn = this._handlers[name];
                if (fn)
                    fn(...params.deepUnpack());
            });
            this._ownerId = this._proxy.connect('notify::g-name-owner', proxy => {
                this._handlers.Owner?.(!!proxy.g_name_owner);
            });
        } catch (e) {
            logError(e, 'voice-hold: command proxy');
        }
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxy) {
            if (this._signalId)
                this._proxy.disconnect(this._signalId);
            if (this._ownerId)
                this._proxy.disconnect(this._ownerId);
        }
        this._signalId = 0;
        this._ownerId = 0;
        this._proxy = null;
        this._handlers = {};
    }

    // Resolves to {ok: true, value} or {ok: false, error: code}.
    _call(method, args, timeout, unpack) {
        return new Promise(resolve => {
            if (!this._proxy) {
                resolve({ok: false, error: 'no-proxy'});
                return;
            }
            this._proxy.call(method, args, Gio.DBusCallFlags.NONE, timeout, this._cancellable,
                (proxy, res) => {
                    try {
                        const ret = proxy.call_finish(res);
                        resolve({ok: true, value: unpack ? unpack(ret) : null});
                    } catch (e) {
                        resolve({ok: false, error: classifyError(e)});
                    }
                });
        });
    }

    // options: {llm: bool, 'work-dir': str}
    interpret(text, options) {
        const dict = {};
        for (const [k, v] of Object.entries(options))
            dict[k] = typeof v === 'boolean' ? GLib.Variant.new_boolean(v) : GLib.Variant.new_string(String(v));
        return this._call('Interpret', new GLib.Variant('(sa{sv})', [text, dict]), INTERPRET_TIMEOUT_MS,
            ret => {
                const [dictOut] = ret.deepUnpack();
                const intent = {};
                for (const [k, v] of Object.entries(dictOut))
                    intent[k] = v.deepUnpack();
                return intent;
            });
    }

    // Start the LLM server and warm it while the user is talking. Starts the
    // helper when it is not running. Fire and forget.
    prepare() {
        return this._call('Prepare', null, CALL_TIMEOUT_MS);
    }

    run(command, cwd) {
        return this._call('Run', new GLib.Variant('(ss)', [command, cwd]), CALL_TIMEOUT_MS,
            ret => ret.deepUnpack()[0]);
    }

    // A read-only command, run by the helper itself: resolves to
    // {ok, value: {code, output}}.
    runQuiet(id, command, cwd) {
        return this._call('RunQuiet', new GLib.Variant('(sss)', [id, command, cwd]), QUIET_TIMEOUT_MS,
            ret => {
                const [[code, output]] = ret.deepUnpack();
                return {code, output};
            });
    }

    // One spoken sentence about a command's output, from the local LLM:
    // resolves to {ok, value: sentence} ('' when the LLM had nothing).
    summarize(transcript, command, output) {
        return this._call('Summarize', new GLib.Variant('(sss)', [transcript, command, output]), INTERPRET_TIMEOUT_MS,
            ret => ret.deepUnpack()[0]);
    }

    // Attach what the pill showed to a history entry. Fire and forget.
    note(id, result, exitCode = -1) {
        if (!id)
            return Promise.resolve({ok: false, error: 'no-id'});
        return this._call('Note', new GLib.Variant('(ssi)', [id, String(result ?? ''), exitCode]), CALL_TIMEOUT_MS);
    }
}

// The last n requests (newest first) as an array of
// {id, ts, transcript, action, command, say, result, exit}; [] when the
// helper is not running (it is not started for this) or on any error.
export function commandHistory(n, cancellable = null) {
    return new Promise(resolve => {
        try {
            Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE, 'History', new GLib.Variant('(i)', [n]),
                new GLib.VariantType('(s)'), Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, cancellable,
                (conn, res) => {
                    try {
                        const [json] = conn.call_finish(res).deepUnpack();
                        const entries = JSON.parse(json);
                        resolve(Array.isArray(entries) ? entries : []);
                    } catch {
                        resolve([]);
                    }
                });
        } catch {
            resolve([]);
        }
    });
}

// Status of the helper (prefs): resolves to its status dict
// {version, llm, llm_running, model_name, terminal, script, apps, jobs},
// to null when it is not running and `autoStart` is false, or to
// {error: code, message}; `error` is 'not-installed' when no such service
// is registered on the session bus.
export function commandStatus(cancellable = null, {autoStart = true} = {}) {
    return new Promise(resolve => {
        const flags = autoStart ? Gio.DBusCallFlags.NONE : Gio.DBusCallFlags.NO_AUTO_START;
        try {
            Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE, 'Status', null,
                new GLib.VariantType('(a{sv})'), flags, CALL_TIMEOUT_MS, cancellable,
                (conn, res) => {
                    try {
                        const [dict] = conn.call_finish(res).deepUnpack();
                        const out = {};
                        for (const [k, v] of Object.entries(dict))
                            out[k] = v.deepUnpack();
                        resolve(out);
                    } catch (e) {
                        const code = classifyError(e, false);
                        resolve(!autoStart && code === 'not-installed' ? null : {error: code, message: e.message});
                    }
                });
        } catch (e) {
            resolve({error: 'error', message: e.message});
        }
    });
}

// A short code for a D-Bus error, or `error: message`.
export function classifyError(e, log = true) {
    const name = Gio.DBusError.is_remote_error(e) ? Gio.DBusError.get_remote_error(e) : '';
    if (name === 'org.freedesktop.DBus.Error.ServiceUnknown' ||
        name === 'org.freedesktop.DBus.Error.NameHasNoOwner')
        return 'not-installed';
    if (name.startsWith('org.freedesktop.DBus.Error.Spawn'))
        return 'spawn-failed';
    if (name === NO_TERMINAL_ERROR)
        return 'no-terminal';
    if (name === REFUSED_ERROR) {
        Gio.DBusError.strip_remote_error(e);
        return `refused: ${e.message}`;
    }
    if (name === 'org.freedesktop.DBus.Error.NoReply' ||
        name === 'org.freedesktop.DBus.Error.Timeout' ||
        e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
        return 'timeout';
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return 'cancelled';
    if (log)
        logError(e, 'voice-hold: command helper call');
    return `error: ${e.message}`;
}
