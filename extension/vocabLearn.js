// SPDX-License-Identifier: GPL-2.0-or-later

// Learn a word from a correction. After a dictation, when one word of what
// was just written is retyped another way in the same field ("Austin" into
// "Austen"), the new spelling joins the vocabulary, so the recogniser's
// version is written that way from then on (vocab.py corrects what sounds
// like an entry).
//
// What the field holds is read through the input method (the text around
// the cursor, as the application reports it), for WATCH_MS after the
// dictation and only while that field keeps the focus. Nothing is kept but
// the word that is learned.
import GLib from 'gi://GLib';

export const WATCH_MS = 45000;
const POLL_MS = 700;
// A correction counts once it has stayed the same this long: the word is
// finished, not half typed.
const SETTLE_MS = 2400;

const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function words(text) {
    return String(text ?? '').match(WORD_RE) ?? [];
}

function plain(word) {
    return word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function distance(a, b) {
    let prev = Array.from({length: b.length + 1}, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++)
            cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
        prev = cur;
    }
    return prev[b.length];
}

// Two spellings of what could be the same spoken word: close letters
// ("Austin", "Austen"; "griffite", "Griffit"), not another word altogether
// ("lundi", "mardi": that is a change of mind, nothing to learn).
export function sameSound(from, to) {
    const a = plain(from), b = plain(to);
    if (!a || !b)
        return false;
    const longest = Math.max(a.length, b.length);
    if (longest < 4)
        return false;
    if (a === b)
        return true;
    if (a[0] !== b[0])
        return false;
    return distance(a, b) <= Math.max(1, Math.floor(longest / 3));
}

// The parts of `a` and `b` that differ, as [aStart, aEnd, bStart, bEnd]
// (longest common subsequence on the words, as they are written).
function hunks(a, b) {
    const n = a.length, m = b.length;
    const t = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--)
            t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
    const out = [];
    let i = 0, j = 0, open = null;
    const close = () => {
        if (open) {
            out.push([open[0], i, open[1], j]);
            open = null;
        }
    };
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            close();
            i++;
            j++;
        } else {
            open ??= [i, j];
            if (t[i + 1][j] >= t[i][j + 1])
                i++;
            else
                j++;
        }
    }
    if (i < n || j < m)
        open ??= [i, j];
    i = n;
    j = m;
    close();
    return out;
}

// Pure. `dictated`: what was written; `now`: the text around the cursor
// some time later. The word to learn, as {from, to}, or null: nothing
// changed, more than one place changed (the sentence is being rewritten),
// or the change is not another spelling of the same sound.
export function correction(dictated, now) {
    const a = words(dictated), b = words(now);
    if (a.length < 3 || b.length < 3)
        return null;
    // What the field holds before and after the dictation is not a change.
    const changed = hunks(a, b).filter(([a0, a1]) => a1 > a0);
    if (changed.length !== 1)
        return null;
    const [a0, a1, b0, b1] = changed[0];
    const from = a.slice(a0, a1), to = b.slice(b0, b1);
    if (from.length > 3 || to.length < 1 || to.length > 3)
        return null;
    // The rest of the dictation is still there, around the change.
    if (a.length - from.length < 2)
        return null;
    const fromText = from.join(' '), toText = to.join(' ');
    if (!sameSound(fromText, toText))
        return null;
    if (plain(fromText) === plain(toText)) {
        // Only capitals or accents moved. An accent is a spelling; a
        // capital alone is one only inside a sentence ("parakeet" into
        // "Parakeet"), not on its first word.
        const accents = fromText.toLowerCase() !== toText.toLowerCase();
        if (!accents && (a0 === 0 || toText === toText.toLowerCase()))
            return null;
    }
    return {from: fromText, to: toText};
}

// `vocabulary` with `word` learned: an entry that only differs by its
// capitals or accents is replaced, not doubled.
export function learned(vocabulary, word) {
    const k = plain(word);
    return [...vocabulary.filter(w => plain(w) !== k), word];
}

// Watches the field after a dictation. `read()` returns the text around
// the cursor or null; `stillThere()` says whether the field still has the
// focus; `learn(from, to)` is called at most once.
export class VocabLearner {
    constructor({read, stillThere, learn}) {
        this._read = read;
        this._stillThere = stillThere;
        this._learn = learn;
        this._id = 0;
    }

    watch(dictated) {
        this.stop();
        if (words(dictated).length < 3)
            return;
        const started = GLib.get_monotonic_time() / 1000;
        let seen = '', since = 0;
        this._id = GLib.timeout_add(GLib.PRIORITY_LOW, POLL_MS, () => {
            const now = GLib.get_monotonic_time() / 1000;
            if (now - started > WATCH_MS || !this._stillThere()) {
                this._id = 0;
                return GLib.SOURCE_REMOVE;
            }
            let c = null;
            try {
                c = correction(dictated, this._read());
            } catch {
                c = null;
            }
            const key = c ? `${c.from}\n${c.to}` : '';
            if (key !== seen) {
                seen = key;
                since = now;
            } else if (c && now - since >= SETTLE_MS) {
                this._id = 0;
                this._learn(c.from, c.to);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._id) {
            GLib.Source.remove(this._id);
            this._id = 0;
        }
    }
}
