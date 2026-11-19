// SPDX-License-Identifier: GPL-2.0-or-later

// A readable name for an accelerator such as '<Control>space' ("Ctrl+Space"),
// for the hints of the pill. Free of Shell imports (tests/accelLabel.test.js).

const MODIFIERS = [
    [/<(control|ctrl|primary)>/gi, 'Ctrl'],
    [/<(alt|mod1)>/gi, 'Alt'],
    [/<(super|mod4)>/gi, 'Super'],
    [/<shift>/gi, 'Shift'],
];

export function accelLabel(accel, gettext = s => s) {
    if (!accel)
        return '';
    const parts = [];
    let rest = accel;
    for (const [re, name] of MODIFIERS) {
        if (re.test(rest))
            parts.push(name === 'Shift' ? gettext('Shift') : name);
        rest = rest.replace(re, '');
    }
    rest = rest.replace(/<[^>]*>/g, '');
    if (rest.toLowerCase() === 'space')
        parts.push(gettext('Space'));
    else if (rest.length === 1)
        parts.push(rest.toUpperCase());
    else if (rest)
        parts.push(rest);
    return parts.join('+');
}
