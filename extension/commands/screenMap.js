// SPDX-License-Identifier: GPL-2.0-or-later

// Pure helpers of the on-screen help (screen.js, pointer.js), testable with
// plain gjs (tests/screenMap.test.js).

// A point of the window picture the model saw -> a point of the screen.
// `screen` is {width, height, rect: {x, y, width, height}}: the picture's
// size and where the window's frame was on screen when it was taken.
export function toScreen(screen, x, y) {
    if (!screen?.width || !screen?.height || !screen.rect)
        return null;
    const px = Math.max(0, Math.min(screen.width, Number(x)));
    const py = Math.max(0, Math.min(screen.height, Number(y)));
    if (!Number.isFinite(px) || !Number.isFinite(py))
        return null;
    return [
        Math.round(screen.rect.x + px * screen.rect.width / screen.width),
        Math.round(screen.rect.y + py * screen.rect.height / screen.height),
    ];
}

// The size a picture is scaled down to, keeping its ratio: the longest side
// at most `max` pixels (models see large pictures scaled anyway, and the
// coordinates they give must be those of the picture they saw).
export function fitWithin(width, height, max) {
    const longest = Math.max(width, height);
    if (longest <= max)
        return [width, height];
    const k = max / longest;
    return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
}

const KEY_NAMES = {
    ctrl: 'Control_L', control: 'Control_L', ctl: 'Control_L',
    shift: 'Shift_L', alt: 'Alt_L', super: 'Super_L', meta: 'Super_L', win: 'Super_L',
    enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab',
    space: 'space', backspace: 'BackSpace', delete: 'Delete', del: 'Delete', insert: 'Insert',
    home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    plus: 'plus', minus: 'minus', comma: 'comma', period: 'period', slash: 'slash',
};
const MODIFIERS = new Set(['Control_L', 'Shift_L', 'Alt_L', 'Super_L']);

// "ctrl+shift+t" -> ['Control_L', 'Shift_L', 't'] (Clutter.KEY_ names
// without the prefix), modifiers first; null when a part is unknown or
// there is no key that is not a modifier.
export function keyCombo(text) {
    const parts = String(text ?? '').toLowerCase().split(/\s*\+\s*/).filter(Boolean);
    if (!parts.length)
        return null;
    const names = [];
    for (const p of parts) {
        if (KEY_NAMES[p])
            names.push(KEY_NAMES[p]);
        else if (/^f([1-9]|1[0-2])$/.test(p))
            names.push(p.toUpperCase());
        else if (/^[a-z0-9]$/.test(p))
            names.push(p);
        else
            return null;
    }
    const mods = names.filter(n => MODIFIERS.has(n));
    const keys = names.filter(n => !MODIFIERS.has(n));
    if (keys.length !== 1)
        return null;
    return [...new Set(mods), keys[0]];
}

// "ctrl+shift+t" -> "Ctrl+Shift+T", for the confirmation.
export function keyLabel(text) {
    const combo = keyCombo(text);
    if (!combo)
        return String(text ?? '');
    const pretty = {Control_L: 'Ctrl', Shift_L: 'Shift', Alt_L: 'Alt', Super_L: 'Super', Return: 'Enter',
        Escape: 'Esc', BackSpace: 'Backspace', Page_Up: 'Page Up', Page_Down: 'Page Down', space: 'Space'};
    return combo.map(n => pretty[n] ?? (n.length === 1 ? n.toUpperCase() : n)).join('+');
}
