import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// D-Bus client of voice-hold-engine. The service is activatable: the first
// method call starts it; when it is not installed the call fails with
// ServiceUnknown and we report `not-installed`.

export const BUS_NAME = 'org.griffit.VoiceHold';
export const OBJECT_PATH = '/org/griffit/VoiceHold';
export const INTERFACE = 'org.griffit.VoiceHold';
export const BUSY_ERROR = 'org.griffit.VoiceHold.Error.Busy';

const IFACE_XML = `
<node>
  <interface name="${INTERFACE}">
    <method name="Start"><arg type="a{sv}" name="options" direction="in"/></method>
    <method name="Stop"/>
    <method name="Cancel"/>
    <method name="Status"><arg type="a{sv}" name="status" direction="out"/></method>
    <method name="Quit"/>
    <method name="ListSources"><arg type="aa{sv}" name="sources" direction="out"/></method>
    <signal name="State"><arg type="s" name="state"/></signal>
    <signal name="Source"><arg type="s" name="description"/></signal>
    <signal name="Level"><arg type="d" name="level"/></signal>
    <signal name="Speech"><arg type="b" name="speaking"/></signal>
    <signal name="Partial"><arg type="s" name="text"/></signal>
    <signal name="Final"><arg type="s" name="text"/></signal>
    <signal name="Stopped"><arg type="s" name="reason"/></signal>
    <signal name="Error"><arg type="s" name="message"/></signal>
  </interface>
</node>`;

const Proxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);

// Start/Cancel answer at once. Stop answers after the last block is decoded
// (cold model load + decode + optional polish), so it gets a long leash; the
// caller ends the session on its own if no `Stopped` follows the answer.
const CALL_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 60000;

export class EngineClient {
    // handlers: {Owner, State, Source, Level, Speech, Partial, Final, Stopped, Error}
    // `Owner(hasOwner)` is called when the engine appears on or leaves the bus.
    constructor(handlers) {
        this._handlers = handlers;
        this._proxy = null;
        this._signalId = 0;
        this._ownerId = 0;
        this._cancellable = new Gio.Cancellable();
        this._connect();
    }

    _connect() {
        try {
            this._proxy = new Proxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
                (proxy, error) => {
                    if (error && !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(error, 'voice-hold: proxy');
                }, this._cancellable,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION);
            this._signalId = this._proxy.connect('g-signal', (_p, _sender, name, params) => {
                const fn = this._handlers[name];
                if (fn)
                    fn(...params.deepUnpack());
            });
            // The engine process died (or exited at idle): the name loses its
            // owner and no `Stopped` will ever come for a running session.
            this._ownerId = this._proxy.connect('notify::g-name-owner', proxy => {
                const fn = this._handlers.Owner;
                if (fn)
                    fn(!!proxy.g_name_owner);
            });
        } catch (e) {
            logError(e, 'voice-hold: proxy');
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

    // Resolves to null on success, or an error code string.
    _call(method, args = null, timeout = CALL_TIMEOUT_MS) {
        return new Promise(resolve => {
            if (!this._proxy) {
                resolve('no-proxy');
                return;
            }
            this._proxy.call(method, args, Gio.DBusCallFlags.NONE, timeout, this._cancellable,
                (proxy, res) => {
                    try {
                        proxy.call_finish(res);
                        resolve(null);
                    } catch (e) {
                        resolve(classify(e));
                    }
                });
        });
    }

    start(options) {
        const dict = {};
        for (const [k, v] of Object.entries(options)) {
            if (typeof v === 'boolean')
                dict[k] = GLib.Variant.new_boolean(v);
            else if (typeof v === 'number')
                dict[k] = GLib.Variant.new_double(v);
            else
                dict[k] = GLib.Variant.new_string(String(v));
        }
        return this._call('Start', new GLib.Variant('(a{sv})', [dict]));
    }

    stop() {
        return this._call('Stop', null, STOP_TIMEOUT_MS);
    }

    cancel() {
        return this._call('Cancel');
    }
}

// Microphones known to the engine: resolves to [{name, description, default}]
// (empty on any error). Usable without an EngineClient (prefs, indicator).
// With `autoStart: false` the engine is not spawned: the promise resolves to
// null when it is not running.
export function listSources(cancellable = null, {autoStart = true} = {}) {
    return new Promise(resolve => {
        const flags = autoStart ? Gio.DBusCallFlags.NONE : Gio.DBusCallFlags.NO_AUTO_START;
        try {
            Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE, 'ListSources', null,
                new GLib.VariantType('(aa{sv})'), flags, CALL_TIMEOUT_MS, cancellable,
                (conn, res) => {
                    try {
                        const [list] = conn.call_finish(res).deepUnpack();
                        resolve(list.map(d => ({
                            name: d.name?.deepUnpack() ?? '',
                            description: d.description?.deepUnpack() ?? '',
                            default: d.default?.deepUnpack() ?? false,
                        })));
                    } catch (e) {
                        resolve(!autoStart && classify(e, false) === 'not-installed' ? null : []);
                    }
                });
        } catch {
            resolve([]);
        }
    });
}

function classify(e, log = true) {
    const name = Gio.DBusError.is_remote_error(e) ? Gio.DBusError.get_remote_error(e) : '';
    if (name === 'org.freedesktop.DBus.Error.ServiceUnknown' ||
        name === 'org.freedesktop.DBus.Error.NameHasNoOwner')
        return 'not-installed';
    if (name === 'org.freedesktop.DBus.Error.Spawn.ExecFailed' ||
        name === 'org.freedesktop.DBus.Error.Spawn.ChildExited' ||
        name === 'org.freedesktop.DBus.Error.Spawn.ChildSignaled')
        return 'spawn-failed';
    if (name === BUSY_ERROR)
        return 'busy';
    if (name === 'org.freedesktop.DBus.Error.NoReply' ||
        name === 'org.freedesktop.DBus.Error.Timeout' ||
        e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
        return 'timeout';
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return 'cancelled';
    if (log)
        logError(e, 'voice-hold: engine call');
    return `error: ${e.message}`;
}
