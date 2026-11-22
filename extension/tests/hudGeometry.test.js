// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/hudGeometry.test.js
import {
    BOTTOM_GAP, CURSOR_GAP, ISLAND_OVERLAP, POINTER_GAP, bottomPosition,
    cursorPosition, islandPosition, islandTop, levelCurve, monitorAt, trailing,
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

// -- bottom ----------------------------------------------------------------

const bottom = o => bottomPosition({monitor: PRIMARY, width: 300, height: 50, ...o});

test('bottom: centred, a gap above the screen edge when nothing is reserved', () => {
    eq(bottom({}), [810, 1080 - BOTTOM_GAP - 50], 'position');
});

test('bottom: above a fixed dock, which shrinks the work area', () => {
    const workArea = {x: 0, y: 32, width: 1920, height: 1080 - 32 - 72};
    eq(bottom({workArea}), [810, 1080 - 72 - BOTTOM_GAP - 50], 'position');
});

test('bottom: above a dock that hides itself, while it shows', () => {
    const dock = {x: 700, y: 1080 - 72, width: 520, height: 72};
    eq(bottom({obstacles: [dock]}), [810, 1080 - 72 - BOTTOM_GAP - 50], 'position');
});

test('bottom: a dock slid out of the screen, or high up, or off to the side, is ignored', () => {
    const want = [810, 1080 - BOTTOM_GAP - 50];
    eq(bottom({obstacles: [{x: 700, y: 1080, width: 520, height: 72}]}), want, 'slid out');
    eq(bottom({obstacles: [{x: 0, y: 32, width: 72, height: 1000}]}), want, 'left dock');
    eq(bottom({obstacles: [{x: 1700, y: 1000, width: 200, height: 80}]}), want, 'not across the pill');
    eq(bottom({obstacles: [{x: 2000, y: 1000, width: 500, height: 80}]}), want, 'other monitor');
});

test('bottom: a left dock narrows the work area, the pill stays on the screen centre', () => {
    const workArea = {x: 72, y: 32, width: 1920 - 72, height: 1080 - 32};
    eq(bottom({workArea}), [810, 1080 - BOTTOM_GAP - 50], 'position');
});

test('bottom: a pill wider than the free room is kept inside the work area', () => {
    const workArea = {x: 72, y: 32, width: 400, height: 1048};
    eq(bottom({workArea, width: 600}), [72, 1080 - BOTTOM_GAP - 50], 'left edge of the area');
});

test('bottom: a tall pill never goes above the work area', () => {
    const workArea = {x: 0, y: 32, width: 1920, height: 300};
    eq(bottom({workArea, height: 400}), [810, 32], 'top of the area');
});

test('bottom: second monitor, scaled gap', () => {
    eq(bottomPosition({monitor: RIGHT, width: 200, height: 40, gap: 40}), [1920 + 540, 1024 - 40 - 40], 'position');
});

test('bottom: no monitor does not throw', () => {
    eq(bottomPosition({monitor: null, width: 10, height: 10}), [0, 0], 'position');
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

test('level curve: whisper visible, speech not pinned, silence flat', () => {
    eq(levelCurve(0), 0, 'silence');
    eq(levelCurve(4 * 0.0015) < 0.05, true, 'room noise');
    const whisper = levelCurve(4 * 0.008);      // about -42 dBFS
    eq(whisper > 0.25 && whisper < 0.45, true, `whisper ${whisper}`);
    const speech = levelCurve(4 * 0.08);        // about -22 dBFS
    eq(speech > 0.7 && speech < 0.95, true, `speech ${speech}`);
    eq(levelCurve(1), 1, 'loud');
    eq(levelCurve(-1), 0, 'nonsense');
});

print(failures ? `${failures} failure(s)` : 'all passed');
if (failures)
    imports.system.exit(1);
