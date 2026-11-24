// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {buildCloudPage} from './cloudPage.js';
import {buildCommandsPage} from './commands/prefsPage.js';
import {listSources} from './engine.js';
import {buildSetupPage} from './setupPage.js';
import {buildUsagePage} from './usagePage.js';
import {buildModesPage} from './modesPage.js';
import {buildVocabPage} from './vocabPage.js';

const BUS_NAME = 'org.griffit.VoiceHold';
const OBJECT_PATH = '/org/griffit/VoiceHold';
const INTERFACE = 'org.griffit.VoiceHold';
const INSTALL_CMD = 'pipx install git+https://github.com/d101c/voice-hold#subdirectory=engine && voice-hold-engine setup';

// The pill, drawn: a dark capsule and its nine bars in the accent colour,
// moving as when one speaks. Still when animations are switched off.
function pillPreview() {
    const W = 168, H = 56, BARS = 9;
    const area = new Gtk.DrawingArea({content_width: W, content_height: H, halign: Gtk.Align.CENTER});
    let t = 0;
    area.set_draw_func((a, cr, w, h) => {
        const [hasAccent, accent] = a.get_style_context().lookup_color('accent_bg_color');
        const r = h / 2;
        cr.newPath();
        cr.arc(r, r, r, Math.PI / 2, 1.5 * Math.PI);
        cr.arc(w - r, r, r, 1.5 * Math.PI, Math.PI / 2);
        cr.closePath();
        cr.setSourceRGBA(0.11, 0.11, 0.11, 1);
        cr.fill();
        const bw = 5, gap = 4, x0 = (w - (BARS * bw + (BARS - 1) * gap)) / 2;
        if (hasAccent)
            cr.setSourceRGBA(accent.red, accent.green, accent.blue, 1);
        else
            cr.setSourceRGBA(1, 1, 1, 1);
        for (let i = 0; i < BARS; i++) {
            const mid = 1 - Math.abs(i - 4) / 6;
            const level = 0.5 + 0.5 * Math.sin(t * 5 + i * 1.3) * Math.sin(t * 1.7 + i * 0.6);
            const bh = 5 + 27 * mid * level;
            const x = x0 + i * (bw + gap), y = (h - bh) / 2;
            cr.newPath();
            cr.arc(x + bw / 2, y + bw / 2, bw / 2, Math.PI, 2 * Math.PI);
            cr.arc(x + bw / 2, y + bh - bw / 2, bw / 2, 0, Math.PI);
            cr.closePath();
            cr.fill();
        }
        cr.$dispose();
    });
    if (Gtk.Settings.get_default()?.gtk_enable_animations ?? true) {
        // Runs only while the widget is on screen.
        area.add_tick_callback((a, clock) => {
            t = clock.get_frame_time() / 1e6;
            a.queue_draw();
            return GLib.SOURCE_CONTINUE;
        });
    } else {
        t = 0.9;
    }
    return area;
}

