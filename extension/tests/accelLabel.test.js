// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/accelLabel.test.js
import {accelLabel} from '../accelLabel.js';

let failures = 0;
function eq(name, got, want) {
    if (got === want) {
        print(`PASS ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
}
const fr = s => ({Space: 'Espace', Shift: 'Maj'}[s] ?? s);

eq('ctrl space', accelLabel('<Control>space'), 'Ctrl+Space');
eq('translated', accelLabel('<Control>space', fr), 'Ctrl+Espace');
eq('two modifiers', accelLabel('<Control><Alt>space', fr), 'Ctrl+Alt+Espace');
eq('letter', accelLabel('<Super>x'), 'Super+X');
eq('shift', accelLabel('<Shift><Super>F9', fr), 'Super+Maj+F9');
eq('primary', accelLabel('<Primary>d'), 'Ctrl+D');
eq('empty', accelLabel(''), '');

print(failures ? `${failures} failure(s)` : 'all passed');
