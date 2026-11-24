// SPDX-License-Identifier: GPL-2.0-or-later

// Pause the media players that are playing while one dictates, and resume
// exactly those afterwards (MPRIS on the session bus). A player that was
// already paused, or that the user paused or started meanwhile, is left
// alone.
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

export class MediaPause {
    constructor(settings) {
        this._settings = settings;
        this._paused = [];
        this._epoch = 0;
    }

    async pause() {
        const epoch = ++this._epoch;
        this._paused = [];
        if (!this._settings.get_boolean('pause-media'))
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
        const names = this._paused;
        this._paused = [];
        for (const name of names) {
            if (await playbackStatus(name) === 'Paused')
                await call(name, PLAYER, 'Play');
        }
    }
}
