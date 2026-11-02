// Where the words go: GNOME Shell's input method (Main.inputMethod), the same
// object Accent Hold's press-and-hold uses. Partial text is shown as preedit
// (the application underlines it), finished blocks are committed.
//
// Spacing: a block gets a leading space unless the character before the
// cursor is whitespace, an opening bracket/quote, or there is nothing there.
// When the application does not report surrounding text, a space is put
// between two blocks of the same dictation.

const NO_SPACE_AFTER = new Set([' ', '\n', '\t', '(', '[', '{', '«', '"', ' ', '’', "'", '/', '-']);

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

export class TextSink {
    constructor(inputMethod, clutter) {
        this._im = inputMethod;
        this._clutter = clutter;
        this._preedit = false;
        this._blocks = 0;
    }

    destroy() {
        this.clearPartial();
        this._im = null;
    }

    // True when some application text field is focused through the IM.
    get available() {
        return !!(this._im && this._im.currentFocus);
    }

    // The character right before the cursor, '' at the start, or null when
    // the application does not tell.
    prevChar() {
        try {
            const [text, cursor, anchor] = this._im.getSurroundingText();
            if (typeof text !== 'string' || cursor !== anchor)
                return null;
            const chars = Array.from(text);
            if (cursor <= 0)
                return '';
            if (cursor > chars.length)
                return null;
            return chars[cursor - 1];
        } catch {
            return null;
        }
    }

    begin() {
        this._blocks = 0;
    }

    partial(text) {
        if (!this.available)
            return;
        const shown = joinBlock(this.prevChar(), text, {firstOfSession: this._blocks === 0});
        const len = Array.from(shown).length;
        this._im.set_preedit_text(shown, len, len, this._clutter.PreeditResetMode.CLEAR);
        this._preedit = true;
    }

    clearPartial() {
        if (!this._preedit || !this._im)
            return;
        try {
            // An empty string, not null: with null GTK keeps drawing the
            // previous preedit until the next key.
            this._im.set_preedit_text('', 0, 0, this._clutter.PreeditResetMode.CLEAR);
        } catch {}
        this._preedit = false;
    }

    commit(text) {
        if (!this.available)
            return;
        const out = joinBlock(this.prevChar(), text, {firstOfSession: this._blocks === 0});
        this.clearPartial();
        this._im.commit(out);
        this._blocks++;
    }

    end() {
        this.clearPartial();
    }
}
