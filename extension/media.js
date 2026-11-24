// SPDX-License-Identifier: GPL-2.0-or-later

// What happens to the sound of the other applications while one dictates
// (`media-during`):
//   pause  the media players that are playing are paused, and exactly those
//          resume afterwards (MPRIS on the session bus). A player that was
//          already paused, or that the user paused or started meanwhile, is
//          left alone.
//   lower  everything that plays goes down to LOWER of its volume and comes
//          back afterwards (GNOME's own mixer, the one of the volume
//          slider). Works for what has no pause button: a call, a game, a
//          video in a browser tab.
//   nothing
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MPRIS = 'org.mpris.MediaPlayer2.';
const PATH = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const TIMEOUT_MS = 500;

function call(name, iface, method, params = null) {
    return new Promise(resolve => {
        Gio.DBus.session.call(name, PATH, iface, method, params, null,
            Gio.DBusCallFlags.NO_AUTO_START, TIMEOUT_MS, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch {
                    resolve(null);
                }
            });
    });
}

async function playbackStatus(name) {
    const r = await call(name, 'org.freedesktop.DBus.Properties', 'Get', new GLib.Variant('(ss)', [PLAYER, 'PlaybackStatus']));
    return r ? r.deepUnpack()[0].deepUnpack() : '';
}

async function players() {
    const r = await new Promise(resolve => {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, null, Gio.DBusCallFlags.NONE, TIMEOUT_MS, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch {
                    resolve(null);
                }
            });
    });
    return r ? r.deepUnpack()[0].filter(n => n.startsWith(MPRIS)) : [];
}

// Share of its volume a stream keeps while one dictates.
export const LOWER = 0.25;

// Lower what plays, give it back afterwards. `getControl` returns GNOME's
// mixer (Gvc.MixerControl); it is only asked when needed.
export class Ducker {
    constructor(getControl) {
        this._getControl = getControl;
        this._lowered = new Map();     // stream id -> {before, during}
    }

    lower() {
        let streams = [];
        try {
            streams = this._getControl().get_sink_inputs();
        } catch (e) {
            console.warn(`voice-hold: mixer: ${e.message}`);
        }
        for (const s of streams) {
            // Not our own start and stop sounds (event streams), not what is
            // silent already, not what a dictation still holds down.
            if (s.is_event_stream || s.get_is_muted() || this._lowered.has(s.get_id()))
                continue;
            const before = s.get_volume();
            const during = Math.round(before * LOWER);
            if (before <= 0 || during === before)
                continue;
            s.set_volume(during);
            s.push_volume();
            this._lowered.set(s.get_id(), {before, during});
        }
    }

    restore() {
        const lowered = this._lowered;
        this._lowered = new Map();
        if (!lowered.size)
            return;
        let control;
        try {
            control = this._getControl();
        } catch {
            return;
        }
        for (const [id, {before, during}] of lowered) {
            const s = control.lookup_stream_id(id);
            // Gone, or its volume was moved by hand meanwhile: left as it is.
            if (!s || s.get_volume() !== during)
                continue;
            s.set_volume(before);
            s.push_volume();
        }
    }
}

// The old switch (`pause-media`) switched off becomes "nothing", once.
export function migrate(settings) {
    if (settings.get_user_value('pause-media')?.unpack() === false && !settings.get_user_value('media-during'))
        settings.set_string('media-during', 'nothing');
    settings.reset('pause-media');
}

export class MediaPause {
    constructor(settings, getControl = null) {
        this._settings = settings;
        this._ducker = getControl ? new Ducker(getControl) : null;
        this._paused = [];
        this._epoch = 0;
        migrate(settings);
    }

    async pause() {
        const epoch = ++this._epoch;
        this._paused = [];
        const mode = this._settings.get_string('media-during');
        if (mode === 'lower') {
            this._ducker?.lower();
            return;
        }
        if (mode !== 'pause')
            return;
        for (const name of await players()) {
            if (await playbackStatus(name) !== 'Playing')
                continue;
            if (epoch !== this._epoch)
                return;                   // resumed meanwhile: leave them playing
            await call(name, PLAYER, 'Pause');
            if (epoch !== this._epoch) {
                // The dictation ended while this one was being paused.
                await call(name, PLAYER, 'Play');
                return;
            }
            this._paused.push(name);
        }
    }

    async resume() {
        this._epoch++;
        this._ducker?.restore();
        const names = this._paused;
        this._paused = [];
        for (const name of names) {
            if (await playbackStatus(name) === 'Paused')
                await call(name, PLAYER, 'Play');
        }
    }
}
