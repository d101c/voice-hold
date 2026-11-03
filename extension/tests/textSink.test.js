// Run: gjs -m extension/tests/textSink.test.js
import {joinBlock, surroundingChar, TextSink} from '../textSink.js';

let failures = 0;
function eq(actual, expected, msg) {
    if (actual !== expected) {
        failures++;
        print(`FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    } else {
        print(`PASS ${msg}`);
    }
}

// -- joinBlock ---------------------------------------------------------------

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

// -- surroundingChar ---------------------------------------------------------

eq(surroundingChar(['abc', 3, 3]), 'c', 'GNOME 46+: 3-tuple');
eq(surroundingChar(['abc', 3]), 'c', 'GNOME 45: 2-tuple, anchor = cursor');
eq(surroundingChar(['abc', 1, 3]), null, 'selection: unknown');
eq(surroundingChar(['abc', 0, 0]), '', 'start of field');
eq(surroundingChar(['héé', 2, 2]), 'é', 'cursor counts characters, not bytes');
eq(surroundingChar(['abc', 9, 9]), null, 'cursor past the text: unknown');
eq(surroundingChar([null, 0, 0]), null, 'no text: unknown');
eq(surroundingChar(undefined), null, 'no result: unknown');

// -- TextSink on a fake input method -----------------------------------------

const CLUTTER = {PreeditResetMode: {CLEAR: 0}};

function fakeIm({surrounding = null} = {}) {
    const focus = {id: 'field-1'};
    return {
        currentFocus: focus,
        surrounding,                      // what getSurroundingText() returns
        commits: [],
        preedits: [],
        getSurroundingText() {
            if (this.surrounding === null)
                throw new Error('no surrounding text');
            return this.surrounding;
        },
        set_preedit_text(text) {
            this.preedits.push(text);
        },
        commit(text) {
            this.commits.push(text);
        },
    };
}

{
    // GNOME 45 shape, and an application whose surrounding text never
    // updates: the sink must rely on what it committed itself.
    const im = fakeIm({surrounding: ['Hello', 5]});
    const sink = new TextSink(im, CLUTTER);
    sink.begin();
    eq(sink.commit('Bonjour'), true, 'first block committed');
    eq(sink.commit('\n'), true, 'newline block committed');
    eq(sink.commit('ça va'), true, 'block after newline committed');
    eq(sink.commit('bien'), true, 'fourth block committed');
    eq(JSON.stringify(im.commits), JSON.stringify([' Bonjour', '\n', 'ça va', ' bien']),
        'space from the app text, none after our own newline, one between words');
}

{
    // Stale surrounding text ('' at cursor 0 for ever): the last committed
    // character wins over what the application reports.
    const im = fakeIm({surrounding: ['', 0, 0]});
    const sink = new TextSink(im, CLUTTER);
    sink.begin();
    sink.commit('Bonjour');
    sink.commit('tout le monde');
    eq(JSON.stringify(im.commits), JSON.stringify(['Bonjour', ' tout le monde']),
        'stale surrounding text does not glue two blocks');
}

{
    // No surrounding text at all (terminal): a space between blocks.
    const im = fakeIm();
    const sink = new TextSink(im, CLUTTER);
    sink.begin();
    sink.partial('Bon');
    sink.commit('Bonjour');
    sink.partial('ça');
    sink.commit('ça va');
    eq(JSON.stringify(im.commits), JSON.stringify(['Bonjour', ' ça va']), 'unknown context: space between blocks');
    eq(JSON.stringify(im.preedits), JSON.stringify(['Bon', '', ' ça', '']), 'preedit spaced like the block, cleared before commit');
}

{
    // A block that ends with a newline (trailing "new line" command).
    const im = fakeIm();
    const sink = new TextSink(im, CLUTTER);
    sink.begin();
    sink.commit('Bonjour\n');
    sink.commit('ça va');
    eq(JSON.stringify(im.commits), JSON.stringify(['Bonjour\n', 'ça va']), 'no space at the start of a line');
}

{
    // Focus moved after begin(): nothing is written there, the preedit of
    // the old field is not touched either.
    const im = fakeIm();
    const sink = new TextSink(im, CLUTTER);
    sink.begin();
    sink.partial('Bon');
    im.currentFocus = {id: 'password-dialog'};
    eq(sink.focused, false, 'focus change detected');
    eq(sink.partial('Bonjour'), false, 'partial refused');
    eq(sink.commit('Bonjour'), false, 'commit refused');
    sink.end();
    eq(JSON.stringify(im.commits), JSON.stringify([]), 'nothing committed');
    eq(JSON.stringify(im.preedits), JSON.stringify(['Bon']), 'no preedit sent to the new field');
    im.currentFocus = null;
    eq(sink.available, false, 'no focus: unavailable');
    eq(sink.commit('x'), false, 'commit refused without focus');
}

{
    // begin() resets the context: a new session starts from the app's text.
    const im = fakeIm({surrounding: ['x.', 2, 2]});
    const sink = new TextSink(im, CLUTTER);
    sink.begin();
    sink.commit('un\n');
    sink.begin();
    sink.commit('deux');
    eq(JSON.stringify(im.commits), JSON.stringify([' un\n', ' deux']), 'new session: context from the application again');
}

print(failures ? `${failures} failure(s)` : 'all passed');
if (failures)
    imports.system.exit(1);
