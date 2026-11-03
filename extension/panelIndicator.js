import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {listSources} from './engine.js';

// Top-bar indicator: the microphone icon plus a menu with a toggle bound to
// the `enabled` setting, the microphone choice and the preferences.
export const VoiceHoldIndicator = GObject.registerClass(
class VoiceHoldIndicator extends PanelMenu.Button {
    _init(settings, iconPath, openPreferences, gettext) {
        const _ = gettext || (s => s);
        super._init(0.0, _('Voice Hold'));

        this._settings = settings;
        this._openPreferences = openPreferences;

        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon',
        }));

        this._toggle = new PopupMenu.PopupSwitchMenuItem(
            _('Enabled'), this._settings.get_boolean('enabled'));
        this._toggle.connectObject('toggled', (_item, state) => {
            if (this._settings.get_boolean('enabled') !== state)
                this._settings.set_boolean('enabled', state);
        }, this);
        this.menu.addMenuItem(this._toggle);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Microphone submenu, filled from the engine each time the menu opens.
        this._micMenu = new PopupMenu.PopupSubMenuMenuItem(_('Microphone'));
        this.menu.addMenuItem(this._micMenu);
        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._fillMicrophones(_);
        }, this);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
        prefsItem.connectObject('activate', () => this._openPreferences(), this);
        this.menu.addMenuItem(prefsItem);

        this._settings.connectObject('changed::enabled', () => {
            this._toggle.setToggleState(this._settings.get_boolean('enabled'));
        }, this);
    }

    // Opening the menu must not spawn the engine (NO_AUTO_START): when it is
    // not running the list only offers the system default.
    _fillMicrophones(_) {
        listSources(null, {autoStart: false}).then(found => {
            if (!this._micMenu || !this._settings)
                return;
            const sources = found ?? [];
            this._micMenu.menu.removeAll();
            const current = this._settings.get_string('microphone');
            const def = sources.find(s => s.default);
            const entries = [{name: '', description: def ? _('System default (%s)').format(def.description) : _('System default')}];
            for (const s of sources)
                entries.push({name: s.name, description: s.description});
            if (current && !entries.some(e => e.name === current))
                entries.push({name: current, description: current});
            if (found === null)
                this._micMenu.label.text = _('Microphone (engine not started)');
            else if (!sources.length)
                this._micMenu.label.text = _('Microphone (engine not reachable)');
            else
                this._micMenu.label.text = _('Microphone');
            for (const e of entries) {
                const item = new PopupMenu.PopupMenuItem(e.description);
                item.setOrnament(e.name === current ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
                item.connectObject('activate', () => this._settings?.set_string('microphone', e.name), this);
                this._micMenu.menu.addMenuItem(item);
            }
        });
    }

    destroy() {
        this.menu.disconnectObject(this);
        this._micMenu = null;
        this._settings.disconnectObject(this);
        this._settings = null;
        this._openPreferences = null;
        this._toggle = null;
        super.destroy();
    }
});

export function addIndicator(uuid, settings, iconPath, openPreferences, gettext) {
    const indicator = new VoiceHoldIndicator(settings, iconPath, openPreferences, gettext);
    Main.panel.addToStatusArea(uuid, indicator);
    return indicator;
}
