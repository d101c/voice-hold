// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/screenMap.test.js
import {fitWithin, keyCombo, keyLabel, toScreen} from '../commands/screenMap.js';

let failures = 0;
function eq(name, got, want) {
    if (JSON.stringify(got) === JSON.stringify(want)) {
        print(`PASS ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
}

const screen = {width: 1280, height: 800, rect: {x: 100, y: 50, width: 2560, height: 1600}};
eq('scaled picture to screen', toScreen(screen, 640, 400), [1380, 850]);
eq('origin', toScreen(screen, 0, 0), [100, 50]);
eq('clamped', toScreen(screen, 9999, -5), [2660, 50]);
eq('no screen', toScreen(null, 1, 1), null);
eq('fit', fitWithin(2560, 1600, 1280), [1280, 800]);
eq('small stays', fitWithin(800, 600, 1280), [800, 600]);
eq('combo', keyCombo('ctrl+shift+t'), ['Control_L', 'Shift_L', 't']);
eq('combo spaces and case', keyCombo('Ctrl + H'), ['Control_L', 'h']);
eq('function key', keyCombo('f11'), ['F11']);
eq('enter', keyCombo('enter'), ['Return']);
eq('unknown', keyCombo('ctrl+banana'), null);
eq('only modifiers', keyCombo('ctrl+shift'), null);
eq('label', keyLabel('ctrl+shift+t'), 'Ctrl+Shift+T');

print(failures ? `${failures} failure(s)` : 'all passed');
