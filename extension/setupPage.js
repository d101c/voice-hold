import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import * as Setup from './setup.js';

// The "Installation" page of the preferences, as three numbered steps: an
// Install button with its progress bar, the gesture, and a field to try the
// dictation in. A banner says what is left. Used by Voice Hold.
//
// components: 'voice' is the only one; the page stays written per component.

export function buildSetupPage(window, gettext, {components = ['voice'], title = null, shortcut = null, accelerator = null, picture = null} = {}) {
    const _ = gettext || (s => s);
    const page = new Adw.PreferencesPage({title: title ?? _('Installation'), icon_name: 'system-software-install-symbolic'});
    const state = {manifest: null, detect: null, busy: null, changed: false, installer: null, needLogout: false};

    // -- banner ---------------------------------------------------------------
    const banner = new Adw.Banner({revealed: true, title: _('Checking what is installed…')});
    const bannerGroup = new Adw.PreferencesGroup();
    bannerGroup.add(banner);
    page.add(bannerGroup);

    // -- three steps -----------------------------------------------------------
    // 1 install (the only click), 2 the gesture, 3 a field to try it in.
    const group = new Adw.PreferencesGroup({
        title: _('Three steps and you are dictating'),
        description: _('The speech engine is downloaded and unpacked into your home folder by this window: no terminal, no administrator password. Afterwards nothing leaves this computer.'),
    });
    page.add(group);

    const badge = n => {
        const l = new Gtk.Label({label: String(n), width_request: 32, height_request: 32, valign: Gtk.Align.CENTER});
        l.add_css_class('title-3');
        l.add_css_class('numeric');
        return l;
    };

    const rows = {};
    const labels = {
        voice: {title: _('Install the speech engine'), what: _('Listens and transcribes offline: Python engine and models.')},
    };
    for (const key of components) {
        const row = new Adw.ActionRow({title: labels[key].title, subtitle: _('Checking…')});
        row.add_prefix(badge(1));
        const button = new Gtk.Button({label: _('Install'), valign: Gtk.Align.CENTER, sensitive: false});
        button.add_css_class('suggested-action');
        button.add_css_class('pill');
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

    const gestureRow = new Adw.ActionRow({
        title: shortcut ? _('Hold %s and speak').format(shortcut) : _('Hold the shortcut and speak'),
        subtitle: _('Release to stop. Or tap once to start and once more to stop.'),
    });
    gestureRow.add_prefix(badge(2));
    if (accelerator) {
        // Keycaps: libadwaita's label from 1.8, GTK's before.
        const keys = Adw.ShortcutLabel
            ? new Adw.ShortcutLabel({accelerator, valign: Gtk.Align.CENTER})
            : new Gtk.ShortcutLabel({accelerator, valign: Gtk.Align.CENTER});
        gestureRow.add_suffix(keys);
    }
    group.add(gestureRow);

    const tryRow = new Adw.EntryRow({title: _('Try it here: click, hold the shortcut, say a sentence'), sensitive: false});
    tryRow.add_prefix(badge(3));
    group.add(tryRow);

    if (picture) {
        const shot = Gtk.Picture.new_for_filename(picture);
        shot.set_can_shrink(true);
        shot.set_content_fit?.(Gtk.ContentFit.CONTAIN);
        shot.add_css_class('card');
        shot.set_margin_top(18);
        shot.set_size_request(-1, 120);
        const shotGroup = new Adw.PreferencesGroup({description: _('While you dictate, a small pill slides out of the top bar with the microphone level and the text.')});
        shotGroup.add(shot);
        page.add(shotGroup);
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
            banner.title = _('One click left: press Install below.');
            banner.button_label = null;
        } else if (state.needLogout) {
            banner.title = _('Installed. Log out and back in once so that GNOME sees the speech engine.');
            banner.button_label = _('Log out now');
        } else if (shortcut) {
            banner.title = _('Ready: hold %s and speak. Try it in the field below.').format(shortcut);
            banner.button_label = null;
        } else {
            banner.title = _('Everything is installed.');
            banner.button_label = null;
        }
        const ready = !!state.manifest && !left.length && !state.needLogout;
        tryRow.sensitive = ready;
        if (ready && state.changed && !state.focused) {
            state.focused = true;
            tryRow.grab_focus();
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
            // Normally the session bus sees the new service at once; only an
            // unusual bus needs a new session.
            state.needLogout = !await Setup.activatable(state.manifest.voice?.bus_name ?? 'org.griffit.VoiceHold');
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
