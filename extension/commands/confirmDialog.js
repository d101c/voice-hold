// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

// Before any shell command (or power action) runs, the user sees exactly
// what will run and confirms with Enter, or cancels with Escape.
// Resolves to true (run) or false. `onOpen(close)` hands out a function
// that closes the dialog as a refusal (the extension is being disabled).

export function confirm({title, command, warning, runLabel, cancelLabel, onOpen = null}) {
    return new Promise(resolve => {
        let decided = false;
        const dialog = new ModalDialog.ModalDialog({styleClass: 'voice-cmd-dialog'});
        const box = new St.BoxLayout({style_class: 'voice-cmd-dialog-content'});
        // `orientation` from GNOME 48, `vertical` (deprecated) before.
        if ('orientation' in box)
            box.orientation = Clutter.Orientation.VERTICAL;
        else
            box.vertical = true;
        box.add_child(new St.Label({text: title, style_class: 'voice-cmd-dialog-title'}));
        const cmd = new St.Label({text: command, style_class: 'voice-cmd-dialog-command'});
        cmd.clutter_text.line_wrap = true;
        cmd.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        box.add_child(cmd);
        if (warning)
            box.add_child(new St.Label({text: warning, style_class: 'voice-cmd-dialog-warning'}));
        dialog.contentLayout.add_child(box);

        const finish = ok => {
            if (decided)
                return;
            decided = true;
            resolve(ok);
            dialog.close();
        };
        dialog.setButtons([
            {label: cancelLabel, action: () => finish(false), key: Clutter.KEY_Escape},
            {label: runLabel, action: () => finish(true), default: true},
        ]);
        // Destroyed once the closing animation is over, not before.
        dialog.connectObject('closed', () => {
            finish(false);
            dialog.destroy();
        }, dialog);
        if (!dialog.open()) {
            finish(false);
            dialog.destroy();
        } else {
            onOpen?.(() => finish(false));
        }
    });
}
