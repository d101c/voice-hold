// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/pasteKeys.test.js
import {isTerminal, pasteAllowed} from '../pasteKeys.js';

let failures = 0;
function test(name, fn) {
    try {
        fn();
        print(`PASS ${name}`);
    } catch (e) {
        failures++;
        print(`FAIL ${name}: ${e.message}`);
    }
}
function eq(got, want, msg) {
    if (got !== want)
        throw new Error(`${msg}: got ${got}, want ${want}`);
}

test('terminals paste with Ctrl+Shift+V', () => {
    for (const c of ['Gnome-terminal', 'gnome-terminal-server', 'org.gnome.Ptyxis', 'kitty', 'Alacritty',
        'org.wezfurlong.wezterm', 'com.mitchellh.ghostty', 'org.gnome.Console', 'foot'])
        eq(isTerminal(c), true, c);
});

test('other applications paste with Ctrl+V', () => {
    for (const c of ['code', 'Code', 'Slack', 'discord', 'firefox', 'google-chrome', 'org.gnome.TextEditor',
        'obsidian', 'terminal-notes', '', null, undefined])
        eq(isTerminal(c), false, String(c));
});

test('no virtual paste into a file manager or without a window class', () => {
    for (const c of ['org.gnome.Nautilus', 'nemo', 'Thunar', '', null])
        eq(pasteAllowed(c), false, String(c));
    for (const c of ['code', 'Slack', 'kitty'])
        eq(pasteAllowed(c), true, c);
});

if (failures)
    imports.system.exit(1);
print('all passed');
