// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/history.test.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {add, clear, load, prune} from '../history.js';

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

const DAY = 86400;

test('prune keeps the recent ones, newest first', () => {
    const e = [{at: 100, text: 'a'}, {at: 100 + 3 * DAY, text: 'b'}, {at: 100 + 9 * DAY, text: 'c'}];
    eq(prune(e, 100 + 9 * DAY, 7).map(x => x.text), ['c', 'b'], '7 days');
    eq(prune(e, 100 + 9 * DAY, -1).map(x => x.text), ['c', 'b', 'a'], 'forever');
    eq(prune(e, 100 + 9 * DAY, 0), [], 'off');
    eq(prune(e, 100 + 9 * DAY, -1, 1).map(x => x.text), ['c'], 'cap');
    eq(prune([null, {text: 1}, {at: 'x', text: 'y'}], 0, -1), [], 'bad entries');
});

test('add, load, clear on a file', () => {
    const dir = GLib.dir_make_tmp('vh-hist-XXXXXX');
    const file = Gio.File.new_for_path(`${dir}/sub/dictations.json`);
    add('Bonjour Léa', 'org.gnome.TextEditor', 7, file);
    add('  ', 'x', 7, file);
    add('Second', 'firefox', 7, file);
    eq(load(file).map(x => x.text), ['Second', 'Bonjour Léa'], 'two entries');
    add('Not kept', 'x', 0, file);
    eq(load(file).length, 2, 'off adds nothing');
    clear(file);
    eq(load(file), [], 'cleared');
});

if (failures)
    imports.system.exit(1);
print('all passed');
