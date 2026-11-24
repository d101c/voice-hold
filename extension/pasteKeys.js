// SPDX-License-Identifier: GPL-2.0-or-later

// The paste shortcut of a window, from its WM_CLASS: terminals take
// Ctrl+Shift+V (Ctrl+V is a control character there), everything else
// Ctrl+V. Pure, unit-tested.
const TERMINALS = [
    'gnome-terminal', 'org.gnome.terminal', 'org.gnome.console', 'kgx', 'org.gnome.ptyxis', 'ptyxis',
    'kitty', 'alacritty', 'foot', 'wezterm', 'org.wezfurlong.wezterm', 'ghostty', 'com.mitchellh.ghostty',
    'xterm', 'uxterm', 'konsole', 'tilix', 'terminator', 'blackbox', 'com.raggesilver.blackbox', 'xfce4-terminal',
    'warp', 'dev.warp.warp', 'tabby', 'contour', 'rio',
];

export function isTerminal(wmClass) {
    const c = (wmClass ?? '').toLowerCase();
    return !!c && TERMINALS.some(t => c === t || c.startsWith(`${t}-`) || c.endsWith(`.${t}`));
}


// Windows that must never get a virtual paste: a file manager turns pasted
// text into a new file. The text stays in the clipboard for them.
const NO_PASTE = ['org.gnome.nautilus', 'nautilus', 'nemo', 'thunar', 'dolphin', 'pcmanfm', 'caja',
    'org.gnome.shell.extensions.ding', 'ding'];

export function pasteAllowed(wmClass) {
    const c = (wmClass ?? '').toLowerCase();
    return !!c && !NO_PASTE.includes(c);
}
