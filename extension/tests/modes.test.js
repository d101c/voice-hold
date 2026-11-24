// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/modes.test.js
import {categoryOf, instructionFor, MODES} from '../modes.js';

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

test('applications by their class', () => {
    eq(categoryOf('thunderbird'), 'email', 'thunderbird');
    eq(categoryOf('org.gnome.Geary'), 'email', 'geary');
    eq(categoryOf('Slack'), 'chat', 'slack');
    eq(categoryOf('discord'), 'chat', 'discord');
    eq(categoryOf('code'), 'code', 'vs code');
    eq(categoryOf('org.gnome.TextEditor'), 'other', 'text editor');
});

test('web mail and chat by the window title', () => {
    eq(categoryOf('firefox', 'Boîte de réception (3) - julien@example.org - Gmail — Mozilla Firefox'), 'email', 'gmail');
    eq(categoryOf('google-chrome', 'Slack | general | Team'), 'chat', 'slack web');
    eq(categoryOf('firefox', 'Wikipedia — Mozilla Firefox'), 'other', 'other page');
    eq(categoryOf(null, null), 'other', 'nothing');
});

test('instructions', () => {
    eq(instructionFor('as-said'), '', 'as said');
    eq(instructionFor('unknown'), '', 'unknown');
    eq(instructionFor('custom', '  Translate into English.  '), 'Translate into English.', 'custom');
    eq(instructionFor('custom', ''), '', 'empty custom');
    for (const m of ['message', 'email', 'notes'])
        eq(instructionFor(m).length > 40, true, m);
    eq(MODES[0], 'as-said', 'first mode');
});

if (failures)
    imports.system.exit(1);
print('all passed');
