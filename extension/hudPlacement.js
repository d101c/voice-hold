// SPDX-License-Identifier: GPL-2.0-or-later

// Where the bottom pill goes on the real desktop: the Shell side of
// hudGeometry.bottomPosition(), shared by the dictation and command pills.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BOTTOM_GAP, bottomPosition} from './hudGeometry.js';

// Our pills carry this name, so that one is never taken for a dock.
export const PILL_NAME = 'voice-hold-pill';

// The monitor of the focused window (where the text goes), else the primary.
function focusMonitorIndex() {
    const lm = Main.layoutManager;
    const index = global.display.get_focus_window()?.get_monitor() ?? -1;
    return index >= 0 && index < lm.monitors.length ? index : lm.primaryIndex;
}

// Chrome that sits at the bottom without reserving room: a dock that hides
// itself and is showing. Reactive actors only, so a passing on-screen
// display (volume, brightness) does not push the pill around.
function obstacles() {
    const rects = [];
    for (const actor of Main.layoutManager.uiGroup.get_children()) {
        if (actor.name === PILL_NAME || !actor.visible || !actor.mapped || !actor.reactive ||
            actor === global.window_group)
            continue;
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        if (width > 0 && height > 0)
            rects.push({x, y, width, height});
    }
    return rects;
}

export function bottomAnchor(width, height, scale) {
    const lm = Main.layoutManager;
    const index = focusMonitorIndex();
    const monitor = lm.monitors[index] ?? lm.primaryMonitor;
    let workArea = null;
    try {
        const r = lm.getWorkAreaForMonitor(index);
        workArea = {x: r.x, y: r.y, width: r.width, height: r.height};
    } catch {
        // the monitor's own bounds
    }
    return bottomPosition({monitor, workArea, obstacles: obstacles(), width, height, gap: BOTTOM_GAP * scale});
}

// The widest a pill may get on the monitor it goes to.
export function anchorMonitor() {
    const lm = Main.layoutManager;
    return lm.monitors[focusMonitorIndex()] ?? lm.primaryMonitor;
}
