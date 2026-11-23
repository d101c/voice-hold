// SPDX-License-Identifier: GPL-2.0-or-later

// When the engine listens for the wake word: switched on (`wake-enabled`),
// and none of the reasons to pause it. The screen is locked; another
// application records (a call would wake the dictation); on battery, unless
// `wake-on-battery`. Each change asks the engine again (engine.listen()).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {pauseReason, phrasesOf} from './wakeRules.js';

const OUR_APP = 'org.griffit.VoiceHold';
const RETRY_MS = 3000;
const MAX_RETRIES = 3;

export class WakeControl {
    constructor(settings, engine, onChange = null) {
        this._settings = settings;
        this._engine = engine;
        this._onChange = onChange;
        this._listening = false;
        this._key = '';
        this._retries = 0;
        this._retryId = 0;
        this._onBattery = false;
        this._error = '';
        this._upower = null;
        this._mixer = null;

        settings.connectObject(
            'changed::wake-enabled', () => this.sync(),
            'changed::wake-phrase', () => this.sync(),
            'changed::wake-on-battery', () => this.sync(),
            'changed::wake-sensitivity', () => this.sync(),
            'changed::microphone', () => this.sync(),
            this);
        Main.sessionMode.connectObject('updated', () => this.sync(), this);
        this._watchBattery();
        this._watchRecordings();
        this.sync();
    }

    destroy() {
        if (this._retryId) {
            GLib.Source.remove(this._retryId);
            this._retryId = 0;
        }
        this._settings.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._mixer?.disconnectObject(this);
        this._mixer = null;
        this._upower?.disconnectObject(this);
        this._upower = null;
        if (this._listening)
            this._engine.listen({enabled: false});
        this._listening = false;
        this._settings = null;
    }

    // '' while listening, else why not: off, locked, recording, battery, or
    // the engine's reason (wake-model-missing, audio: …).
    get state() {
        return this._error || this._reason();
    }

    // The engine came back (it died, or exited): listen again if we were.
    engineOwner(hasOwner) {
        if (!hasOwner && this._listening) {
            this._listening = false;
            this._key = '';
            this._scheduleRetry();
        }
    }

    _reason() {
        return pauseReason({
            enabled: this._settings.get_boolean('wake-enabled'),
            locked: Main.sessionMode.isLocked,
            onBattery: this._onBattery,
            onBatteryOk: this._settings.get_boolean('wake-on-battery'),
            othersRecording: this._othersRecording(),
        });
    }

    sync() {
        if (!this._settings)
            return;
        const want = this._reason() === '';
        const options = {
            enabled: want,
            phrases: phrasesOf(this._settings.get_string('wake-phrase')),
            source: this._settings.get_string('microphone'),
            sensitivity: this._settings.get_double('wake-sensitivity'),
        };
        const key = JSON.stringify(options);
        if (key === this._key)
            return;
        this._key = key;
        if (!want && !this._listening) {
            this._error = '';
            this._onChange?.();
            return;
        }
        this._engine.listen(options).then(err => {
            if (!this._settings || this._key !== key)
                return;
            // The engine fetches the small model first, then listens by itself.
            const downloading = err === 'wake-downloading';
            this._listening = want && (!err || downloading);
            this._error = want && !downloading ? err : '';
            if (err && want && !downloading)
                this._scheduleRetry();
            else
                this._retries = 0;
            this._onChange?.();
        });
    }

    _scheduleRetry() {
        if (this._retryId || this._retries >= MAX_RETRIES || this._error === 'wake-model-missing')
            return;
        this._retries++;
        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_MS, () => {
            this._retryId = 0;
            this._key = '';
            this.sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    // -- battery (UPower) ------------------------------------------------------

    _watchBattery() {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower', null, (_o, res) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    if (!this._settings)
                        return;
                    this._upower = proxy;
                    const read = () => {
                        this._onBattery = !!proxy.get_cached_property('OnBattery')?.unpack();
                        this.sync();
                    };
                    proxy.connectObject('g-properties-changed', read, this);
                    read();
                } catch (e) {
                    console.warn(`voice-hold: UPower: ${e.message}`);
                }
            });
    }

    // -- other applications recording (a call) ----------------------------------

    _watchRecordings() {
        try {
            this._mixer = getMixerControl();
            this._mixer.connectObject(
                'stream-added', () => this.sync(),
                'stream-removed', () => this.sync(),
                this);
        } catch (e) {
            console.warn(`voice-hold: mixer: ${e.message}`);
            this._mixer = null;
        }
    }

    _othersRecording() {
        if (!this._mixer)
            return false;
        try {
            return this._mixer.get_streams().some(s => s instanceof Gvc.MixerSourceOutput &&
                s.get_application_id() !== OUR_APP && !/peak/i.test(s.get_name() ?? ''));
        } catch {
            return false;
        }
    }
}
