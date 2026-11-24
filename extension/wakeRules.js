// SPDX-License-Identifier: GPL-2.0-or-later

// The wake word's pure rules (wakeControl.js), unit-tested.

// The phrases to listen for, from the setting (one or
// several, separated by commas).
export function phrasesOf(text) {
    return (text ?? '').split(/[,;\n]/).map(p => p.trim()).filter(p => p);
}

// Why listening is paused, '' when it is not.
export function pauseReason({enabled, locked, onBattery, onBatteryOk, othersRecording}) {
    if (!enabled)
        return 'off';
    if (locked)
        return 'locked';
    if (othersRecording)
        return 'recording';
    if (onBattery && !onBatteryOk)
        return 'battery';
    return '';
}
