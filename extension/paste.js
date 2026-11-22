// SPDX-License-Identifier: GPL-2.0-or-later

// Text for a window whose field does not take input-method text (many
// Electron and X11 applications): it goes to the clipboard, then a virtual
// Ctrl+V (Ctrl+Shift+V in a terminal) pastes it, only if the window that had
// the focus at the start of the dictation still has it. The text stays in
// the clipboard either way.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {isTerminal, pasteAllowed} from './pasteKeys.js';

// Time for the clipboard owner change to reach the application.
const PASTE_DELAY_MS = 80;

export class Paster {
    constructor() {
        this._device = null;
        this._timeoutId = 0;
    }

    destroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._device?.run_dispose();
        this._device = null;
    }

    // Resolves to 'pasted' or 'copied'.
    deliver(text, window) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        if (!window || global.display.focus_window !== window || !pasteAllowed(window.get_wm_class()))
            return Promise.resolve('copied');
        return new Promise(resolve => {
            if (this._timeoutId)
                GLib.Source.remove(this._timeoutId);
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
                this._timeoutId = 0;
                if (global.display.focus_window !== window) {
                    resolve('copied');
                    return GLib.SOURCE_REMOVE;
                }
                this._keys(isTerminal(window.get_wm_class())
                    ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
                    : [Clutter.KEY_Control_L, Clutter.KEY_v]);
                resolve('pasted');
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _keys(keyvals) {
        if (!this._device) {
            const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend();
            const seat = backend.get_default_seat();
            this._device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        const t = GLib.get_monotonic_time();
        for (const k of keyvals)
            this._device.notify_keyval(t, k, Clutter.KeyState.PRESSED);
        for (const k of [...keyvals].reverse())
            this._device.notify_keyval(t, k, Clutter.KeyState.RELEASED);
    }
}
