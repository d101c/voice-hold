// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/vocabLearn.test.js
import {correction, learned, sameSound} from '../vocabLearn.js';

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

test('a name retyped another way is learned', () => {
    eq(correction('Send the report to Austin before noon.', 'Send the report to Austen before noon.'),
        {from: 'Austin', to: 'Austen'}, 'one letter');
    eq(correction('Je travaille avec Julien Griffite depuis lundi.', 'Je travaille avec Julien Griffit depuis lundi.'),
        {from: 'Griffite', to: 'Griffit'}, 'french name');
    eq(correction('On installe omachi sur le portable.', 'On installe Omarchy sur le portable.'),
        {from: 'omachi', to: 'Omarchy'}, 'brand');
});

test('the text of the field around the dictation does not count', () => {
    eq(correction('We deploy with kubernetes tomorrow morning.',
        'Hello team,\n\nWe deploy with Kubernetes tomorrow morning. Thanks, Julien'),
    {from: 'kubernetes', to: 'Kubernetes'}, 'capital inside the sentence, text before and after');
});

test('two words that are one name', () => {
    eq(correction('I use voice old every day now.', 'I use Voice Hold every day now.'),
        {from: 'voice old', to: 'Voice Hold'}, 'two words');
});

test('a change of mind is not a spelling', () => {
    eq(correction('On se voit lundi à quatorze heures.', 'On se voit mardi à quatorze heures.'), null, 'another word');
    eq(correction('Send it to Mark before noon.', 'Send it to Sarah before noon.'), null, 'another name');
    eq(correction('The cat is on the roof.', 'The dog is on the roof.'), null, 'short words');
});

test('a rewritten sentence teaches nothing', () => {
    eq(correction('Send the report to Austin before noon.', 'Please send the file to Austen after lunch.'), null, 'several changes');
    eq(correction('Send the report to Austin before noon.', 'Send the report to Austin before noon.'), null, 'no change');
    eq(correction('Send the report to Austin before noon.', ''), null, 'field emptied');
    eq(correction('Send the report to Austin before noon.', 'Send the report to Austin before noon, please.'), null, 'words added');
    eq(correction('Send the report to Austin before noon.', 'Send the report before noon.'), null, 'a word removed');
});

test('a capital on the first word is not a spelling, an accent is', () => {
    eq(correction('parakeet works very well here.', 'Parakeet works very well here.'), null, 'first word');
    eq(correction('Le projet de Helene avance bien.', 'Le projet de Hélène avance bien.'),
        {from: 'Helene', to: 'Hélène'}, 'accents');
    eq(correction('We deploy with Kubernetes tomorrow.', 'We deploy with kubernetes tomorrow.'), null, 'lower case only');
});

test('too short a dictation is not watched', () => {
    eq(correction('Hello Austin', 'Hello Austen'), null, 'two words');
});

test('same sound', () => {
    eq([sameSound('Austin', 'Austen'), sameSound('lundi', 'mardi'), sameSound('ab', 'ac'), sameSound('Kodiak', 'Codiak')],
        [true, false, false, false], 'pairs');
});

test('the vocabulary keeps one spelling of a word', () => {
    eq(learned(['Parakeet', 'austen'], 'Austen'), ['Parakeet', 'Austen'], 'replaced');
    eq(learned([], 'Hélène'), ['Hélène'], 'added');
});

if (failures) {
    print(`${failures} failed`);
    imports.system.exit(1);
}
print('all passed');
