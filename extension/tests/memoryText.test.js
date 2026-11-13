// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/memoryText.test.js
import {llmLowMemory, parseLowMemory, size, speechLowMemory} from '../memoryText.js';

let failures = 0;
function eq(name, got, want) {
    if (JSON.stringify(got) === JSON.stringify(want)) {
        print(`PASS ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
}
const fr = s => ({'%d MB': '%d Mo', '%s GB': '%s Go'}[s] ?? s);

eq('megabytes', size(640), '640 MB');
eq('gigabytes', size(2300), '2.2 GB');
eq('translated units', [size(640, fr), size(1200, fr)], ['640 Mo', '1.2 Go']);
eq('parse', parseLowMemory('low-memory:640:1200'), {free: 640, need: 1200});
eq('parse llm', parseLowMemory('llm-low-memory:900:2300', 'llm-low-memory'), {free: 900, need: 2300});
eq('other errors are not ours', [parseLowMemory('models-missing'), parseLowMemory('low-memory:x:1'), parseLowMemory(null),
    parseLowMemory('llm-low-memory:1:2')], [null, null, null, null]);
eq('speech sentence', speechLowMemory('low-memory:640:1200'),
    'Not enough memory: 640 MB free, 1.2 GB needed');
eq('llm sentence', llmLowMemory('llm-low-memory:900:2300'),
    'Language model: not enough memory (900 MB free, 2.2 GB needed)');
eq('not a memory error', [speechLowMemory('audio: x'), llmLowMemory('llm-off')], [null, null]);

print(failures ? `${failures} failure(s)` : 'all passed');
if (failures)
    imports.system.exit(1);
