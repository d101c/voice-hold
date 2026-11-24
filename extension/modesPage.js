// SPDX-License-Identifier: GPL-2.0-or-later

// Preferences page "Modes": how the text is shaped for each kind of
// application (modes.js), and the history of past dictations (history.js).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {clear, load, prune} from './history.js';
import {MODES} from './modes.js';

const KEEP = [0, 1, 7, 30, -1];
const SHOWN = 30;

export function buildModesPage(settings, gettext) {
    const _ = gettext;
    const page = new Adw.PreferencesPage({title: _('Modes'), icon_name: 'document-edit-symbolic'});

    // -- modes --
    const group = new Adw.PreferencesGroup({
        title: _('Modes by application'),
        description: _('“As said” writes your words as they come. The other modes wait for the end of the dictation and have a language model rewrite the whole text: the cloud model when it is switched on (only the text is sent), else the local one of the voice commands. Without either, the text is written as said.'),
    });
    page.add(group);
    const labels = [_('As said'), _('Clean message'), _('Email'), _('Notes'), _('Your mode')];
    const categories = [
        ['email', _('Email'), _('Thunderbird, Evolution, Geary; Gmail, Outlook and Proton Mail in a browser')],
        ['chat', _('Chat'), _('Slack, Discord, Signal, Telegram, WhatsApp, Element…')],
        ['code', _('Code and terminals'), _('VS Code, Zed, JetBrains, Builder, terminals')],
        ['other', _('Other applications'), _('Everything else')],
    ];
    for (const [cat, title, subtitle] of categories) {
        const key = `text-mode-${cat}`;
        const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels)});
        row.set_selected(Math.max(0, MODES.indexOf(settings.get_string(key))));
        row.connect('notify::selected', () => settings.set_string(key, MODES[row.get_selected()]));
        group.add(row);
    }
    const custom = new Adw.EntryRow({title: _('Your mode: the instruction'), show_apply_button: true});
    custom.set_text(settings.get_string('text-mode-custom'));
    custom.connect('apply', () => settings.set_string('text-mode-custom', custom.get_text().trim()));
    group.add(custom);

    // -- history --
    const hist = new Adw.PreferencesGroup({
        title: _('History'),
        description: _('The text of your last dictations, kept on this computer only.'),
    });
    page.add(hist);
    const keep = new Adw.ComboRow({
        title: _('Keep the dictations'),
        model: Gtk.StringList.new([_('Not kept'), _('1 day'), _('7 days'), _('30 days'), _('Until cleared')]),
    });
    keep.set_selected(Math.max(0, KEEP.indexOf(settings.get_int('history-days'))));
    keep.connect('notify::selected', () => settings.set_int('history-days', KEEP[keep.get_selected()]));
    hist.add(keep);

    // A plain row with a button: Adw.ButtonRow needs GNOME 47.
    const clearRow = new Adw.ActionRow({title: _('Clear the history')});
    const clearButton = new Gtk.Button({
        label: _('Clear'),
        valign: Gtk.Align.CENTER,
        css_classes: ['destructive-action'],
    });
    clearRow.add_suffix(clearButton);
    hist.add(clearRow);

    let rows = [];
    const fill = () => {
        rows.forEach(r => hist.remove(r));
        const now = Math.floor(Date.now() / 1000);
        const entries = prune(load(), now, settings.get_int('history-days')).slice(0, SHOWN);
        rows = entries.map(e => {
            const when = GLib.DateTime.new_from_unix_local(e.at).format('%x %H:%M');
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(e.text.replace(/\n/g, ' ⏎ '), -1),
                subtitle: GLib.markup_escape_text(e.app ? `${when} · ${e.app}` : when, -1),
                title_lines: 2,
            });
            const copy = new Gtk.Button({
                icon_name: 'edit-copy-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Copy'),
                css_classes: ['flat'],
            });
            copy.connect('clicked', () => Gdk.Display.get_default().get_clipboard().set(e.text));
            row.add_suffix(copy);
            hist.add(row);
            return row;
        });
        clearButton.sensitive = rows.length > 0;
    };
    clearButton.connect('clicked', () => {
        clear();
        fill();
    });
    settings.connect('changed::history-days', fill);
    page.connect('map', fill);
    fill();
    return page;
}
