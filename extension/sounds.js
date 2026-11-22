// SPDX-License-Identifier: GPL-2.0-or-later

// Two short, quiet cues: listening starts, the text is written. Played with
// the Shell's own sound player, which follows the system's event sounds
// setting.
import Gio from 'gi://Gio';

export class Cues {
    constructor(dir, settings) {
        this._dir = dir;
        this._settings = settings;
    }

    play(name) {
        if (!this._settings.get_boolean('sounds'))
            return;
        try {
            const file = Gio.File.new_for_path(`${this._dir}/sounds/${name}.wav`);
            global.display.get_sound_player().play_from_file(file, name, null);
        } catch (e) {
            console.warn(`voice-hold: sound ${name}: ${e.message}`);
        }
    }
}
