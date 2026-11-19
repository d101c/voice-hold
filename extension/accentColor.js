// SPDX-License-Identifier: GPL-2.0-or-later

// The system's accent colour (Settings > Appearance, GNOME 47 and later),
// for what the pills paint in colour. Before GNOME 47 there is no such
// setting: blue, the colour GNOME used then. Free of Shell imports
// (tests/accentColor.test.js).
import Gio from 'gi://Gio';

// libadwaita's accent colours.
export const ACCENTS = {
    blue: '#3584e4',
    teal: '#2190a4',
    green: '#3a944a',
    yellow: '#c88800',
    orange: '#ed5b00',
    red: '#e62d42',
    pink: '#d56199',
    purple: '#9141ac',
    slate: '#6f8396',
};

export function accentHex(name) {
    return ACCENTS[name] ?? ACCENTS.blue;
}

// '#3584e4', 0.9 -> 'rgba(53,132,228,0.9)'
export function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function accentColor() {
    try {
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        if (settings.settings_schema.has_key('accent-color'))
            return accentHex(settings.get_string('accent-color'));
    } catch (_e) {
        // fall through
    }
    return ACCENTS.blue;
}
