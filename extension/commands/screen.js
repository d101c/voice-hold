// SPDX-License-Identifier: GPL-2.0-or-later

// A picture of the focused window for the cloud assistant (only when the
// cloud is on and allowed to see it, and sent only if the model asks for
// it). The window alone: the pill and anything above it are not in it.
// Scaled down to MAX_SIDE, kept in the user's runtime directory (memory,
// private, wiped at logout), overwritten by the next one.
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {fitWithin} from './screenMap.js';

const MAX_SIDE = 1280;

// Resolves to {path, width, height, rect} or null.
export async function captureWindow(window) {
    if (!window || global.display.focus_window !== window)
        return null;
    const r = window.get_frame_rect();
    const rect = {x: r.x, y: r.y, width: r.width, height: r.height};
    const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'voice-hold']);
    GLib.mkdir_with_parents(dir, 0o700);
    const path = GLib.build_filenamev([dir, 'window.png']);
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    try {
        await new Promise((resolve, reject) => {
            new Shell.Screenshot().screenshot_window(false, false, stream, (shot, res) => {
                try {
                    shot.screenshot_window_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    } finally {
        stream.close(null);
    }
    let pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    const [w, h] = fitWithin(pixbuf.get_width(), pixbuf.get_height(), MAX_SIDE);
    if (w !== pixbuf.get_width()) {
        pixbuf = pixbuf.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR);
        pixbuf.savev(path, 'png', [], []);
    }
    return {path, width: w, height: h, rect};
}
