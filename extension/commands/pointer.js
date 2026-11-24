// SPDX-License-Identifier: GPL-2.0-or-later

// On-screen help of the voice commands: a ring where to click, and, after
// the user confirmed it, a click or a keyboard shortcut done for them with
// virtual input devices (the same mechanism as the on-screen keyboard).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {keyCombo} from './screenMap.js';

const RING = 56;           // diameter, logical pixels
const SHOW_MS = 9000;

export class Pointer {
    constructor() {
        this._ring = null;
        this._hideId = 0;
        this._mouse = null;
        this._keyboard = null;
    }

    destroy() {
        this.hide();
        this._mouse?.run_dispose();
        this._keyboard?.run_dispose();
        this._mouse = null;
        this._keyboard = null;
    }

    // A pulsing ring around (x, y), in the accent colour, with `label` under
    // it; goes after SHOW_MS or at the next hide().
    show(x, y, label, accent) {
        this.hide();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const size = RING * scale;
        const group = new St.Widget({reactive: false});
        const ring = new St.Widget({
            style_class: 'voice-cmd-ring',
            style: `border-color: ${accent};`,
            width: size,
            height: size,
            x: -size / 2,
            y: -size / 2,
        });
        ring.set_pivot_point(0.5, 0.5);
        group.add_child(ring);
        if (label) {
            const tag = new St.Label({text: label, style_class: 'voice-cmd-ring-label'});
            tag.set_style(`background-color: ${accent};`);
            group.add_child(tag);
            tag.connect('notify::width', () => tag.set_position(-tag.width / 2, size / 2 + 6 * scale));
        }
        group.set_position(x, y);
        Main.layoutManager.uiGroup.add_child(group);
        Main.layoutManager.uiGroup.set_child_above_sibling(group, null);
        this._ring = group;
        // One repeating ease (never a chain of them, see ../hud.js).
        ring.set_scale(1.25, 1.25);
        ring.ease({scale_x: 0.85, scale_y: 0.85, duration: 700, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            repeatCount: -1, autoReverse: true});
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOW_MS, () => {
            this._hideId = 0;
            this.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    hide() {
        if (this._hideId) {
            GLib.Source.remove(this._hideId);
            this._hideId = 0;
        }
        this._ring?.destroy();
        this._ring = null;
    }

    _seat() {
        const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend();
        return backend.get_default_seat();
    }

    click(x, y, double = false) {
        this._mouse ??= this._seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        let t = GLib.get_monotonic_time();
        this._mouse.notify_absolute_motion(t, x, y);
        for (let i = 0; i < (double ? 2 : 1); i++) {
            t += 20000;
            this._mouse.notify_button(t, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            t += 20000;
            this._mouse.notify_button(t, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        }
    }

    // "ctrl+h"; false when the shortcut cannot be read.
    keys(text) {
        const combo = keyCombo(text);
        const keyvals = combo?.map(n => Clutter[`KEY_${n}`]);
        if (!keyvals || keyvals.some(k => k === undefined))
            return false;
        this._keyboard ??= this._seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const t = GLib.get_monotonic_time();
        for (const k of keyvals)
            this._keyboard.notify_keyval(t, k, Clutter.KeyState.PRESSED);
        for (const k of [...keyvals].reverse())
            this._keyboard.notify_keyval(t, k, Clutter.KeyState.RELEASED);
        return true;
    }
}
