// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {accelLabel} from './accelLabel.js';
import {accentColor} from './accentColor.js';
import {EngineClient} from './engine.js';
import {speechLowMemory} from './memoryText.js';
import {modelState, statusLine} from './modelState.js';

// Top-bar indicator. The icon tells the state of the speech model
// (modelState.js): normal when it is in memory and the dictation starts at
// once, dimmed when it is asleep and the first words will wait a few
// seconds, breathing while it loads, crossed out while the shortcut is
// switched off, in the accent colour while the microphone is in use.
//
// The menu: that state in words with "Load now" or "Release the memory",
// the `enabled` toggle, the microphone (from GNOME's own mixer, so the list
// is there whether the engine runs or not), the last voice commands when
// they are switched on (setCommands), and the preferences.

const ASLEEP_OPACITY = 105;
const BREATHE_MS = 700;
const BUSY_STATES = ['loading', 'listening', 'decoding'];
export const VoiceHoldIndicator = GObject.registerClass(
class VoiceHoldIndicator extends PanelMenu.Button {
    _init(settings, iconPath, openPreferences, gettext, getDictation = () => null) {
        const _ = gettext;
        super._init(0.0, _('Voice Hold'));

        this._settings = settings;
        this._openPreferences = openPreferences;
        this._getDictation = getDictation;
        this._gettext = _;
        this._commands = null;
        this._recentMenu = null;
        this._gicon = Gio.icon_new_for_string(iconPath);
        this._offIcon = Gio.ThemedIcon.new('microphone-disabled-symbolic');
        this._model = '';            // the engine's Model, '' when unknown
        this._inUse = false;         // a dictation or a command is listening
        this._state = '';
        this._unloadIn = -1;         // seconds before the model is released

        this._icon = new St.Icon({gicon: this._gicon, style_class: 'system-status-icon'});
        this.add_child(this._icon);

        // Its own connection to the engine: signals only, never starts it.
        this._engine = new EngineClient({
            Owner: has => this._onOwner(has),
            Model: m => {
                this._model = m;
                this._sync();
            },
            State: st => {
                this._inUse = BUSY_STATES.includes(st);
                this._sync();
            },
        });

        // The Shell may dispose of the bar without calling destroy() (at
        // exit): stop listening to the engine then too.
        this.connect('destroy', () => {
            this._engine?.destroy();
            this._engine = null;
            this._icon = null;
        });

        // What to do, said at the top of the menu, with the shortcut as it
        // is set now.
        this._howItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._howItem);
        const how = () => {
            const accel = accelLabel(this._settings.get_strv('dictation-shortcut')[0] ?? '', _);
            this._howItem.label.text = accel ? _('Hold %s and speak').format(accel) : _('Choose a shortcut in the preferences');
        };
        this._settings.connectObject('changed::dictation-shortcut', how, this);
        how();
        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._statusItem);
        this._modelItem = new PopupMenu.PopupMenuItem('');
        this._modelItem.connectObject('activate', () => this._toggleModel(), this);
        this.menu.addMenuItem(this._modelItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._toggle = new PopupMenu.PopupSwitchMenuItem(
            _('Enabled'), this._settings.get_boolean('enabled'));
        this._toggle.connectObject('toggled', (_item, state) => {
            if (this._settings.get_boolean('enabled') !== state)
                this._settings.set_boolean('enabled', state);
        }, this);
        this.menu.addMenuItem(this._toggle);

        // The start and end sounds, one click away.
        this._soundsToggle = new PopupMenu.PopupSwitchMenuItem(
            _('Sounds'), this._settings.get_boolean('sounds'));
        this._soundsToggle.connectObject('toggled', (_item, state) => {
            if (this._settings.get_boolean('sounds') !== state)
                this._settings.set_boolean('sounds', state);
        }, this);
        this.menu.addMenuItem(this._soundsToggle);
        this._settings.connectObject('changed::sounds', () =>
            this._soundsToggle.setToggleState(this._settings.get_boolean('sounds')), this);

        // The menu closes first, so the paste goes to the window under it.
        this._pasteItem = new PopupMenu.PopupMenuItem(_('Paste the last dictation'));
        this._pasteItem.connectObject('activate', () => this._getDictation()?.pasteLast(), this);
        this.menu.addMenuItem(this._pasteItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Microphone submenu, filled from the engine each time the menu opens.
        this._micMenu = new PopupMenu.PopupSubMenuMenuItem(_('Microphone'));
        this.menu.addMenuItem(this._micMenu);
        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (open) {
                this._pasteItem.visible = !!this._getDictation()?.hasLast;
                this._refreshStatus();
                this._fillMicrophones(_);
                this._fillRecent();
            }
        }, this);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
        prefsItem.connectObject('activate', () => this._openPreferences(), this);
        this.menu.addMenuItem(prefsItem);

        this._settings.connectObject('changed::enabled', () => {
            this._toggle.setToggleState(this._settings.get_boolean('enabled'));
            this._sync();
        }, this);
        this._sync();
        this._refreshStatus();
    }

    _onOwner(hasOwner) {
        this._model = '';
        this._unloadIn = -1;
        this._inUse = false;
        this._sync();
        // Already running (an earlier dictation): ask where its model is.
        if (hasOwner)
            this._refreshStatus();
    }

    _refreshStatus() {
        this._engine?.status().then(st => {
            if (!this._engine)
                return;
            this._model = st?.model ?? '';
            this._unloadIn = st?.unload_in_s ?? -1;
            this._sync();
        });
    }

    _sync() {
        if (!this._icon)
            return;
        const state = modelState({
            enabled: this._settings.get_boolean('enabled'),
            running: this._engine?.running ?? false,
            model: this._model,
        });
        const _ = this._gettext;
        this._statusItem.label.text = statusLine(state, state === 'ready' ? this._unloadIn : -1, _);
        this._modelItem.label.text = state === 'ready' ? _('Release the memory') : _('Load now');
        this._modelItem.setSensitive(state === 'ready' ? !this._inUse : state === 'asleep');

        const changed = state !== this._state;
        this._state = state;
        this._icon.gicon = state === 'disabled' ? this._offIcon : this._gicon;
        this._icon.set_style(this._inUse && state !== 'disabled' ? `color: ${accentColor()};` : null);
        if (!changed)
            return;
        this._icon.remove_all_transitions();
        this._icon.opacity = state === 'asleep' ? ASLEEP_OPACITY : 255;
        // One repeating transition (see hud.js): never a chain of them.
        if (state === 'loading') {
            this._icon.opacity = 255;
            this._icon.ease({
                opacity: 70,
                duration: BREATHE_MS,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: -1,
                autoReverse: true,
            });
        }
    }

    _toggleModel() {
        const _ = this._gettext;
        if (this._state === 'ready') {
            this._engine.unload().then(released => {
                if (released === false)
                    Main.notify(_('Voice Hold'), _('The speech model is in use — try again after the dictation'));
            });
            return;
        }
        this._engine.load(this._settings.get_int('keep-loaded-min') * 60).then(err => {
            if (!err || err === 'cancelled' || !this._settings)
                return;
            Main.notify(_('Voice Hold'), speechLowMemory(err, _) ?? _('The speech model could not be loaded: %s').format(err));
        });
    }

    // From GNOME's mixer, as in its sound menu: the engine records from the
    // same PipeWire nodes, by name. Monitors of outputs are left out.
    _fillMicrophones(_) {
        if (!this._micMenu || !this._settings)
            return;
        let sources = [];
        let def = null;
        try {
            const control = getMixerControl();
            def = control.get_default_source();
            sources = control.get_sources()
                .filter(s => s.get_name() && !s.get_name().endsWith('.monitor'))
                .map(s => ({name: s.get_name(), description: s.get_description() || s.get_name()}));
        } catch (e) {
            logError(e, 'voice-hold: microphones');
        }
        this._micMenu.menu.removeAll();
        const current = this._settings.get_string('microphone');
        const entries = [{name: '', description: def ? _('System default (%s)').format(def.get_description()) : _('System default')}];
        entries.push(...sources);
        if (current && !entries.some(e => e.name === current))
            entries.push({name: current, description: current});
        const chosen = entries.find(e => e.name === current);
        this._micMenu.label.text = current && chosen ? _('Microphone: %s').format(chosen.description) : _('Microphone');
        for (const e of entries) {
            const item = new PopupMenu.PopupMenuItem(e.description);
            item.setOrnament(e.name === current ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            item.connectObject('activate', () => this._settings?.set_string('microphone', e.name), this);
            this._micMenu.menu.addMenuItem(item);
        }
    }

    // The voice commands' corner of the menu: a submenu of the last requests,
    // filled each time the menu opens; activating one shows it again in the
    // commands' pill. `commands` has recent() (a promise of [{label, entry}])
    // and recall(entry); null takes the submenu away. Not called at all
    // while the commands are switched off.
    setCommands(commands) {
        this._commands = commands;
        if (commands && !this._recentMenu) {
            this._recentMenu = new PopupMenu.PopupSubMenuMenuItem(this._gettext('Recent commands'));
            // Right under the microphone, above the separator and Preferences.
            const items = this.menu._getMenuItems();
            this.menu.addMenuItem(this._recentMenu, items.indexOf(this._micMenu) + 1);
        } else if (!commands && this._recentMenu) {
            this._recentMenu.destroy();
            this._recentMenu = null;
        }
    }

    _fillRecent() {
        const commands = this._commands;
        if (!commands || !this._recentMenu)
            return;
        commands.recent().then(found => {
            if (!this._recentMenu || this._commands !== commands)
                return;
            const menu = this._recentMenu.menu;
            menu.removeAll();
            if (!found.length) {
                menu.addMenuItem(new PopupMenu.PopupMenuItem(this._gettext('Nothing yet'), {reactive: false}));
                return;
            }
            for (const {label, entry} of found) {
                const item = new PopupMenu.PopupMenuItem(label);
                item.connectObject('activate', () => this._commands?.recall(entry), this);
                menu.addMenuItem(item);
            }
        }).catch(e => logError(e, 'voice-hold: recent commands'));
    }

    destroy() {
        this._engine?.destroy();
        this._engine = null;
        this._icon?.remove_all_transitions();
        this.menu.disconnectObject(this);
        this._commands = null;
        this._recentMenu = null;
        this._gettext = null;
        this._micMenu = null;
        this._settings.disconnectObject(this);
        this._settings = null;
        this._openPreferences = null;
        this._toggle = null;
        this._icon = null;
        super.destroy();
    }
});

export function addIndicator(uuid, settings, iconPath, openPreferences, gettext, getDictation = () => null) {
    const indicator = new VoiceHoldIndicator(settings, iconPath, openPreferences, gettext, getDictation);
    Main.panel.addToStatusArea(uuid, indicator);
    return indicator;
}
