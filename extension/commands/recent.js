// SPDX-License-Identifier: GPL-2.0-or-later

// The line of a past request in the indicator's menu: "what was heard → what
// came of it". Free of Shell imports so it can be tested with plain gjs.

export const RECENT = 5;
export const RECENT_CHARS = 48;

// `text` on one line, at most `max` characters (code points), with an
// ellipsis at the end when something was cut.
export function shorten(text, max) {
    const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

// e: a history entry {ts, transcript, action, command, say, result, exit}.
// exitText(code) words a non-zero exit code (translated by the caller).
export function recentLabel(e, exitText = code => ` (exit ${code})`) {
    const heard = shorten(e.transcript, RECENT_CHARS);
    let outcome;
    if (e.command)
        outcome = `$ ${shorten(e.command, RECENT_CHARS)}${e.exit ? exitText(e.exit) : ''}`;
    else
        outcome = shorten(e.result || e.say || e.action, RECENT_CHARS);
    return `${e.ts?.slice(11, 16) ?? ''}  ${heard}  →  ${outcome}`;
}
