// SPDX-License-Identifier: GPL-2.0-or-later

// Where the words go: GNOME Shell's input method (Main.inputMethod), the same
// object Accent Hold's press-and-hold uses. Partial text is shown as preedit
// (the application underlines it), finished blocks are committed.
//
// Spacing: a block gets a leading space unless the character before the
// cursor is whitespace, an opening bracket/quote, or there is nothing there.
// That character is the last one we committed in this session when there is
// one (the surrounding text an application reports is updated asynchronously
// and may still predate our last commit; GNOME 45 does not report it at
// all), else what the application reports, else unknown: then a space is
// put between two blocks of the same dictation.
//
// Focus: the input focus is captured by begin(); partial() and commit()
// refuse (return false) once it has moved, so a dialog or a notification
// that steals the focus never receives the dictated text.

const NO_SPACE_AFTER = new Set([' ', '\n', '\t', '(', '[', '{', '«', '"', ' ', '’', "'", '/', '-']);

// Pure helper, unit-tested.
export function joinBlock(prevChar, text, {firstOfSession = false} = {}) {
    if (!text)
        return '';
    if (text.startsWith('\n'))
        return text;
    if (prevChar === null || prevChar === undefined) {
        // Unknown context: assume a word boundary is needed after the first block.
        return firstOfSession ? text : ` ${text}`;
    }
    if (prevChar === '' || NO_SPACE_AFTER.has(prevChar))
        return text;
    return ` ${text}`;
}

// The character before the cursor from a getSurroundingText() result:
// [text, cursor, anchor] on GNOME 46+, [text, cursor] on GNOME 45. '' at
// the start of the field, null when unknown (no text, a selection...).
export function surroundingChar(result) {
    if (!Array.isArray(result))
        return null;
    const [text, cursor] = result;
    const anchor = result.length > 2 ? result[2] : cursor;
    if (typeof text !== 'string' || typeof cursor !== 'number' || cursor !== anchor)
        return null;
    if (cursor <= 0)
        return '';
    const chars = Array.from(text);
    if (cursor > chars.length)
        return null;
    return chars[cursor - 1];
}

export class TextSink {
    constructor(inputMethod, clutter) {
        this._im = inputMethod;
        this._clutter = clutter;
        this._preedit = false;
        this._blocks = 0;
        this._lastChar = null;
        this._focus = null;
    }

    destroy() {
        this.clearPartial();
        this._im = null;
    }

    // True when some application text field is focused through the IM.
    get available() {
        return !!(this._im && this._im.currentFocus);
    }

    // True while the field focused at begin() still is.
    get focused() {
        return this.available && this._im.currentFocus === this._focus;
    }

    // The character before the cursor, '' at the start, or null when unknown.
    prevChar() {
        if (this._lastChar !== null)
            return this._lastChar;
        try {
            return surroundingChar(this._im.getSurroundingText());
        } catch {
            return null;
        }
    }

    begin() {
        this._blocks = 0;
        this._lastChar = null;
        this._focus = this._im?.currentFocus ?? null;
    }

    partial(text) {
        if (!this.focused)
            return false;
        const shown = joinBlock(this.prevChar(), text, {firstOfSession: this._blocks === 0});
        const len = Array.from(shown).length;
        this._im.set_preedit_text(shown, len, len, this._clutter.PreeditResetMode.CLEAR);
        this._preedit = true;
        return true;
    }

    clearPartial() {
        if (!this._preedit || !this._im)
            return;
        this._preedit = false;
        // Never touch a field we did not dictate into.
        if (this._im.currentFocus !== this._focus)
            return;
        try {
            // An empty string, not null: with null GTK keeps drawing the
            // previous preedit until the next key.
            this._im.set_preedit_text('', 0, 0, this._clutter.PreeditResetMode.CLEAR);
        } catch {
            // the input context is gone: nothing left to clear
        }
    }

    commit(text) {
        if (!this.focused)
            return false;
        const out = joinBlock(this.prevChar(), text, {firstOfSession: this._blocks === 0});
        this.clearPartial();
        this._im.commit(out);
        this._blocks++;
        const chars = Array.from(out);
        if (chars.length)
            this._lastChar = chars[chars.length - 1];
        return true;
    }

    end() {
        this.clearPartial();
    }
}
