// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {activatable} from '../setup.js';
import {BUS_NAME, commandStatus} from './commandEngine.js';
import {MANUAL_COMMAND, installedSetupArgv, lastLine} from './installCommand.js';

// The "Commands" page of the preferences: the switch that turns the voice
// commands on, their shortcut, the state of the command helper with a
// button that installs it, the local LLM, the working folder and the spoken
// answers.
//
// shortcutRow(settings, key) builds the shortcut editor (the dictation's).

export function buildCommandsPage(window, settings, gettext, shortcutRow) {
    const _ = gettext;
    const page = new Adw.PreferencesPage({title: _('Commands'), icon_name: 'utilities-terminal-symbolic'});

    // -- on / off, shortcut ---------------------------------------------------
    const group = new Adw.PreferencesGroup({
        title: _('Voice commands'),
        description: _('Optional. A second shortcut: hold it, say what to do, release. Opening an application, the volume, dark mode, a workspace… are done at once; a shell command is shown first and only runs once you confirm it. Everything stays on this computer.'),
    });
    page.add(group);

    const enabled = new Adw.SwitchRow({
        title: _('Enable voice commands'),
        subtitle: _('Off: the extension only dictates.'),
    });
    group.add(enabled);
    settings.bind('commands-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);

    const shortcut = shortcutRow(settings, 'command-shortcut');
    group.add(shortcut);
    settings.bind('commands-enabled', shortcut, 'sensitive', Gio.SettingsBindFlags.GET);

    // -- helper ---------------------------------------------------------------
    const helper = new Adw.PreferencesGroup({
        title: _('Command helper'),
        description: _('The commands are understood by a helper of the speech engine, with a small language model that runs on this computer (llama.cpp). It is a separate download; the Install button fetches it, the command below does the same by hand.'),
    });
    page.add(helper);
    buildHelperRows(helper, window, settings, _);

    // -- open requests ----------------------------------------------------------
    const open = new Adw.PreferencesGroup({
        title: _('Open requests'),
        description: _('GNOME actions are recognised by rules, instantly. Anything else (shell commands, questions) goes to the local language model. Every command is shown and confirmed before it runs, in a visible terminal.'),
    });
    page.add(open);
    const llm = new Adw.SwitchRow({
        title: _('Use the local LLM'),
        subtitle: _('Off: only the built-in GNOME actions.'),
    });
    open.add(llm);
    settings.bind('command-llm', llm, 'active', Gio.SettingsBindFlags.DEFAULT);
    const dir = new Adw.EntryRow({title: _('Working folder for commands (empty = home)')});
    open.add(dir);
    settings.bind('command-work-dir', dir, 'text', Gio.SettingsBindFlags.DEFAULT);

    // -- spoken answers ---------------------------------------------------------
    const spoken = new Adw.PreferencesGroup({
        title: _('Spoken answers'),
        description: _('The result is said aloud by the speech engine. Voices (French, English, about 65 MB each) are installed with: voice-hold-engine setup --tts'),
    });
    page.add(spoken);
    const speak = new Adw.SwitchRow({
        title: _('Say the answers'),
        subtitle: _('A command\'s output is summarised by the local LLM first.'),
    });
    spoken.add(speak);
    settings.bind('command-speak', speak, 'active', Gio.SettingsBindFlags.DEFAULT);
    const voices = ['', 'fr', 'en'];
    const voice = new Adw.ComboRow({
        title: _('Voice'),
        model: Gtk.StringList.new([_('Follow the session language'), _('French'), _('English')]),
    });
    voice.set_selected(Math.max(0, voices.indexOf(settings.get_string('command-voice'))));
    voice.connect('notify::selected', () => {
        const value = voices[voice.get_selected()] ?? '';
        if (settings.get_string('command-voice') !== value)
            settings.set_string('command-voice', value);
    });
    speak.bind_property('active', voice, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
    spoken.add(voice);

    return page;
}

// The status row (what is installed), its Install button, and the command
// that does the same by hand.
function buildHelperRows(group, window, settings, _) {
    const row = new Adw.ActionRow({title: _('Status'), subtitle: _('Checking…')});
    const spinner = new Gtk.Spinner({valign: Gtk.Align.CENTER, visible: false});
    const install = new Gtk.Button({label: _('Install'), valign: Gtk.Align.CENTER, visible: false});
    install.add_css_class('suggested-action');
    install.add_css_class('pill');
    const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Check again')});
    refresh.add_css_class('flat');
    row.add_suffix(spinner);
    row.add_suffix(install);
    row.add_suffix(refresh);
    group.add(row);

    const manual = new Adw.ActionRow({title: _('Install command'), subtitle: MANUAL_COMMAND});
    manual.add_css_class('property');
    const copy = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Copy')});
    copy.add_css_class('flat');
    copy.connect('clicked', () => {
        Gdk.Display.get_default().get_clipboard().set(MANUAL_COMMAND);
        window.add_toast(new Adw.Toast({title: _('Copied'), timeout: 2}));
    });
    manual.add_suffix(copy);
    group.add(manual);

    let proc = null;

    const describe = st => {
        if (!st || st.error === 'not-installed')
            return [_('Not installed'), true];
        if (st.error === 'spawn-failed')
            return [_('Installed but failed to start: %s').format(st.message ?? st.error), false];
        if (st.error)
            return [st.message ?? st.error, false];
        const parts = [];
        if (st.llm)
            parts.push(_('Ready — helper %s, language model %s').format(st.version, st.model_name || _('installed')));
        else
            parts.push(_('Helper %s ready, language model not installed: GNOME actions only').format(st.version));
        parts.push(st.terminal ? _('terminal: %s').format(st.terminal) : _('no terminal found (install Ptyxis or GNOME Terminal)'));
        return [parts.join(' · '), !st.llm];
    };

    // Asking the helper for its status starts it. While the commands are
    // switched off that only happens on request (the refresh button):
    // otherwise the session bus is asked whether the helper is registered.
    const check = (ask = settings.get_boolean('commands-enabled')) => {
        if (proc)
            return;
        row.set_subtitle(_('Checking…'));
        row.remove_css_class('error');
        const show = ([text, missing]) => {
            if (proc)
                return;
            row.set_subtitle(text);
            install.label = _('Install');
            install.visible = missing;
        };
        if (ask) {
            commandStatus().then(st => show(describe(st)));
        } else {
            activatable(BUS_NAME).then(there => show(there
                ? [_('Installed — switch the voice commands on to use it'), false]
                : describe(null)));
        }
    };

    const finish = (ok, tail) => {
        proc = null;
        spinner.stop();
        spinner.visible = false;
        refresh.sensitive = true;
        if (!ok) {
            row.set_subtitle(_('Failed: %s').format(tail || _('see the command below')));
            row.add_css_class('error');
            install.label = _('Try again');
            install.visible = true;
            return;
        }
        // Have the session bus read the new service file, then ask the
        // helper itself.
        activatable(BUS_NAME).then(() => check(true));
    };

    const run = () => {
        if (proc)
            return;
        const argv = installedSetupArgv();
        if (!argv) {
            row.set_subtitle(_('Install the speech engine first (Installation page), then come back here.'));
            return;
        }
        row.remove_css_class('error');
        row.set_subtitle(_('Starting…'));
        install.visible = false;
        refresh.sensitive = false;
        spinner.visible = true;
        spinner.start();
        let out = '';
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            finish(false, e.message);
            return;
        }
        const running = proc;
        const stream = running.get_stdout_pipe();
        const decoder = new TextDecoder();
        const read = () => {
            stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                let bytes;
                try {
                    bytes = s.read_bytes_finish(res);
                } catch {
                    return;
                }
                if (bytes.get_size() === 0)
                    return;
                // Keep the tail only: a download prints its progress for minutes.
                out = (out + decoder.decode(bytes.toArray(), {stream: true})).slice(-4000);
                if (proc === running)
                    row.set_subtitle(lastLine(out) || _('Installing… keep this window open.'));
                read();
            });
        };
        read();
        running.wait_async(null, (p, res) => {
            try {
                p.wait_finish(res);
            } catch {
                // fall through: not successful
            }
            if (proc === running)
                finish(p.get_if_exited() && p.get_exit_status() === 0, lastLine(out));
        });
    };

    install.connect('clicked', run);
    refresh.connect('clicked', () => check(true));
    settings.connect('changed::commands-enabled', () => check());
    // The installer does not outlive the window.
    window.connect('close-request', () => {
        proc?.force_exit();
        proc = null;
        return false;
    });
    check();
}
