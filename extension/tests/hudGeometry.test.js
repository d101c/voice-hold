// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/hudGeometry.test.js
import {
    CURSOR_GAP, ISLAND_OVERLAP, POINTER_GAP,
    cursorPosition, islandPosition, islandTop, monitorAt, trailing,
} from '../hudGeometry.js';

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
    if (JSON.stringify(got) !== JSON.stringify(want))
        throw new Error(`${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const PRIMARY = {x: 0, y: 0, width: 1920, height: 1080};
const RIGHT = {x: 1920, y: 0, width: 1280, height: 1024};
const BAR = {x: 0, y: 0, width: 1920, height: 32, visible: true};

// -- island ----------------------------------------------------------------

test('island hangs from the bottom of the top bar', () => {
    eq(islandTop(PRIMARY, BAR), 32, 'top');
    eq(islandPosition(PRIMARY, BAR, 300), [810, 32 - ISLAND_OVERLAP], 'centred under the bar');
});

test('hidden bar (fullscreen window): the island hangs from the screen edge', () => {
    eq(islandTop(PRIMARY, {...BAR, visible: false}), 0, 'top');
    eq(islandPosition(PRIMARY, {...BAR, visible: false}, 300), [810, -ISLAND_OVERLAP], 'position');
});

test('no bar, or a bar without height', () => {
    eq(islandTop(PRIMARY, null), 0, 'null bar');
    eq(islandTop(PRIMARY, {...BAR, height: 0}), 0, 'collapsed bar');
});

test('bar moved to the bottom of the screen is no anchor', () => {
    eq(islandTop(PRIMARY, {...BAR, y: 1080 - 48, height: 48}), 0, 'top');
});

test('bar slid out of the screen is no anchor, half slid is', () => {
    eq(islandTop(PRIMARY, {...BAR, y: -32}), 0, 'fully out');
    eq(islandTop(PRIMARY, {...BAR, y: -16}), 16, 'half out');
});

test('bar of another monitor is no anchor', () => {
    eq(islandTop(RIGHT, BAR), 0, 'top');
});

test('primary monitor that is not at the origin', () => {
    const m = {x: 1280, y: 200, width: 1920, height: 1080};
    const bar = {x: 1280, y: 200, width: 1920, height: 32, visible: true};
    eq(islandPosition(m, bar, 400), [1280 + 760, 232 - ISLAND_OVERLAP], 'position');
});

test('odd widths are rounded to whole pixels', () => {
    const [x] = islandPosition(PRIMARY, BAR, 301);
    eq(Number.isInteger(x), true, 'integer x');
});

test('no monitor at all does not throw', () => {
    eq(islandPosition(null, null, 200), [0, -ISLAND_OVERLAP], 'position');
});

// -- next to the cursor ----------------------------------------------------

const BOTH = [PRIMARY, RIGHT];
const at = o => cursorPosition({monitors: BOTH, primary: PRIMARY, width: 200, height: 40, pointer: [0, 0], ...o});

test('below the text cursor', () => {
    eq(at({cursor: {x: 500, y: 300, width: 2, height: 20}}), [500, 320 + CURSOR_GAP], 'position');
});

test('below the pointer when the application reports no cursor', () => {
    eq(at({cursor: null, pointer: [640, 400]}), [640, 400 + POINTER_GAP], 'null cursor');
    eq(at({cursor: {x: 0, y: 0, width: 0, height: 0}, pointer: [640, 400]}), [640, 400 + POINTER_GAP], 'zero cursor');
});

test('flips above the text cursor at the bottom of the monitor', () => {
    eq(at({cursor: {x: 500, y: 1050, width: 2, height: 20}}), [500, 1050 - 40 - CURSOR_GAP], 'position');
});

test('flips above the pointer at the bottom of the monitor', () => {
    eq(at({cursor: {x: 0, y: 0, width: 0, height: 0}, pointer: [640, 1070]}), [640, 1070 - 40 - CURSOR_GAP], 'position');
});

test('kept inside the right edge of its own monitor', () => {
    eq(at({cursor: {x: 1900, y: 300, width: 2, height: 20}}), [1920 - 200, 320 + CURSOR_GAP], 'primary');
    eq(at({cursor: {x: 3190, y: 300, width: 2, height: 20}}), [3200 - 200, 320 + CURSOR_GAP], 'secondary');
});

test('at the bottom of a secondary monitor it stays on that monitor', () => {
    // The point below the anchor is on no monitor: the anchor's own decides.
    eq(at({cursor: {x: 2500, y: 1000, width: 2, height: 20}}), [2500, 1000 - 40 - CURSOR_GAP], 'text cursor');
    eq(at({cursor: null, pointer: [2500, 1010]}), [2500, 1010 - 40 - CURSOR_GAP], 'pointer');
});

test('a point on no monitor falls back to the primary one', () => {
    eq(monitorAt(BOTH, 5000, 5000, PRIMARY), PRIMARY, 'fallback');
    eq(monitorAt(BOTH, 2000, 10), RIGHT, 'right');
    eq(monitorAt(undefined, 1, 1, PRIMARY), PRIMARY, 'no list');
});

// -- text -------------------------------------------------------------------

test('trailing keeps short text as is', () => {
    eq(trailing('bonjour', 10), 'bonjour', 'short');
    eq(trailing('', 10), '', 'empty');
});

test('trailing keeps the end, with an ellipsis', () => {
    eq(trailing('abcdefghij', 4), '…ghij', 'cut');
});

test('trailing counts code points, not UTF-16 units', () => {
    eq(trailing('a😀b😀c', 3), '…b😀c', 'emoji');
    eq(trailing('😀😀', 2), '😀😀', 'exact');
});

print(failures ? `${failures} failure(s)` : 'all passed');
if (failures)
    imports.system.exit(1);
