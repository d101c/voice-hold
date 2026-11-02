// Run: gjs -m extension/tests/textSink.test.js
import {joinBlock} from '../textSink.js';

let failures = 0;
function eq(actual, expected, msg) {
    if (actual !== expected) {
        failures++;
        print(`FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    } else {
        print(`PASS ${msg}`);
    }
}

eq(joinBlock('', 'Bonjour'), 'Bonjour', 'start of field: no space');
eq(joinBlock('.', 'Bonjour'), ' Bonjour', 'after a period: space');
eq(joinBlock('e', 'suite'), ' suite', 'after a letter: space');
eq(joinBlock(' ', 'suite'), 'suite', 'after a space: none');
eq(joinBlock('\n', 'suite'), 'suite', 'after a newline: none');
eq(joinBlock('(', 'suite'), 'suite', 'after an opening bracket: none');
eq(joinBlock("'", 'suite'), 'suite', 'after an apostrophe: none');
eq(joinBlock(null, 'Bonjour', {firstOfSession: true}), 'Bonjour', 'unknown context, first block: as is');
eq(joinBlock(null, 'suite', {firstOfSession: false}), ' suite', 'unknown context, later block: space');
eq(joinBlock('e', '\n'), '\n', 'line break block: never spaced');
eq(joinBlock('e', ''), '', 'empty block');

print(failures ? `${failures} failure(s)` : 'all passed');
if (failures)
    imports.system.exit(1);
