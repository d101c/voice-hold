// SPDX-License-Identifier: GPL-2.0-or-later

// Preferences page "Cloud (optional)": the API keys of the providers that
// may later lend their models to the voice commands. Voice Hold stays
// offline unless `cloud-enabled` is on: speech is always recognised on this
// computer; only text (and later, on request, a screenshot of the focused
// window) would be sent.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {MODELS, PROVIDERS, clearKey, loadKey, maskKey, storeKey, testKey} from './apiKeys.js';

export function buildCloudPage(window, settings, gettext) {
    const _ = gettext;
    const page = new Adw.PreferencesPage({title: _('Cloud'), icon_name: 'network-server-symbolic'});

    const intro = new Adw.PreferencesGroup({
        title: _('Optional: a cloud model'),
        description: _('Off by default: Voice Hold works offline. Your voice is always recognised on this computer and never sent. When on, the voice commands ask the chosen model what you meant: the text of the request is sent, with the facts it asks for (disk space, battery, firewall…). Changes are always shown to you first. Keys are kept in the GNOME keyring.'),
    });
    page.add(intro);

    const enabled = new Adw.SwitchRow({title: _('Use a cloud model')});
    intro.add(enabled);
    settings.bind('cloud-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);

    const ids = PROVIDERS.map(p => p.id);
    const providerRow = new Adw.ComboRow({
        title: _('Provider'),
        model: Gtk.StringList.new(PROVIDERS.map(p => p.name)),
    });
    providerRow.set_selected(Math.max(0, ids.indexOf(settings.get_string('cloud-provider'))));
    providerRow.connect('notify::selected', () => settings.set_string('cloud-provider', ids[providerRow.get_selected()]));
    intro.add(providerRow);

    // The model, among the provider's; filled again when the provider changes.
    const modelRow = new Adw.ComboRow({title: _('Model')});
    intro.add(modelRow);

    const screenRow = new Adw.SwitchRow({
        title: _('Let it see the active window'),
        subtitle: _('For “where is…” and “click on…”: a picture of the window you are working in, sent only when the model needs to look. Never the whole screen.'),
    });
    intro.add(screenRow);
    settings.bind('cloud-screen', screenRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    let models = [];
    const fillModels = () => {
        models = MODELS[settings.get_string('cloud-provider')] ?? [];
        modelRow.model = Gtk.StringList.new(models.map(m => m.name));
        modelRow.sensitive = models.length > 0;
        const i = models.findIndex(m => m.id === settings.get_string('cloud-model'));
        modelRow.set_selected(Math.max(0, i));
        modelRow.subtitle = models.length
            ? _(models[Math.max(0, i)].hint)
            : _('Not supported by the voice commands yet: only Anthropic for now');
    };
    modelRow.connect('notify::selected', () => {
        const m = models[modelRow.get_selected()];
        if (!m)
            return;
        modelRow.subtitle = _(m.hint);
        if (settings.get_string('cloud-model') !== m.id)
            settings.set_string('cloud-model', m.id);
    });
    const providerId = settings.connect('changed::cloud-provider', fillModels);
    modelRow.connect('destroy', () => settings.disconnect(providerId));
    fillModels();

    const keys = new Adw.PreferencesGroup({
        title: _('API keys'),
        description: _('Paste a key and press Enter: it is checked with the provider, then stored.'),
    });
    page.add(keys);
    for (const p of PROVIDERS)
        keys.add(keyRow(window, p, _));

    return page;
}

// One provider: an expander with the key's state, a password entry, and
// buttons to open the provider's key page, test and remove.
function keyRow(window, p, _) {
    const row = new Adw.ExpanderRow({title: p.name, subtitle: _('No key')});
    const toast = title => window.add_toast(new Adw.Toast({title, timeout: 3}));

    const entry = new Adw.PasswordEntryRow({title: _('API key'), show_apply_button: true});
    row.add_row(entry);

    const actions = new Adw.ActionRow({title: _('Where to get a key')});
    const open = new Gtk.Button({label: _('Open'), valign: Gtk.Align.CENTER});
    open.connect('clicked', () => new Gtk.UriLauncher({uri: p.keysUrl}).launch(window, null, null));
    const test = new Gtk.Button({label: _('Test'), valign: Gtk.Align.CENTER, sensitive: false});
    const remove = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        tooltip_text: _('Remove the key'),
        valign: Gtk.Align.CENTER,
        sensitive: false,
        css_classes: ['flat'],
    });
    actions.add_suffix(open);
    actions.add_suffix(test);
    actions.add_suffix(remove);
    row.add_row(actions);

    const show = key => {
        row.subtitle = key ? _('Key stored: %s').format(maskKey(key)) : _('No key');
        test.sensitive = !!key;
        remove.sensitive = !!key;
    };
    const check = async key => {
        row.subtitle = _('Checking…');
        const r = await testKey(p.id, key);
        if (r.ok)
            return true;
        toast(r.reason === 'rejected'
            ? _('%s refused this key').format(p.name)
            : _('Could not check the key: %s').format(r.reason));
        return false;
    };

    loadKey(p.id).then(show).catch(e => {
        row.subtitle = _('Keyring unavailable: %s').format(e.message);
    });

    entry.connect('apply', async () => {
        const key = entry.text.trim();
        if (!key)
            return;
        entry.sensitive = false;
        try {
            if (await check(key)) {
                await storeKey(p.id, key);
                entry.text = '';
                toast(_('%s key works and is stored').format(p.name));
            }
            show(await loadKey(p.id));
        } catch (e) {
            toast(_('Keyring error: %s').format(e.message));
        } finally {
            entry.sensitive = true;
        }
    });
    test.connect('clicked', async () => {
        const key = await loadKey(p.id);
        if (await check(key))
            toast(_('%s key works').format(p.name));
        show(key);
    });
    remove.connect('clicked', async () => {
        await clearKey(p.id);
        show(null);
        toast(_('%s key removed').format(p.name));
    });
    return row;
}
