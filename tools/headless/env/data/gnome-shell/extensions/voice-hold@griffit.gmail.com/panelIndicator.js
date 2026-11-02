import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Top-bar indicator: the microphone icon plus a menu with a toggle bound to
// the `enabled` setting, a "Dictate" item and the preferences.
export const VoiceHoldIndicator = GObject.registerClass(
class VoiceHoldIndicator extends PanelMenu.Button {
    _init(settings, iconPath, openPreferences, dictate, gettext) {
        const _ = gettext || (s => s);
        super._init(0.0, _('Voice Hold'));

        this._settings = settings;
        this._openPreferences = openPreferences;
        this._dictate = dictate;

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

        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
        prefsItem.connectObject('activate', () => this._openPreferences(), this);
        this.menu.addMenuItem(prefsItem);

        this._settings.connectObject('changed::enabled', () => {
            this._toggle.setToggleState(this._settings.get_boolean('enabled'));
        }, this);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._settings = null;
        this._openPreferences = null;
        this._dictate = null;
        this._toggle = null;
        super.destroy();
    }
});

export function addIndicator(uuid, settings, iconPath, openPreferences, dictate, gettext) {
    const indicator = new VoiceHoldIndicator(settings, iconPath, openPreferences, dictate, gettext);
    Main.panel.addToStatusArea(uuid, indicator);
    return indicator;
}
