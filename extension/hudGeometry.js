// SPDX-License-Identifier: GPL-2.0-or-later

// Where the pill goes, free of Shell imports so it can be tested with plain
// gjs (same spirit as holdMachine.js). Rectangles are plain objects with
// x, y, width and height, in stage coordinates.

export const ISLAND_OVERLAP = 1;    // px the island slips under the bar, so no seam shows
export const CURSOR_GAP = 8;        // px between the text cursor and the pill
export const POINTER_GAP = 24;      // px under the pointer, clear of the cursor image

// The y the island hangs from on `monitor`: the bottom of the top bar when
// there is one to hang from, else the top edge of the monitor. `panel` is the
// bar's box plus `visible`. No bar to hang from: hidden (a fullscreen window,
// an extension that hides it), moved to the bottom or to another monitor.
export function islandTop(monitor, panel) {
    if (!monitor)
        return 0;
    if (!panel || !panel.visible || panel.height <= 0)
        return monitor.y;
    const bottom = panel.y + panel.height;
    const onMonitor = panel.x < monitor.x + monitor.width && panel.x + panel.width > monitor.x;
    const atTop = panel.y <= monitor.y && bottom > monitor.y && bottom <= monitor.y + monitor.height / 4;
    return onMonitor && atTop ? bottom : monitor.y;
}

// Top-left corner of an island `width` wide: centred on the monitor, slipped
// under what it hangs from.
export function islandPosition(monitor, panel, width) {
    const cx = monitor ? monitor.x + monitor.width / 2 : width / 2;
    return [Math.round(cx - width / 2), Math.round(islandTop(monitor, panel) - ISLAND_OVERLAP)];
}

// The monitor that contains the point, else `fallback`.
export function monitorAt(monitors, x, y, fallback = null) {
    return (monitors ?? []).find(m =>
        x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) ?? fallback;
}

// Top-left corner of a pill of `width` x `height` next to the text cursor:
// below `cursor` (the rectangle the application reports; all zeros or null
// when it reports none), else below `pointer` ([x, y]); flipped above when it
// would leave the bottom of its monitor, and kept inside it.
export function cursorPosition({cursor, pointer, monitors, primary, width, height}) {
    const known = !!cursor && (cursor.x !== 0 || cursor.y !== 0);
    const anchor = known
        ? {x: cursor.x, top: cursor.y, bottom: cursor.y + cursor.height, gap: CURSOR_GAP}
        : {x: pointer[0], top: pointer[1], bottom: pointer[1], gap: POINTER_GAP};
    let x = anchor.x;
    let y = anchor.bottom + anchor.gap;
    // The anchor's own monitor: on the last line of a monitor the point
    // below it is on none.
    const monitor = monitorAt(monitors, anchor.x, anchor.top, primary);
    if (monitor) {
        x = Math.max(monitor.x, Math.min(x, monitor.x + monitor.width - width));
        if (y + height > monitor.y + monitor.height)
            y = anchor.top - height - CURSOR_GAP;
        y = Math.max(monitor.y, y);
    }
    return [Math.round(x), Math.round(y)];
}

// The last `max` characters of `text` (code points, not UTF-16 units), with
// an ellipsis in front when something was cut.
export function trailing(text, max) {
    const chars = Array.from(text);
    return chars.length > max ? `…${chars.slice(-max).join('')}` : text;
}