export default class VoiceHoldPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('Dictation'),
            icon_name: 'audio-input-microphone-symbolic',
        });
        window.add(page);
        // The assistant installs the engine without a terminal; it is shown
        // first as long as the engine is missing.
        const [accel] = settings.get_strv('dictation-shortcut');
        let shortcut = null;
        if (accel) {
            const [ok, key, mods] = Gtk.accelerator_parse(accel);
            if (ok && key)
                shortcut = Gtk.accelerator_get_label(key, mods);
        }
        const setup = buildSetupPage(window, _, {
            components: ['voice'],
            shortcut,
            accelerator: shortcut ? accel : null,
            picture: `${this.path}/icons/pill.png`,
        });
        const vocab = buildVocabPage(settings, _);
        const modes = buildModesPage(settings, _);
        window.add(vocab);
        window.add(modes);
        // Optional voice commands: their own page, after those of the
        // dictation.
        const commands = buildCommandsPage(window, settings, _, (s, key) => this._shortcutRow(s, key));
        const cloud = buildCloudPage(window, settings, _);
        const usage = buildUsagePage(settings, _, ngettext);
        window.add(commands);
        window.add(cloud);
        window.add(usage);
        window.add(setup);
        // The test bench opens a given page (tools/headless): its number,
        // from 0, in VOICE_HOLD_PREFS_PAGE.
        const pages = [page, vocab, modes, commands, cloud, usage, setup];
        const wanted = pages[parseInt(GLib.getenv('VOICE_HOLD_PREFS_PAGE') ?? '', 10)];
        this._engineStatus().then(s => {
            if (wanted)
                window.set_visible_page(wanted);
            else if (!s.installed)
                window.set_visible_page(setup);
        });
        // What one does first, first; how it is made, last and folded.
        this._buildWelcomeGroup(page, settings);
        this._buildGestureGroup(page, settings);
        this._buildDuringGroup(page, settings);
        this._buildPolishGroup(page, settings);
        this._buildAppearanceGroup(page, settings);
        this._buildMicrophoneGroup(page, settings);
        this._buildWakeGroup(page, settings);
        this._buildEngineGroup(page, window);
        this._buildAboutGroup(page);
    }

    // -- engine -----------------------------------------------------------

    // -- welcome ----------------------------------------------------------

    // The gesture, said once, large: what the shortcut is and what to do
    // with it. It follows the shortcut when it is changed below.
    _buildWelcomeGroup(page, settings) {
        const group = new Adw.PreferencesGroup();
        page.add(group);
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 6,
            margin_bottom: 6,
            halign: Gtk.Align.CENTER,
        });
        box.append(pillPreview());
        const title = new Gtk.Label({css_classes: ['title-1'], wrap: true, justify: Gtk.Justification.CENTER, margin_top: 8});
        const caption = new Gtk.Label({
            label: _('The words appear where your cursor is, while you talk. Let go to stop, or tap once to keep your hands free.'),
            css_classes: ['dim-label'],
            wrap: true,
            max_width_chars: 52,
            justify: Gtk.Justification.CENTER,
        });
        box.append(title);
        box.append(caption);
        group.add(box);
        const say = () => {
            const [accel] = settings.get_strv('dictation-shortcut');
            const [ok, key, mods] = accel ? Gtk.accelerator_parse(accel) : [false, 0, 0];
            title.label = ok && key
                ? _('Hold %s and speak').format(Gtk.accelerator_get_label(key, mods))
                : _('Choose a shortcut, hold it and speak');
        };
        const id = settings.connect('changed::dictation-shortcut', say);
        group.connect('destroy', () => settings.disconnect(id));
        say();
    }

    // -- engine -----------------------------------------------------------

    // How it is made, for who wants to know: one folded row at the bottom.
    _buildEngineGroup(page, window) {
        const group = new Adw.PreferencesGroup({title: _('Under the hood')});
        page.add(group);

        const engine = new Adw.ExpanderRow({title: _('Speech engine'), subtitle: _('Checking…')});
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Check again')});
        refresh.add_css_class('flat');
        engine.add_suffix(refresh);
        group.add(engine);

        engine.add_row(new Adw.ActionRow({
            title: _('Runs on this computer, offline'),
            subtitle: _('A separate helper program recognises your voice. The Installation page installs it for you; the command below does the same by hand.'),
        }));
        const cmdRow = new Adw.ActionRow({title: _('Install command'), subtitle: INSTALL_CMD, subtitle_selectable: true});
        cmdRow.add_css_class('property');
        const copy = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Copy')});
        copy.add_css_class('flat');
        copy.connect('clicked', () => {
            const clipboard = Gdk.Display.get_default().get_clipboard();
            clipboard.set(INSTALL_CMD);
            window.add_toast(new Adw.Toast({title: _('Copied'), timeout: 2}));
        });
        cmdRow.add_suffix(copy);
        engine.add_row(cmdRow);

        const check = () => {
            engine.set_subtitle(_('Checking…'));
            this._engineStatus().then(st => engine.set_subtitle(st.text));
        };
        refresh.connect('clicked', check);
        check();
    }

    // -- about ------------------------------------------------------------

    _buildAboutGroup(page) {
        const group = new Adw.PreferencesGroup();
        page.add(group);
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 4, margin_bottom: 12});
        box.append(new Gtk.Label({
            label: _('Free forever. For GNOME. Made with love.'),
            css_classes: ['heading'],
        }));
        const links = new Gtk.Box({spacing: 18, halign: Gtk.Align.CENTER});
        links.append(new Gtk.LinkButton({label: _('Source code'), uri: this.metadata.url}));
        links.append(new Gtk.LinkButton({label: _('Report a problem'), uri: `${this.metadata.url}/issues`}));
        box.append(links);
        box.append(new Gtk.Label({
            label: _('Voice Hold %s').format(this.metadata['version-name'] ?? ''),
            css_classes: ['caption', 'dim-label'],
        }));
        group.add(box);
    }

    // Resolves to {text, installed}; `installed` is false only when no engine
    // is registered on the session bus.
    _engineStatus() {
        return new Promise(done => {
            const resolve = (text, installed = true) => done({text, installed});
            try {
                Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE, 'Status', null,
                    new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, 15000, null,
                    (conn, res) => {
                        try {
                            const [dict] = conn.call_finish(res).deepUnpack();
                            const get = k => dict[k]?.deepUnpack();
                            if (!get('models_ready'))
                                resolve(_('Engine %s found, models missing — see the Installation page').format(get('version')));
                            else
                                resolve(_('Ready — engine %s, models installed').format(get('version')));
                        } catch (e) {
                            const name = Gio.DBusError.is_remote_error(e) ? Gio.DBusError.get_remote_error(e) : '';
                            if (name === 'org.freedesktop.DBus.Error.ServiceUnknown')
                                resolve(_('Not installed — see the Installation page'), false);
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
            title: _('Shortcut'),
        });
        page.add(group);

        const enabledRow = new Adw.SwitchRow({title: _('Dictate with the shortcut')});
        group.add(enabledRow);
        settings.bind('enabled', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        group.add(this._shortcutRow(settings));

        const modes = ['auto', 'hold', 'toggle'];
        const modeRow = new Adw.ComboRow({
            title: _('How you use it'),
            subtitle: _('Hold to talk, tap to keep your hands free, or both.'),
            model: Gtk.StringList.new([_('Hold or tap'), _('Hold only'), _('Tap only')]),
        });
        modeRow.set_selected(Math.max(0, modes.indexOf(settings.get_string('mode'))));
        modeRow.connect('notify::selected', () => settings.set_string('mode', modes[modeRow.get_selected()]));
        group.add(modeRow);

        const tapRow = new Adw.SpinRow({
            title: _('Length of a tap'),
            subtitle: _('In milliseconds. A press shorter than this keeps listening, hands-free.'),
            adjustment: new Gtk.Adjustment({lower: 150, upper: 1000, step_increment: 50}),
        });
        group.add(tapRow);
        settings.bind('tap-ms', tapRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const silenceRow = new Adw.SpinRow({
            title: _('Stop by itself after a silence'),
            subtitle: _('In seconds, when your hands are free. 0: never.'),
            digits: 1,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 60, step_increment: 0.5}),
        });
        group.add(silenceRow);
        settings.bind('silence-stop-s', silenceRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const keepRow = new Adw.SpinRow({
            title: _('Stay ready for'),
            subtitle: _('Minutes after a dictation. Being ready takes about 1 GB of memory; later, the first words of the next dictation come a few seconds late.'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 480, step_increment: 5}),
        });
        group.add(keepRow);
        settings.bind('keep-loaded-min', keepRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    }

    // -- wake word --------------------------------------------------------

    _buildWakeGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Wake word'),
            description: _('Say the word, then speak: a hands-free dictation starts without touching the keyboard, and stops after a silence. The microphone stays open meanwhile and GNOME shows it; the word is recognised on this computer. Paused while the screen is locked and while another application records (a call).'),
        });
        page.add(group);

        const enabled = new Adw.SwitchRow({title: _('Listen for the wake word')});
        group.add(enabled);
        settings.bind('wake-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);

        const phrase = new Adw.EntryRow({title: _('The word to say'), show_apply_button: true});
        phrase.set_text(settings.get_string('wake-phrase'));
        phrase.connect('apply', () => {
            const text = phrase.get_text().trim();
            if (text)
                settings.set_string('wake-phrase', text);
            else
                phrase.set_text(settings.get_string('wake-phrase'));
        });
        group.add(phrase);

        const levels = [0.3, 0.5, 0.7];
        const sensitivity = new Adw.ComboRow({
            title: _('Sensitivity'),
            subtitle: _('Higher hears the word more easily, and wakes by mistake more often.'),
            model: Gtk.StringList.new([_('Low'), _('Normal'), _('High')]),
        });
        const current = settings.get_double('wake-sensitivity');
        sensitivity.set_selected(levels.reduce((best, v, i) =>
            Math.abs(v - current) < Math.abs(levels[best] - current) ? i : best, 0));
        sensitivity.connect('notify::selected', () =>
            settings.set_double('wake-sensitivity', levels[sensitivity.get_selected()]));
        group.add(sensitivity);

        const battery = new Adw.SwitchRow({
            title: _('Also on battery'),
            subtitle: _('Listening costs a little power: the word is only looked for while someone speaks.'),
        });
        group.add(battery);
        settings.bind('wake-on-battery', battery, 'active', Gio.SettingsBindFlags.DEFAULT);

        const state = new Adw.ActionRow({title: _('State')});
        group.add(state);
        const refresh = () => this._wakeState().then(text => state.set_subtitle(text));
        settings.connect('changed::wake-enabled', () => {
            state.set_subtitle('…');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                refresh();
                return GLib.SOURCE_REMOVE;
            });
        });
        page.connect('map', refresh);
        refresh();

        for (const row of [phrase, sensitivity, battery, state])
            settings.bind('wake-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
    }

    // What the engine says about the wake word; never starts it.
    _wakeState() {
        return new Promise(resolve => {
            Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE, 'Status', null,
                new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NO_AUTO_START, 5000, null, (conn, res) => {
                    let wake = 'off';
                    try {
                        wake = conn.call_finish(res).deepUnpack()[0].wake?.deepUnpack() ?? 'off';
                    } catch {
                        // not running: not listening
                    }
                    if (wake === 'listening')
                        resolve(_('Listening'));
                    else if (wake === 'downloading' || wake === 'wake-downloading')
                        resolve(_('Downloading the small model of the wake word (54 MB)…'));
                    else if (wake === 'wake-model-missing')
                        resolve(_('The small model of the wake word could not be downloaded: check the network, then switch the wake word off and on.'));
                    else if (wake.startsWith('error') || wake.startsWith('audio') || wake.startsWith('wake:'))
                        resolve(_('Not listening: %s').format(wake));
                    else
                        resolve(_('Not listening'));
                });
        });
    }

    // -- while dictating ---------------------------------------------------

    _buildDuringGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('While dictating'),
            description: _('In applications that do not take dictated text directly, the text is pasted at the end and stays in the clipboard.'),
        });
        page.add(group);

        const atEnd = new Adw.SwitchRow({
            title: _('Accuracy first: write the text at the end'),
            subtitle: _('The words show grey in the field while you speak; when you stop, the whole dictation is recognised again at once, with all its context, and written in their place. A second or two more at the end.'),
        });
        group.add(atEnd);
        settings.bind('write-at-end', atEnd, 'active', Gio.SettingsBindFlags.DEFAULT);

        const sounds = new Adw.SwitchRow({
            title: _('Sounds'),
            subtitle: _('A short sound when listening starts and when the text is written.'),
        });
        group.add(sounds);
        settings.bind('sounds', sounds, 'active', Gio.SettingsBindFlags.DEFAULT);

        const focusModes = ['follow', 'stop'];
        const focus = new Adw.ComboRow({
            title: _('If you change window'),
            subtitle: _('Alt+Tab or a click elsewhere while you dictate: the words go on where the cursor is now, or the dictation stops.'),
            model: Gtk.StringList.new([_('Keep dictating there'), _('Stop the dictation')]),
        });
        focus.set_selected(Math.max(0, focusModes.indexOf(settings.get_string('focus-change'))));
        focus.connect('notify::selected', () => settings.set_string('focus-change', focusModes[focus.get_selected()]));
        group.add(focus);

        const mediaModes = ['pause', 'lower', 'nothing'];
        const media = new Adw.ComboRow({
            title: _('Music and videos'),
            subtitle: _('Paused, or turned down to a quarter, while you speak; back as they were afterwards.'),
            model: Gtk.StringList.new([_('Pause'), _('Turn down'), _('Leave as they are')]),
        });
        media.set_selected(Math.max(0, mediaModes.indexOf(settings.get_string('media-during'))));
        media.connect('notify::selected', () => settings.set_string('media-during', mediaModes[media.get_selected()]));
        group.add(media);

        const last = this._shortcutRow(settings, 'paste-last-shortcut');
        last.title = _('Paste the last dictation');
        last.subtitle = _('Also in the menu of the top bar icon.');
        group.add(last);
    }

    // The editor of a shortcut stored as a strv under `key`.
    _shortcutRow(settings, key = 'dictation-shortcut') {
        const row = new Adw.ActionRow({title: _('Shortcut'), activatable: true});
        const label = new Gtk.ShortcutLabel({
            disabled_text: _('Not set'),
            accelerator: settings.get_strv(key)[0] ?? '',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(label);
        settings.connect(`changed::${key}`, () => label.set_accelerator(settings.get_strv(key)[0] ?? ''));

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
            const current = new Gtk.ShortcutLabel({accelerator: settings.get_strv(key)[0] ?? '', halign: Gtk.Align.CENTER});
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
                    settings.set_strv(key, []);
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if (!mask || !Gtk.accelerator_valid(keyval, mask))
                    return Gdk.EVENT_STOP;
                settings.set_strv(key, [Gtk.accelerator_name(keyval, mask)]);
                dialog.close();
                return Gdk.EVENT_STOP;
            });
            dialog.add_controller(ctl);
            dialog.present();
        });
        return row;
    }

    // -- microphone -------------------------------------------------------

    _buildMicrophoneGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Microphone'),
            description: _('Which input the engine records from. "System default" follows Settings → Sound → Input.'),
        });
        page.add(group);

        const row = new Adw.ComboRow({title: _('Microphone'), subtitle: _('Checking…')});
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Check again')});
        refresh.add_css_class('flat');
        row.add_suffix(refresh);
        group.add(row);

        let names = [];
        let syncing = false;
        const fill = () => {
            row.set_subtitle(_('Checking…'));
            listSources().then(sources => {
                const current = settings.get_string('microphone');
                const def = sources.find(s => s.default);
                const labels = [def ? _('System default (%s)').format(def.description) : _('System default')];
                names = [''];
                for (const s of sources) {
                    labels.push(s.description);
                    names.push(s.name);
                }
                if (current && !names.includes(current)) {
                    labels.push(_('%s (not connected)').format(current));
                    names.push(current);
                }
                syncing = true;
                row.set_model(Gtk.StringList.new(labels));
                row.set_selected(Math.max(0, names.indexOf(current)));
                syncing = false;
                row.set_subtitle(sources.length ? '' : _('Engine not reachable — the system default will be used'));
            });
        };
        row.connect('notify::selected', () => {
            if (syncing || row.get_selected() >= names.length)
                return;
            const name = names[row.get_selected()];
            if (settings.get_string('microphone') !== name)
                settings.set_string('microphone', name);
        });
        refresh.connect('clicked', fill);
        fill();
    }

    // -- polish -----------------------------------------------------------

    _buildPolishGroup(page, settings) {
        const group = new Adw.PreferencesGroup({title: _('Text clean-up')});
        page.add(group);

        const tidy = new Adw.SwitchRow({
            title: _('Remove hesitations'),
            subtitle: _('“euh”, “uh”, “hum” and words said twice in a row. Instant.'),
        });
        group.add(tidy);
        settings.bind('tidy', tidy, 'active', Gio.SettingsBindFlags.DEFAULT);

        const corrections = new Adw.SwitchRow({
            title: _('Spoken self-corrections'),
            subtitle: _('“At 2, no, I mean 3” becomes “at 3”; “scratch that” drops the sentence before. Instant, by rules.'),
        });
        group.add(corrections);
        settings.bind('corrections', corrections, 'active', Gio.SettingsBindFlags.DEFAULT);

        // What cleans a block after the rules. Measured on 32 dictated
        // sentences (see polish.py): the rules leave 17 % of the words to
        // fix, the local model 7 %, the cloud model 5 %.
        const levels = ['rules', 'local', 'cloud'];
        const model = new Adw.ComboRow({
            title: _('Then, a language model'),
            model: Gtk.StringList.new([_('None'), _('On this computer'), _('In the cloud')]),
        });
        const describe = () => {
            const level = levels[model.get_selected()];
            if (level === 'local')
                model.subtitle = _('Fillers such as “you know” and the corrections the rules miss. 2 to 3 seconds a sentence on a laptop; needs the language model of the voice commands.');
            else if (level === 'cloud' && !settings.get_boolean('cloud-enabled'))
                model.subtitle = _('Switch the cloud model on first, on the Cloud page. Until then only the rules apply.');
            else if (level === 'cloud')
                model.subtitle = _('The most accurate, in under a second. The text of each sentence is sent with your own key; your voice never is.');
            else
                model.subtitle = _('The rules above only: instant, and nothing leaves this computer.');
        };
        const current = settings.get_string('cleanup-model');
        model.set_selected(Math.max(0, levels.indexOf(
            current === 'rules' && settings.get_boolean('polish') ? 'local' : current)));
        model.connect('notify::selected', () => {
            settings.set_string('cleanup-model', levels[model.get_selected()]);
            settings.reset('polish');
            describe();
        });
        const cloudId = settings.connect('changed::cloud-enabled', describe);
        group.connect('destroy', () => settings.disconnect(cloudId));
        describe();
        group.add(model);
    }

    // -- appearance -------------------------------------------------------

    _buildAppearanceGroup(page, settings) {
        const group = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(group);

        const hud = new Adw.SwitchRow({
            title: _('Show the pill while dictating'),
            subtitle: _('Microphone level and live text. Errors are always shown.'),
        });
        group.add(hud);
        settings.bind('show-hud', hud, 'active', Gio.SettingsBindFlags.DEFAULT);

        const positions = ['bottom', 'island', 'cursor'];
        const position = new Adw.ComboRow({
            title: _('Pill position'),
            subtitle: _('At the bottom: it floats above the dock, always in the same place.'),
            model: Gtk.StringList.new([_('At the bottom of the screen'), _('Under the top bar'), _('Next to the text cursor')]),
        });
        position.set_selected(Math.max(0, positions.indexOf(settings.get_string('hud-position'))));
        position.connect('notify::selected', () => {
            const value = positions[position.get_selected()];
            if (settings.get_string('hud-position') !== value)
                settings.set_string('hud-position', value);
        });
        group.add(position);

        const effects = ['swell', 'drop', 'spring', 'glow'];
        const effect = new Adw.ComboRow({
            title: _('Animation'),
            subtitle: _('How the pill appears and disappears.'),
            model: Gtk.StringList.new([_('Swell (quiet)'), _('Drop'), _('Spring'), _('Halo')]),
        });
        effect.set_selected(Math.max(0, effects.indexOf(settings.get_string('hud-effect'))));
        const preview = () => settings.set_int('hud-preview', settings.get_int('hud-preview') + 1);
        effect.connect('notify::selected', () => {
            const value = effects[effect.get_selected()];
            if (settings.get_string('hud-effect') !== value) {
                settings.set_string('hud-effect', value);
                preview();
            }
        });
        const play = new Gtk.Button({icon_name: 'media-playback-start-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Preview')});
        play.add_css_class('flat');
        play.connect('clicked', preview);
        effect.add_suffix(play);
        group.add(effect);

        const ind = new Adw.SwitchRow({title: _('Top-bar indicator')});
        group.add(ind);
        settings.bind('show-indicator', ind, 'active', Gio.SettingsBindFlags.DEFAULT);
    }
}
