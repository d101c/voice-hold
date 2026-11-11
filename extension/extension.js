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
//
// Optional, off by default (`commands-enabled`): hold the `command-shortcut`
// (<Control><Alt>space by default) and say what to do (commands/commander.js). That
// code is only imported once the option is switched on; while it is off
// nothing of it runs and the dictation is exactly what it is without it.
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
        this._commander = null;
        this._commandBound = false;
        this._commandsLoad = null;
        this._bind();
        this._welcome();

        this._indicator = null;
        if (this._settings.get_boolean('show-indicator'))
            this._addIndicator();

        this._syncCommands();

        const rebind = () => {
            this._unbind();
            this._bind();
        };
        const rebindCommand = () => {
            this._unbindCommand();
            this._bindCommand();
        };
        const toggleIndicator = () => {
            if (this._settings.get_boolean('show-indicator'))
                this._addIndicator();
            else
                this._removeIndicator();
        };
        this._settings.connectObject(
            'changed::enabled', rebind,
            'changed::enabled', rebindCommand,
            'changed::dictation-shortcut', rebind,
            'changed::show-indicator', toggleIndicator,
            'changed::commands-enabled', () => this._syncCommands(),
            'changed::command-shortcut', rebindCommand,
            this);
    }

    disable() {
        this._unbind();
        this._dropCommands();
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
        this._indicator.setCommands(this._commandsMenu());
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
            () => {
                // One gesture at a time: not while a command is being
                // listened to or run. (No commander unless the commands are
                // switched on.)
                if (this._commander?.active)
                    return;
                this._commander?.dismiss();
                this._dictation?.shortcut();
            },
        );
        this._bound = true;
    }

    _unbind() {
        if (!this._bound)
            return;
        Main.wm.removeKeybinding('dictation-shortcut');
        this._bound = false;
    }

    // -- voice commands (optional) ---------------------------------------------

    // Follow `commands-enabled`: load and create the commander, or tear it
    // down. The import is asynchronous: the setting, or the extension itself,
    // may have been switched off by the time it resolves.
    _syncCommands() {
        if (!this._settings.get_boolean('commands-enabled')) {
            this._dropCommands();
            return;
        }
        if (this._commander || this._commandsLoad)
            return;
        const load = import('./commands/commander.js').then(({Commander}) => {
            if (this._commandsLoad !== load)
                return;                   // switched off, or disabled, meanwhile
            this._commandsLoad = null;
            this._commander = new Commander(
                this._settings,
                `${this.path}/icons/voice-hold-command-symbolic.svg`,
                _,
            );
            this._dictation.setElsewhere(() => !!this._commander?.active);
            this._bindCommand();
            this._indicator?.setCommands(this._commandsMenu());
            this._commander.warmUp();
        }).catch(e => {
            if (this._commandsLoad === load)
                this._commandsLoad = null;
            logError(e, 'voice-hold: voice commands');
        });
        this._commandsLoad = load;
    }

    _dropCommands() {
        this._commandsLoad = null;
        this._unbindCommand();
        this._indicator?.setCommands(null);
        this._dictation?.setElsewhere(null);
        if (this._commander) {
            this._commander.destroy();
            this._commander = null;
        }
    }

    // What the indicator's menu needs of the commands; null while they are
    // off.
    _commandsMenu() {
        if (!this._commander)
            return null;
        return {
            recent: () => this._commander?.recent() ?? Promise.resolve([]),
            recall: entry => {
                if (!this._dictation?.active)
                    this._commander?.recall(entry);
            },
        };
    }

    // The command shortcut follows the same master switch as the dictation's
    // (`enabled`, the toggle of the indicator's menu).
    _bindCommand() {
        if (this._commandBound || !this._commander || !this._settings.get_boolean('enabled'))
            return;
        Main.wm.addKeybinding(
            'command-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL,
            () => {
                // Not while dictating: the microphone is taken.
                if (!this._dictation?.active)
                    this._commander?.shortcut();
            },
        );
        this._commandBound = true;
    }

    _unbindCommand() {
        if (!this._commandBound)
            return;
        Main.wm.removeKeybinding('command-shortcut');
        this._commandBound = false;
    }
}
