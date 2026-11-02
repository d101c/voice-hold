import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BUS_NAME = 'org.griffit.VoiceHold';
const OBJECT_PATH = '/org/griffit/VoiceHold';
const INTERFACE = 'org.griffit.VoiceHold';
const INSTALL_CMD = 'pipx install git+https://github.com/d101c/voice-hold#subdirectory=engine && voice-hold-engine setup';

export default class VoiceHoldPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('Voice Hold'),
            icon_name: 'audio-input-microphone-symbolic',
        });
        window.add(page);
        this._buildEngineGroup(page, window);
        this._buildGestureGroup(page, settings);
        this._buildPolishGroup(page, settings);
        this._buildAppearanceGroup(page, settings);
    }

    // -- engine -----------------------------------------------------------

    _buildEngineGroup(page, window) {
        const group = new Adw.PreferencesGroup({
            title: _('Engine'),
            description: _('Speech recognition runs on this computer, offline, in a separate helper program.'),
        });
        page.add(group);

        const statusRow = new Adw.ActionRow({title: _('Status'), subtitle: _('Checking…')});
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Check again')});
        refresh.add_css_class('flat');
        statusRow.add_suffix(refresh);
        group.add(statusRow);

        const cmdRow = new Adw.ActionRow({title: _('Install command')});
        const copy = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Copy')});
        copy.add_css_class('flat');
        copy.connect('clicked', () => {
            const clipboard = Gdk.Display.get_default().get_clipboard();
            clipboard.set(INSTALL_CMD);
            window.add_toast(new Adw.Toast({title: _('Copied'), timeout: 2}));
        });
        cmdRow.add_suffix(copy);
        group.add(cmdRow);
        const cmdLabel = new Gtk.Label({
            label: INSTALL_CMD,
            selectable: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: 0,
            margin_top: 6,
            margin_start: 12,
            margin_end: 12,
        });
        cmdLabel.add_css_class('monospace');
        cmdLabel.add_css_class('dim-label');
        group.add(cmdLabel);

        const check = () => {
            statusRow.set_subtitle(_('Checking…'));
            this._engineStatus().then(s => statusRow.set_subtitle(s));
        };
        refresh.connect('clicked', check);
        check();
    }

    _engineStatus() {
        return new Promise(resolve => {
            try {
                Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE, 'Status', null,
                    new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, 15000, null,
                    (conn, res) => {
                        try {
                            const [dict] = conn.call_finish(res).deepUnpack();
                            const get = k => dict[k]?.deepUnpack();
                            if (!get('models_ready'))
                                resolve(_('Engine %s found, models missing — run: voice-hold-engine setup').format(get('version')));
                            else
                                resolve(_('Ready — engine %s, models installed').format(get('version')));
                        } catch (e) {
                            const name = Gio.DBusError.is_remote_error(e) ? Gio.DBusError.get_remote_error(e) : '';
                            if (name === 'org.freedesktop.DBus.Error.ServiceUnknown')
                                resolve(_('Not installed — run the command below, then check again'));
                            else if (name.startsWith('org.freedesktop.DBus.Error.Spawn'))
                                resolve(_('Installed but failed to start: %s').format(e.message));
                            else
                                resolve(e.message);
                        }
                    });
            } catch (e) {
                resolve(e.message);
            }
        });
    }

    // -- gesture ----------------------------------------------------------

    _buildGestureGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Gesture'),
            description: _('Hold the shortcut and speak; release to stop. A quick tap keeps listening hands-free.'),
        });
        page.add(group);

        const enabledRow = new Adw.SwitchRow({title: _('Enabled')});
        group.add(enabledRow);
        settings.bind('enabled', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        group.add(this._shortcutRow(settings));

        const modes = ['auto', 'hold', 'toggle'];
        const modeRow = new Adw.ComboRow({
            title: _('Mode'),
            subtitle: _('Auto: hold or tap. Hold: release always stops. Toggle: the shortcut starts and stops.'),
            model: Gtk.StringList.new([_('Hold or tap'), _('Hold only'), _('Toggle only')]),
        });
        modeRow.set_selected(Math.max(0, modes.indexOf(settings.get_string('mode'))));
        modeRow.connect('notify::selected', () => settings.set_string('mode', modes[modeRow.get_selected()]));
        group.add(modeRow);

        const tapRow = new Adw.SpinRow({
            title: _('Tap threshold (ms)'),
            subtitle: _('Releasing the modifier sooner than this counts as a tap.'),
            adjustment: new Gtk.Adjustment({lower: 150, upper: 1000, step_increment: 50}),
        });
        group.add(tapRow);
        settings.bind('tap-ms', tapRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const silenceRow = new Adw.SpinRow({
            title: _('Stop after silence (s)'),
            subtitle: _('Hands-free mode only. 0 = never.'),
            digits: 1,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 60, step_increment: 0.5}),
        });
        group.add(silenceRow);
        settings.bind('silence-stop-s', silenceRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    }

    _shortcutRow(settings) {
        const row = new Adw.ActionRow({title: _('Shortcut'), activatable: true});
        const label = new Gtk.ShortcutLabel({
            disabled_text: _('Not set'),
            accelerator: settings.get_strv('dictation-shortcut')[0] ?? '',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(label);
        settings.connect('changed::dictation-shortcut', () => label.set_accelerator(settings.get_strv('dictation-shortcut')[0] ?? ''));

        row.connect('activated', () => {
            const dialog = new Adw.Window({
                modal: true,
                transient_for: row.get_root(),
                title: _('Set shortcut'),
                default_width: 360,
                default_height: 160,
                resizable: false,
            });
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 24, margin_bottom: 24, margin_start: 24, margin_end: 24, valign: Gtk.Align.CENTER});
            box.append(new Gtk.Label({label: _('Press the new shortcut, with a modifier (Super, Ctrl, Alt).\nEscape cancels, Backspace clears.'), justify: Gtk.Justification.CENTER, wrap: true}));
            const current = new Gtk.ShortcutLabel({accelerator: settings.get_strv('dictation-shortcut')[0] ?? '', halign: Gtk.Align.CENTER});
            box.append(current);
            dialog.set_content(box);

            const ctl = new Gtk.EventControllerKey();
            ctl.connect('key-pressed', (_c, keyval, _keycode, state) => {
                const mask = state & Gtk.accelerator_get_default_mod_mask();
                if (keyval === Gdk.KEY_Escape) {
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if (keyval === Gdk.KEY_BackSpace) {
                    settings.set_strv('dictation-shortcut', []);
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if (!mask || !Gtk.accelerator_valid(keyval, mask))
                    return Gdk.EVENT_STOP;
                settings.set_strv('dictation-shortcut', [Gtk.accelerator_name(keyval, mask)]);
                dialog.close();
                return Gdk.EVENT_STOP;
            });
            dialog.add_controller(ctl);
            dialog.present();
        });
        return row;
    }

    // -- polish -----------------------------------------------------------

    _buildPolishGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Optional: polish with a local LLM'),
            description: _('Off by default. When on, each finished block is sent to Ollama on this computer to fix punctuation and casing. Falls back to the raw text if Ollama does not answer within 2.5 s.'),
        });
        page.add(group);

        const sw = new Adw.SwitchRow({title: _('Polish with Ollama')});
        group.add(sw);
        settings.bind('polish', sw, 'active', Gio.SettingsBindFlags.DEFAULT);

        const model = new Adw.EntryRow({title: _('Model')});
        group.add(model);
        settings.bind('polish-model', model, 'text', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('polish', model, 'sensitive', Gio.SettingsBindFlags.GET);

        const url = new Adw.EntryRow({title: _('Ollama URL')});
        group.add(url);
        settings.bind('polish-url', url, 'text', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('polish', url, 'sensitive', Gio.SettingsBindFlags.GET);
    }

    // -- appearance -------------------------------------------------------

    _buildAppearanceGroup(page, settings) {
        const group = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(group);

        const hud = new Adw.SwitchRow({
            title: _('Show the pill while dictating'),
            subtitle: _('Microphone level and live text next to the cursor.'),
        });
        group.add(hud);
        settings.bind('show-hud', hud, 'active', Gio.SettingsBindFlags.DEFAULT);

        const ind = new Adw.SwitchRow({title: _('Top-bar indicator')});
        group.add(ind);
        settings.bind('show-indicator', ind, 'active', Gio.SettingsBindFlags.DEFAULT);
    }
}
