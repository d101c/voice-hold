// SPDX-License-Identifier: GPL-2.0-or-later

// What the top-bar icon and its menu say about the speech model. Free of
// Shell imports (tests/modelState.test.js).
//
//   disabled  the shortcut is switched off
//   asleep    not in memory: the next dictation waits a few seconds
//   loading   on its way
//   ready     in memory: the next dictation starts at once

// enabled: the `enabled` setting; running: the engine is on the bus;
// model: its Model ('asleep' | 'loading' | 'ready'), '' when unknown.
export function modelState({enabled, running, model}) {
    if (!enabled)
        return 'disabled';
    if (!running)
        return 'asleep';
    return ['loading', 'ready'].includes(model) ? model : 'asleep';
}

// The status line of the menu. unloadInS: seconds before the model is
// released (-1 or null when unknown).
export function statusLine(state, unloadInS, gettext = s => s) {
    const _ = gettext;
    switch (state) {
    case 'disabled':
        return _('Dictation switched off');
    case 'loading':
        return _('Loading the speech model…');
    case 'ready': {
        if (unloadInS === null || unloadInS === undefined || unloadInS < 0)
            return _('Speech model ready');
        const min = Math.max(1, Math.round(unloadInS / 60));
        return _('Speech model ready — released in %d min').format(min);
    }
    default:
        return _('Speech model asleep — a few seconds at the first word');
    }
}
