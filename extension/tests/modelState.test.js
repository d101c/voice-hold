// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/modelState.test.js
import {modelState, statusLine} from '../modelState.js';

// String.prototype.format comes from the Shell; a minimal one for gjs.
String.prototype.format ??= function (...args) {
    let i = 0;
    return this.replace(/%[ds]/g, () => String(args[i++]));
};

let failures = 0;
function eq(name, got, want) {
    if (got === want) {
        print(`PASS ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
}

eq('off wins', modelState({enabled: false, running: true, model: 'ready'}), 'disabled');
eq('engine gone', modelState({enabled: true, running: false, model: 'ready'}), 'asleep');
eq('ready', modelState({enabled: true, running: true, model: 'ready'}), 'ready');
eq('loading', modelState({enabled: true, running: true, model: 'loading'}), 'loading');
eq('unknown', modelState({enabled: true, running: true, model: ''}), 'asleep');

eq('ready with time', statusLine('ready', 1390), 'Speech model ready — released in 23 min');
eq('ready, under a minute', statusLine('ready', 12), 'Speech model ready — released in 1 min');
eq('ready, no time', statusLine('ready', -1), 'Speech model ready');
eq('asleep', statusLine('asleep'), 'Speech model asleep — a few seconds at the first word');

print(failures ? `${failures} failure(s)` : 'all passed');
