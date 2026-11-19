// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/accentColor.test.js
import {accentColor, accentHex, rgba} from '../accentColor.js';

let failures = 0;
function eq(name, got, want) {
    if (got === want) {
        print(`PASS ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
}

eq('named', accentHex('slate'), '#6f8396');
eq('unknown falls back to blue', accentHex('chartreuse'), '#3584e4');
eq('rgba', rgba('#3584e4', 0.9), 'rgba(53,132,228,0.9)');
eq('system value is a colour', /^#[0-9a-f]{6}$/.test(accentColor()), true);

print(failures ? `${failures} failure(s)` : 'all passed');
