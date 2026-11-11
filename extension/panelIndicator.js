import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {listSources} from './engine.js';

// Top-bar indicator: the microphone icon plus a menu with a toggle bound to
// the `enabled` setting, the microphone choice and the preferences. When the
// voice commands are switched on, their last requests too (setCommands).
export const VoiceHoldIndicator = GObject.registerClass(
class VoiceHoldIndicator extends PanelMenu.Button {
    _init(settings, iconPath, openPreferences, gettext) {
        const _ = gettext || (s => s);
        super._init(0.0, _('Voice Hold'));

        this._settings = settings;
        this._openPreferences = openPreferences;
        this._gettext = _;
        this._commands = null;
        this._recentMenu = null;

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);
        this._syncIcon();

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
            if (open) {
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
            this._syncIcon();
        }, this);
    }

    // Dimmed while the shortcut is switched off, so the bar says why nothing
    // happens.
    _syncIcon() {
        this._icon.opacity = this._settings.get_boolean('enabled') ? 255 : 110;
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

export function addIndicator(uuid, settings, iconPath, openPreferences, gettext) {
    const indicator = new VoiceHoldIndicator(settings, iconPath, openPreferences, gettext);
    Main.panel.addToStatusArea(uuid, indicator);
    return indicator;
}
