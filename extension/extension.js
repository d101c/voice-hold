import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Dictation} from './dictation.js';
import {addIndicator} from './panelIndicator.js';
import {engineInstalled, notifySetup} from './welcome.js';

// Hold the `dictation-shortcut` (<Control>space by default) and speak: the words are
// typed where the text cursor is (dictation.js).
export default class VoiceHoldExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._bound = false;
        this._dictation = new Dictation(
            this._settings,
            `${this.path}/icons/voice-hold-symbolic.svg`,
            _,
            () => {
                this._welcomeSource?.destroy();
                this.openPreferences();
            },
        );
        this._bind();
        this._welcome();

        this._indicator = null;
        if (this._settings.get_boolean('show-indicator'))
            this._addIndicator();

        const rebind = () => {
            this._unbind();
            this._bind();
        };
        const toggleIndicator = () => {
            if (this._settings.get_boolean('show-indicator'))
                this._addIndicator();
            else
                this._removeIndicator();
        };
        this._settings.connectObject(
            'changed::enabled', rebind,
            'changed::dictation-shortcut', rebind,
            'changed::show-indicator', toggleIndicator,
            this);
    }

    disable() {
        this._unbind();
        this._removeIndicator();
        this._settings.disconnectObject(this);
        this._welcomeCancel?.cancel();
        this._welcomeCancel = null;
        this._welcomeSource?.destroy();
        this._welcomeSource = null;
        if (this._dictation) {
            this._dictation.destroy();
            this._dictation = null;
        }
        this._settings = null;
    }

    // Once, right after the first install: the speech engine is a separate
    // download, and nothing says so until the shortcut is pressed.
    _welcome() {
        if (this._settings.get_boolean('welcome-shown'))
            return;
        this._welcomeCancel = new Gio.Cancellable();
        engineInstalled(this._welcomeCancel).then(installed => {
            if (!this._settings || installed === null)
                return;
            this._settings.set_boolean('welcome-shown', true);
            if (installed)
                return;
            this._welcomeSource = notifySetup({
                title: _('Voice Hold: one last step'),
                body: _('Install the speech engine: one click, about 500 MB.'),
                action: _('Install'),
                iconName: 'audio-input-microphone-symbolic',
                onActivate: () => this.openPreferences(),
            });
            this._welcomeSource.connect('destroy', () => (this._welcomeSource = null));
        });
    }

    _addIndicator() {
        if (this._indicator)
            return;
        this._indicator = addIndicator(
            this.uuid,
            this._settings,
            `${this.path}/icons/voice-hold-symbolic.svg`,
            () => this.openPreferences(),
            _,
        );
    }

    _removeIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _bind() {
        if (this._bound || !this._settings.get_boolean('enabled'))
            return;
        // IGNORE_AUTOREPEAT: Mutter only suppresses key repeat when asked.
        // Without it, holding the shortcut re-fires the binding every ~30 ms after
        // the repeat delay, and every re-fire is read as "stop".
        Main.wm.addKeybinding(
            'dictation-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL,
            () => this._dictation?.shortcut(),
        );
        this._bound = true;
    }

    _unbind() {
        if (!this._bound)
            return;
        Main.wm.removeKeybinding('dictation-shortcut');
        this._bound = false;
    }
}
