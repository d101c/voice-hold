// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/wakeRules.test.js
import {pauseReason, phrasesOf} from '../wakeRules.js';

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

test('phrases', () => {
    eq(phrasesOf('Hé Holdie'), ['Hé Holdie'], 'one');
    eq(phrasesOf(' Hé Holdie , Hey Holdie;'), ['Hé Holdie', 'Hey Holdie'], 'several');
    eq(phrasesOf(''), [], 'none');
    eq(phrasesOf(null), [], 'null');
});

test('pause reasons, in order', () => {
    const on = {enabled: true, locked: false, onBattery: false, onBatteryOk: false, othersRecording: false};
    eq(pauseReason(on), '', 'listening');
    eq(pauseReason({...on, enabled: false, locked: true}), 'off', 'off first');
    eq(pauseReason({...on, locked: true}), 'locked', 'locked');
    eq(pauseReason({...on, othersRecording: true}), 'recording', 'a call');
    eq(pauseReason({...on, onBattery: true}), 'battery', 'battery');
    eq(pauseReason({...on, onBattery: true, onBatteryOk: true}), '', 'battery allowed');
});

if (failures)
    imports.system.exit(1);
print('all passed');
