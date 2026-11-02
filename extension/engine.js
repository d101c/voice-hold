import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// D-Bus client of voice-hold-engine. The service is activatable: the first
// method call starts it; when it is not installed the call fails with
// ServiceUnknown and we report `not-installed`.

export const BUS_NAME = 'org.griffit.VoiceHold';
export const OBJECT_PATH = '/org/griffit/VoiceHold';
export const INTERFACE = 'org.griffit.VoiceHold';

const IFACE_XML = `
<node>
  <interface name="${INTERFACE}">
    <method name="Start"><arg type="a{sv}" name="options" direction="in"/></method>
    <method name="Stop"/>
    <method name="Cancel"/>
    <method name="Status"><arg type="a{sv}" name="status" direction="out"/></method>
    <method name="Quit"/>
    <signal name="State"><arg type="s" name="state"/></signal>
    <signal name="Level"><arg type="d" name="level"/></signal>
    <signal name="Speech"><arg type="b" name="speaking"/></signal>
    <signal name="Partial"><arg type="s" name="text"/></signal>
    <signal name="Final"><arg type="s" name="text"/></signal>
    <signal name="Stopped"><arg type="s" name="reason"/></signal>
    <signal name="Error"><arg type="s" name="message"/></signal>
  </interface>
</node>`;

const Proxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);

export class EngineClient {
    // handlers: {State, Level, Speech, Partial, Final, Stopped, Error}
    constructor(handlers) {
        this._handlers = handlers;
        this._proxy = null;
        this._signalId = 0;
        this._cancellable = new Gio.Cancellable();
        this._connect();
    }

    _connect() {
        try {
            this._proxy = new Proxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
                (proxy, error) => {
                    if (error)
                        logError(error, 'voice-hold: proxy');
                }, this._cancellable,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION);
            this._signalId = this._proxy.connect('g-signal', (_p, _sender, name, params) => {
                const fn = this._handlers[name];
                if (fn)
                    fn(...params.deepUnpack());
            });
        } catch (e) {
            logError(e, 'voice-hold: proxy');
        }
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxy && this._signalId)
            this._proxy.disconnect(this._signalId);
        this._signalId = 0;
        this._proxy = null;
        this._handlers = {};
    }

    // Resolves to null on success, or an error code string.
    _call(method, args = null) {
        return new Promise(resolve => {
            if (!this._proxy) {
                resolve('no-proxy');
                return;
            }
            this._proxy.call(method, args, Gio.DBusCallFlags.NONE, 15000, this._cancellable,
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
        return this._call('Stop');
    }

    cancel() {
        return this._call('Cancel');
    }

    // Resolves to {ok, status?, error?}.
    status() {
        return new Promise(resolve => {
            if (!this._proxy) {
                resolve({ok: false, error: 'no-proxy'});
                return;
            }
            this._proxy.call('Status', null, Gio.DBusCallFlags.NONE, 15000, this._cancellable,
                (proxy, res) => {
                    try {
                        const [dict] = proxy.call_finish(res).deepUnpack();
                        const status = {};
                        for (const [k, v] of Object.entries(dict))
                            status[k] = v.deepUnpack();
                        resolve({ok: true, status});
                    } catch (e) {
                        resolve({ok: false, error: classify(e)});
                    }
                });
        });
    }
}

function classify(e) {
    const name = Gio.DBusError.is_remote_error(e) ? Gio.DBusError.get_remote_error(e) : '';
    if (name === 'org.freedesktop.DBus.Error.ServiceUnknown' ||
        name === 'org.freedesktop.DBus.Error.NameHasNoOwner')
        return 'not-installed';
    if (name === 'org.freedesktop.DBus.Error.Spawn.ExecFailed' ||
        name === 'org.freedesktop.DBus.Error.Spawn.ChildExited' ||
        name === 'org.freedesktop.DBus.Error.Spawn.ChildSignaled')
        return 'spawn-failed';
    if (name === 'org.freedesktop.DBus.Error.NoReply' ||
        name === 'org.freedesktop.DBus.Error.Timeout' ||
        e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
        return 'timeout';
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return 'cancelled';
    logError(e, 'voice-hold: engine call');
    return `error: ${e.message}`;
}
