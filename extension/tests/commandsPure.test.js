// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/commandsPure.test.js
// The pure helpers of the voice commands: the menu line of a past request
// (commands/recent.js) and the installer's command line
// (commands/installCommand.js).
import GLib from 'gi://GLib';

import {setupArgv, findServiceFile, lastLine, SPEECH_SERVICE} from '../commands/installCommand.js';
import {recentLabel, shorten} from '../commands/recent.js';

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

// -- recent ------------------------------------------------------------------

test('shorten keeps one line and cuts on code points', () => {
    eq(shorten('  a\n b   c ', 10), 'a b c', 'whitespace');
    eq(shorten('abcdef', 4), 'abc…', 'cut');
    eq(shorten('é😀é😀é', 4), 'é😀é…', 'code points, not UTF-16 units');
    eq(shorten(null, 4), '', 'null');
});

test('a command shows its line and a non-zero exit code', () => {
    const e = {ts: '2026-11-11T14:02:33', transcript: 'espace disque', command: 'df -h ~', exit: 0};
    eq(recentLabel(e), '14:02  espace disque  →  $ df -h ~', 'ok');
    eq(recentLabel({...e, exit: 2}), '14:02  espace disque  →  $ df -h ~ (exit 2)', 'default wording');
    eq(recentLabel({...e, exit: 2}, c => ` (code ${c})`), '14:02  espace disque  →  $ df -h ~ (code 2)', 'caller wording');
    eq(recentLabel({...e, exit: null}), '14:02  espace disque  →  $ df -h ~', 'still running');
});

test('an action shows its result, then what was said, then its name', () => {
    const e = {ts: '2026-11-11T09:00:00', transcript: 'ouvre firefox', action: 'open_app'};
    eq(recentLabel({...e, result: 'Opening Firefox', say: 'x'}), '09:00  ouvre firefox  →  Opening Firefox', 'result');
    eq(recentLabel({...e, say: 'Done'}), '09:00  ouvre firefox  →  Done', 'say');
    eq(recentLabel(e), '09:00  ouvre firefox  →  open_app', 'action');
    eq(recentLabel({transcript: 'x', action: 'lock'}), '  x  →  lock', 'no timestamp');
});

// -- installer command -------------------------------------------------------

test('setup argv follows the Exec line of the speech engine', () => {
    eq(setupArgv('[D-BUS Service]\nName=org.griffit.VoiceHold\nExec=/v/bin/python3 -m voice_hold_engine serve\n'),
        ['/v/bin/python3', '-m', 'voice_hold_engine', 'setup', '--commands'], 'venv or pipx');
    eq(setupArgv('[D-BUS Service]\nExec=/usr/bin/env PYTHONPATH=/h/hold/pylib VOICE_HOLD_MODELS=/h/m /usr/bin/python3 -m voice_hold_engine serve\n'),
        ['/usr/bin/env', 'PYTHONPATH=/h/hold/pylib', 'VOICE_HOLD_MODELS=/h/m', '/usr/bin/python3', '-m', 'voice_hold_engine', 'setup', '--commands'],
        'the Installation page');
    eq(setupArgv('Exec=/x/voice-hold-engine serve'), ['/x/voice-hold-engine', 'setup', '--commands'], 'script');
    eq(setupArgv('Exec="/a b/python3" -m voice_hold_engine serve'), ['/a b/python3', '-m', 'voice_hold_engine', 'setup', '--commands'], 'quoted path');
});

test('setup argv refuses what it does not know', () => {
    eq(setupArgv(''), null, 'empty');
    eq(setupArgv(null), null, 'null');
    eq(setupArgv('[D-BUS Service]\nName=x\n'), null, 'no Exec');
    eq(setupArgv('Exec=/usr/bin/python3 -m voice_hold_engine'), null, 'no serve');
    eq(setupArgv('Exec=/usr/bin/other serve'), null, 'another program');
    eq(setupArgv('Exec=/x/python3 -m "voice_hold_engine serve'), null, 'unbalanced quote');
});

test('the service file is looked up in each data dir, in order', () => {
    const base = GLib.dir_make_tmp('vh-test-XXXXXX');
    const a = GLib.build_filenamev([base, 'a']);
    const b = GLib.build_filenamev([base, 'b']);
    const dir = GLib.build_filenamev([b, 'dbus-1', 'services']);
    GLib.mkdir_with_parents(dir, 0o755);
    const file = GLib.build_filenamev([dir, SPEECH_SERVICE]);
    eq(findServiceFile([a, b]), null, 'none yet');
    GLib.file_set_contents(file, 'Exec=x serve\n');
    eq(findServiceFile([a, b]), file, 'found in the second');
    GLib.unlink(file);
    for (const d of [dir, GLib.build_filenamev([b, 'dbus-1']), b, base])
        GLib.rmdir(d);
});

test('last line: after the last break or carriage return, trimmed, cut', () => {
    eq(lastLine('a\nb\n'), 'b', 'newline');
    eq(lastLine('model  10%\rmodel  55%\r'), 'model  55%', 'progress rewritten in place');
    eq(lastLine('  \n'), '', 'blank');
    eq(lastLine(''), '', 'empty');
    eq(lastLine('abcdef', 4), 'abc…', 'cut');
});

if (failures) {
    print(`${failures} FAILED`);
    imports.system.exit(1);
}
print('all passed');
