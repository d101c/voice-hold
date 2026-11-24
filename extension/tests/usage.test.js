// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/usage.test.js
import {countWords, dayKey, duration, record, shiftDay, summarize} from '../usage.js';

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

test('words are counted as a reader would', () => {
    eq(countWords("Un café crème à Noël, s'il vous plaît."), 8, 'french, elision is one word');
    eq(countWords("Let's meet at 10, twenty-five people."), 6, 'english, hyphen and apostrophe');
    eq(countWords('  …  \n'), 0, 'no word');
    eq(countWords(null), 0, 'null');
});

test('days shift across months and years', () => {
    eq(dayKey(new Date(2026, 10, 4)), '2026-11-04', 'padded');
    eq(shiftDay('2026-03-01', -1), '2026-02-28', 'month');
    eq(shiftDay('2026-12-31', 1), '2027-01-01', 'year');
});

test('record adds to the day and drops what is too old', () => {
    let d = record({}, '2026-11-24', 12, 6.04);
    d = record(d, '2026-11-24', 8, 3);
    eq(d, {'2026-11-24': {w: 20, s: 9, n: 2}}, 'same day');
    d = record({'2020-01-01': {w: 5, s: 2, n: 1}, 'junk': 3, '2026-11-23': {w: 'x'}}, '2026-11-24', 1, 1);
    eq(Object.keys(d), ['2026-11-24'], 'old and bad entries dropped');
    eq(record({'2026-11-24': {w: 3, s: 1, n: 1}}, '2026-11-24', 0, 5), {'2026-11-24': {w: 3, s: 1, n: 1}}, 'no word, no count');
});

test('summary: totals, speed, time saved', () => {
    const s = summarize({'2026-11-23': {w: 300, s: 120, n: 4}, '2026-11-24': {w: 100, s: 60, n: 2}}, '2026-11-24');
    eq([s.words, s.seconds, s.dictations, s.today, s.week], [400, 180, 6, 100, 400], 'totals');
    eq(s.wpm, 133, '400 words in 3 minutes');
    eq(s.savedSeconds, 420, '10 minutes of typing at 40 wpm, minus 3 spoken');
    eq(s.since, '2026-11-23', 'since');
    eq(s.last30.length, 30, '30 days');
    eq(s.last30.slice(-2).map(x => x.words), [300, 100], 'the last two days');
});

test('summary: an empty file is all zeros', () => {
    const s = summarize(null, '2026-11-24');
    eq([s.words, s.wpm, s.savedSeconds, s.streak, s.best, s.since], [0, 0, 0, 0, 0, ''], 'zeros');
});

test('streak counts days in a row and survives until the day is over', () => {
    const d = {'2026-11-20': {w: 1, s: 1, n: 1}, '2026-11-22': {w: 1, s: 1, n: 1}, '2026-11-23': {w: 1, s: 1, n: 1}};
    eq(summarize(d, '2026-11-23').streak, 2, 'ending today');
    eq(summarize(d, '2026-11-24').streak, 2, 'today has none yet');
    eq(summarize(d, '2026-11-25').streak, 0, 'a day was missed');
    eq(summarize(d, '2026-11-25').best, 2, 'best run');
});

test('durations read like a clock', () => {
    eq([duration(45), duration(125), duration(3600), duration(4800)], ['45 s', '2 min', '1 h', '1 h 20 min'], 'durations');
});

if (failures) {
    print(`${failures} failed`);
    imports.system.exit(1);
}
print('all passed');
