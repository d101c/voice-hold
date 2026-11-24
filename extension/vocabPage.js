// SPDX-License-Identifier: GPL-2.0-or-later

// Preferences page "Vocabulary": the words the recogniser should write your
// way (`vocabulary`), and the phrases that become a fixed text
// (`replacements`). The engine applies both to each block (vocab.py).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

// What is typed as \n in the "write" field is a new line.
export function decodeNewlines(text) {
    return text.replace(/\\n/g, '\n');
}

function deleteButton(gettext, onClick) {
    const b = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: gettext('Remove'),
        css_classes: ['flat'],
    });
    b.connect('clicked', onClick);
    return b;
}

export function buildVocabPage(settings, gettext) {
    const _ = gettext;
    const page = new Adw.PreferencesPage({title: _('Vocabulary'), icon_name: 'accessories-dictionary-symbolic'});

    // -- words --
    const words = new Adw.PreferencesGroup({
        title: _('Your words'),
        description: _('Names, brands and jargon, written your way. A word that sounds the same, or very close, is corrected after recognition.'),
    });
    page.add(words);
    const learn = new Adw.SwitchRow({
        title: _('Learn from my corrections'),
        subtitle: _('Retype a word of what you just dictated, a name for instance: its spelling is added here by itself.'),
    });
    words.add(learn);
    settings.bind('vocabulary-learn', learn, 'active', Gio.SettingsBindFlags.DEFAULT);
    const addWord = new Adw.EntryRow({title: _('Add a word'), show_apply_button: true});
    words.add(addWord);
    let wordRows = [];
    const fillWords = () => {
        wordRows.forEach(r => words.remove(r));
        wordRows = settings.get_strv('vocabulary').map(w => {
            const row = new Adw.ActionRow({title: GLib.markup_escape_text(w, -1)});
            row.add_suffix(deleteButton(_, () =>
                settings.set_strv('vocabulary', settings.get_strv('vocabulary').filter(x => x !== w))));
            words.add(row);
            return row;
        });
    };
    addWord.connect('apply', () => {
        const w = addWord.get_text().trim();
        const list = settings.get_strv('vocabulary');
        if (w && !list.includes(w))
            settings.set_strv('vocabulary', [...list, w]);
        addWord.set_text('');
    });

    // -- replacements --
    const repl = new Adw.PreferencesGroup({
        title: _('Replacements'),
        description: _('Say a phrase, get a text: an address, a signature, a symbol. Whole words, whatever the case. Type \\n for a new line.'),
    });
    page.add(repl);
    const said = new Adw.EntryRow({title: _('When I say')});
    const written = new Adw.EntryRow({title: _('Write'), show_apply_button: true});
    repl.add(said);
    repl.add(written);
    let replRows = [];
    const replacements = () => settings.get_value('replacements').deepUnpack();
    const fillReplacements = () => {
        replRows.forEach(r => repl.remove(r));
        replRows = Object.entries(replacements()).map(([k, v]) => {
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(k, -1),
                subtitle: GLib.markup_escape_text(v.replace(/\n/g, ' ⏎ '), -1),
            });
            row.add_suffix(deleteButton(_, () => {
                const all = replacements();
                delete all[k];
                settings.set_value('replacements', new GLib.Variant('a{ss}', all));
            }));
            repl.add(row);
            return row;
        });
    };
    const addReplacement = () => {
        const k = said.get_text().trim();
        const v = decodeNewlines(written.get_text());
        if (!k || !v.trim())
            return;
        settings.set_value('replacements', new GLib.Variant('a{ss}', {...replacements(), [k]: v}));
        said.set_text('');
        written.set_text('');
        said.grab_focus();
    };
    written.connect('apply', addReplacement);
    said.connect('entry-activated', () => written.grab_focus());

    settings.connect('changed::vocabulary', fillWords);
    settings.connect('changed::replacements', fillReplacements);
    fillWords();
    fillReplacements();
    return page;
}
