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

// -- bottom ------------------------------------------------------------------

export const BOTTOM_GAP = 20;       // px between the pill and what is under it

// Top-left corner of a pill `width` x `height` floating at the bottom of
// `monitor`: centred on it, `gap` px above the lowest of what it must not
// cover. That is the bottom of the work area (a fixed dock or panel reserves
// its room there), and any `obstacle` near the bottom edge that reserves
// nothing (a dock that hides itself and is showing). Obstacles are rects in
// stage coordinates; only those in the monitor's bottom quarter and across
// the pill's width count. Kept inside the work area.
export function bottomPosition({monitor, workArea = null, obstacles = [], width, height, gap = BOTTOM_GAP}) {
    if (!monitor)
        return [0, 0];
    const area = workArea ?? monitor;
    const monitorBottom = monitor.y + monitor.height;
    let x = monitor.x + (monitor.width - width) / 2;
    x = Math.max(area.x, Math.min(x, area.x + area.width - width));
    let floor = Math.min(area.y + area.height, monitorBottom);
    for (const o of obstacles ?? []) {
        const inBottom = o.y >= monitor.y + monitor.height * 3 / 4 && o.y < monitorBottom;
        const across = o.x < x + width && o.x + o.width > x &&
            o.x < monitor.x + monitor.width && o.x + o.width > monitor.x;
        if (inBottom && across && o.height > 0)
            floor = Math.min(floor, o.y);
    }
    const y = Math.max(area.y, floor - gap - height);
    return [Math.round(x), Math.round(y)];
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

// The countdown ring the level bars curl into (hud.js countdown()). `bars`
// are the bars' boxes in the meter ({x, width}), `width` and `height` the
// meter's. Each bar becomes a dot and, being centred vertically by the
// meter, ends up on its middle line whatever height it had a moment ago:
// only its x matters. Returns the translation of each bar so that the dots
// sit clockwise from twelve o'clock on a circle of `radius` around the
// centre of the meter.
export function ringOffsets(bars, width, height, radius) {
    const n = bars.length;
    const cx = width / 2;
    return bars.map((bar, i) => {
        const a = -Math.PI / 2 + 2 * Math.PI * i / n;
        return {
            x: Math.round(cx + radius * Math.cos(a) - (bar.x + bar.width / 2)),
            y: Math.round(radius * Math.sin(a)),
        };
    });
}

// The last `max` characters of `text` (code points, not UTF-16 units), with
// an ellipsis in front when something was cut.
export function trailing(text, max) {
    const chars = Array.from(text);
    return chars.length > max ? `…${chars.slice(-max).join('')}` : text;
}

// The engine's Level (its RMS times 4, 0..1) on a decibel scale, so that a
// whisper still moves the bars and normal speech does not pin them:
// -55 dBFS and below is nothing, -14 dBFS and above is full.
const LEVEL_FLOOR_DB = -55;
const LEVEL_TOP_DB = -14;

export function levelCurve(v) {
    const rms = Math.max(0, Number(v) || 0) / 4;
    if (rms <= 0)
        return 0;
    const db = 20 * Math.log10(rms);
    return Math.max(0, Math.min(1, (db - LEVEL_FLOOR_DB) / (LEVEL_TOP_DB - LEVEL_FLOOR_DB)));
}
