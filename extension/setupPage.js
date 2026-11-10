import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import * as Setup from './setup.js';

// The "Installation" page of the preferences: one row per component, an
// Install button, a progress bar, a banner that says what is left and offers
// to log out when everything is in place. Used by Voice Hold.
//
// components: 'voice' is the only one; the page stays written per component.

export function buildSetupPage(window, gettext, {components = ['voice'], title = null} = {}) {
    const _ = gettext || (s => s);
    const page = new Adw.PreferencesPage({title: title ?? _('Installation'), icon_name: 'system-software-install-symbolic'});
    const state = {manifest: null, detect: null, busy: null, changed: false, installer: null};

    // -- banner ---------------------------------------------------------------
    const banner = new Adw.Banner({revealed: true, title: _('Checking what is installed…')});
    const bannerGroup = new Adw.PreferencesGroup();
    bannerGroup.add(banner);
    page.add(bannerGroup);

    const group = new Adw.PreferencesGroup({
        title: _('Everything stays on this computer'),
        description: _('The pieces below are downloaded and unpacked into your home folder by this window: no terminal, no administrator password. Sizes are what you will download.'),
    });
    page.add(group);

    const rows = {};
    const labels = {
        voice: {title: _('Speech engine (Voice Hold)'), what: _('Listens and transcribes offline: Python engine and models.')},
    };
    for (const key of components) {
        const row = new Adw.ActionRow({title: labels[key].title, subtitle: _('Checking…')});
        const button = new Gtk.Button({label: _('Install'), valign: Gtk.Align.CENTER, sensitive: false});
        button.add_css_class('suggested-action');
        const cancel = new Gtk.Button({icon_name: 'process-stop-symbolic', valign: Gtk.Align.CENTER, visible: false, tooltip_text: _('Cancel')});
        const done = new Gtk.Image({icon_name: 'emblem-ok-symbolic', visible: false, valign: Gtk.Align.CENTER});
        done.add_css_class('success');
        row.add_suffix(done);
        row.add_suffix(cancel);
        row.add_suffix(button);
        group.add(row);
        const bar = new Gtk.ProgressBar({show_text: true, visible: false, margin_start: 12, margin_end: 12, margin_bottom: 8});
        group.add(bar);
        rows[key] = {row, button, cancel, done, bar};
        button.connect('clicked', () => install(key));
        cancel.connect('clicked', () => state.installer?.cancel());
    }

    // -- helpers ----------------------------------------------------------------
    const sizeOf = key => {
        const m = state.manifest;
        const tag = state.detect?.python?.tag;
        if (!m || !tag || !m.wheels?.[tag])
            return 0;
        if (key === 'voice')
            return m.wheels[tag].voice.reduce((s, i) => s + i.size, 0) + m.voice.models.reduce((s, i) => s + i.size, 0);
        return 0;
    };

    const describe = key => {
        const d = state.detect;
        if (!d)
            return [_('Checking…'), false];
        if (key === 'voice') {
            if (d.voice.service === 'external')
                return [_('Installed another way (pipx or a venv): nothing to do'), true];
            if (d.voice.service === 'assistant' && d.voice.models)
                return [_('Installed'), true];
            if (d.voice.service === 'assistant')
                return [_('Engine present, models missing'), false];
            return [labels.voice.what + ' ' + _('(%s)').format(Setup.formatSize(sizeOf('voice'))), false];
        }
        return ['', false];
    };

    const refreshRows = () => {
        for (const key of components) {
            const r = rows[key];
            if (state.busy === key)
                continue;
            const [text, ok] = describe(key);
            r.row.set_subtitle(text);
            r.row.remove_css_class('error');
            r.done.visible = ok;
            r.button.visible = !ok;
            r.button.label = _('Install');
            r.button.sensitive = !!state.manifest && !state.busy && !!state.detect?.python;
            r.cancel.visible = false;
            r.bar.visible = false;
        }
        const d = state.detect;
        const left = components.filter(k => !describe(k)[1]);
        if (!state.manifest) {
            banner.title = state.manifestError ?? _('Checking what is installed…');
            banner.button_label = state.manifestError ? _('Try again') : null;
        } else if (!d?.python) {
            banner.title = _('Python 3 was not found on this computer (it comes with GNOME on every distribution).');
            banner.button_label = null;
        } else if (!Setup.versionAtLeast(d.python.version, state.manifest.python?.min ?? '3.12') || !state.manifest.wheels?.[d.python.tag]) {
            banner.title = _('Your Python is %s; the engines need %s or newer.').format(d.python.version, state.manifest.python?.min ?? '3.12');
            banner.button_label = null;
        } else if (state.busy) {
            banner.title = _('Installing… keep this window open.');
            banner.button_label = null;
        } else if (left.length) {
            banner.title = _('%d step(s) left: press Install on each row.').format(left.length);
            banner.button_label = null;
        } else if (state.changed) {
            banner.title = _('Everything is installed. Log out and back in for the extension to see the engines.');
            banner.button_label = _('Log out now');
        } else {
            banner.title = _('Everything is installed.');
            banner.button_label = null;
        }
    };

    banner.connect('button-clicked', () => {
        if (!state.manifest)
            load();
        else
            Setup.logout();
    });

    const load = async () => {
        state.manifestError = null;
        refreshRows();
        try {
            state.manifest = await Setup.fetchManifest();
        } catch (e) {
            state.manifestError = _('Could not fetch the installation list (offline?): %s').format(e.message);
            refreshRows();
            return;
        }
        state.detect = Setup.detect(state.manifest);
        refreshRows();
    };

    const fail = (key, e) => {
        const r = rows[key];
        const msg = String(e?.message ?? e);
        const texts = {
            'python3-missing': _('Python 3 not found'),
            'cancelled': _('Cancelled'),
        };
        let text = texts[msg];
        if (!text && msg.startsWith('checksum-mismatch'))
            text = _('A downloaded file is corrupt (%s). Try again.').format(msg.split(':')[1]);
        if (!text && msg.startsWith('python3-'))
            text = _('Unsupported Python (%s)').format(msg.split(':')[1]);
        r.row.set_subtitle(text ?? _('Failed: %s').format(msg));
        r.row.add_css_class('error');
        r.button.label = _('Try again');
    };

    const install = async key => {
        if (state.busy || !state.manifest)
            return;
        state.busy = key;
        const r = rows[key];
        r.button.sensitive = false;
        r.cancel.visible = true;
        r.bar.visible = true;
        r.bar.fraction = 0;
        r.bar.text = _('Starting…');
        for (const k of components)
            rows[k].button.sensitive = false;
        refreshRows();
        const progress = ev => {
            const names = {download: _('Downloading'), verify: _('Checking'), extract: _('Unpacking'), service: _('Registering'), done: _('Done')};
            r.bar.fraction = Math.max(0, Math.min(1, ev.fraction ?? 0));
            const detail = ev.total ? ` ${Setup.formatSize(ev.done)} / ${Setup.formatSize(ev.total)}` : '';
            r.bar.text = `${names[ev.step] ?? ev.step} ${ev.label}${detail}`;
        };
        const installer = new Setup.Installer(state.manifest, {progress});
        state.installer = installer;
        try {
            if (key === 'voice')
                await installer.installVoice();
            state.changed = true;
            r.bar.fraction = 1;
            r.bar.text = _('Done');
            state.detect = Setup.detect(state.manifest);
            r.row.set_subtitle(describe(key)[0]);
        } catch (e) {
            fail(key, e);
        } finally {
            state.busy = null;
            state.installer = null;
            const [, ok] = describe(key);
            r.cancel.visible = false;
            r.bar.visible = !ok && r.bar.fraction > 0 && r.bar.fraction < 1;
            refreshRows();
            if (!ok && r.row.has_css_class('error')) {
                r.button.label = _('Try again');
                r.button.sensitive = true;
                r.button.visible = true;
            }
        }
    };

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        load();
        return GLib.SOURCE_REMOVE;
    });
    return page;
}
