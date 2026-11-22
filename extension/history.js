// SPDX-License-Identifier: GPL-2.0-or-later

// The last dictations, text only, kept on this computer
// (~/.local/share/voice-hold/dictations.json) for `history-days` days
// (0: not kept, -1: until cleared), at most MAX entries. Read and written by
// the extension and by the preferences, which list and clear them.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const MAX = 200;

export function historyFile() {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'voice-hold', 'dictations.json']));
}

// Pure: the entries to keep, newest first. `now` and `at` in seconds.
export function prune(entries, now, days, max = MAX) {
    if (days === 0)
        return [];
    const list = (Array.isArray(entries) ? entries : [])
        .filter(e => e && typeof e.text === 'string' && typeof e.at === 'number')
        .filter(e => days < 0 || now - e.at <= days * 86400)
        .sort((a, b) => b.at - a.at);
    return list.slice(0, max);
}

export function load(file = historyFile()) {
    try {
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            return [];
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

export function save(entries, file = historyFile()) {
    try {
        const dir = file.get_parent();
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
        file.replace_contents(new TextEncoder().encode(JSON.stringify(entries)), null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        return true;
    } catch (e) {
        console.warn(`voice-hold: history: ${e.message}`);
        return false;
    }
}

export function add(text, app, days, file = historyFile()) {
    if (days === 0 || !text.trim())
        return;
    const now = Math.floor(Date.now() / 1000);
    save(prune([{at: now, text, app: app ?? ''}, ...load(file)], now, days), file);
}

export function clear(file = historyFile()) {
    try {
        file.delete(null);
    } catch {
        // nothing to clear
    }
}

// The Shell's side: never blocks on the disk. Each add reads the file again
// (the preferences may have cleared it) and writes it back, one at a time.
export class HistoryWriter {
    constructor(file = historyFile()) {
        this._file = file;
        this._entries = null;
        this._queue = Promise.resolve();
    }

    add(text, app, days) {
        if (days === 0 || !text.trim())
            return;
        this._queue = this._queue.then(() => this._add(text, app, days)).catch(e =>
            console.warn(`voice-hold: history: ${e.message}`));
    }

    async _add(text, app, days) {
        this._entries = await this._load();
        const now = Math.floor(Date.now() / 1000);
        this._entries = prune([{at: now, text, app: app ?? ''}, ...this._entries], now, days);
        await this._save();
    }

    _load() {
        return new Promise(resolve => {
            this._file.load_contents_async(null, (f, res) => {
                try {
                    const [, bytes] = f.load_contents_finish(res);
                    const data = JSON.parse(new TextDecoder().decode(bytes));
                    resolve(Array.isArray(data) ? data : []);
                } catch {
                    resolve([]);
                }
            });
        });
    }

    _save() {
        const dir = this._file.get_parent();
        try {
            dir.make_directory_with_parents(null);
        } catch {
            // already there
        }
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(this._entries)));
        return new Promise((resolve, reject) => {
            this._file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
}
