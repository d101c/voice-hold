// SPDX-License-Identifier: GPL-2.0-or-later

// How much was dictated: numbers only, never the words. One line a day in
// ~/.local/share/voice-hold/usage.json ({"2026-11-24": {w, s, n}}: words,
// seconds spent dictating, dictations), kept for KEEP_DAYS days. Written
// by the extension after each dictation, read by the preferences.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const KEEP_DAYS = 400;
// What a dictation is compared with: a comfortable typing speed.
export const TYPING_WPM = 40;

export function usageFile() {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'voice-hold', 'usage.json']));
}

export function countWords(text) {
    return (String(text ?? '').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

// 'YYYY-MM-DD' in local time.
export function dayKey(date) {
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// `days` before (negative) or after the day of `key`.
export function shiftDay(key, days) {
    const [y, m, d] = key.split('-').map(Number);
    return dayKey(new Date(y, m - 1, d + days));
}

function clean(data) {
    const out = {};
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return out;
    for (const [k, v] of Object.entries(data)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== 'object')
            continue;
        const w = Number(v.w), s = Number(v.s), n = Number(v.n);
        if (Number.isFinite(w) && Number.isFinite(s) && Number.isFinite(n) && w >= 0 && s >= 0 && n >= 0)
            out[k] = {w, s, n};
    }
    return out;
}

// Pure: `data` with one more dictation on the day `today`, old days dropped.
export function record(data, today, words, seconds) {
    const out = clean(data);
    if (words <= 0)
        return out;
    const day = out[today] ?? {w: 0, s: 0, n: 0};
    out[today] = {w: day.w + words, s: Math.round((day.s + Math.max(0, seconds)) * 10) / 10, n: day.n + 1};
    const oldest = shiftDay(today, -KEEP_DAYS);
    for (const k of Object.keys(out)) {
        if (k < oldest)
            delete out[k];
    }
    return out;
}

// Pure: what the Usage page shows.
export function summarize(data, today, typingWpm = TYPING_WPM) {
    const d = clean(data);
    const keys = Object.keys(d).sort();
    let words = 0, seconds = 0, dictations = 0;
    for (const k of keys) {
        words += d[k].w;
        seconds += d[k].s;
        dictations += d[k].n;
    }
    // Days in a row with a dictation, ending today, or yesterday when
    // today has none yet (the streak is not lost before the day is over).
    let streak = 0;
    let k = d[today] ? today : shiftDay(today, -1);
    while (d[k]) {
        streak++;
        k = shiftDay(k, -1);
    }
    let best = 0, run = 0, prev = null;
    for (const key of keys) {
        run = prev && shiftDay(prev, 1) === key ? run + 1 : 1;
        best = Math.max(best, run);
        prev = key;
    }
    const last30 = [];
    for (let i = 29; i >= 0; i--) {
        const key = shiftDay(today, -i);
        last30.push({day: key, words: d[key]?.w ?? 0});
    }
    let week = 0;
    for (let i = 0; i < 7; i++)
        week += d[shiftDay(today, -i)]?.w ?? 0;
    return {
        words, seconds, dictations,
        today: d[today]?.w ?? 0,
        week,
        // Speaking speed, once there is enough to mean something.
        wpm: seconds >= 30 ? Math.round(words / (seconds / 60)) : 0,
        savedSeconds: Math.max(0, Math.round(words / typingWpm * 60 - seconds)),
        streak, best,
        since: keys[0] ?? '',
        last30,
    };
}

// "1 h 20 min", "12 min", "45 s".
export function duration(seconds, _ = s => s) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60)
        return _('%d s').replace('%d', s);
    const min = Math.round(s / 60);
    if (min < 60)
        return _('%d min').replace('%d', min);
    const h = Math.floor(min / 60), m = min % 60;
    return m ? _('%d h %d min').replace('%d', h).replace('%d', m) : _('%d h').replace('%d', h);
}

export function load(file = usageFile()) {
    try {
        const [ok, bytes] = file.load_contents(null);
        return ok ? clean(JSON.parse(new TextDecoder().decode(bytes))) : {};
    } catch {
        return {};
    }
}

export function clear(file = usageFile()) {
    try {
        file.delete(null);
    } catch {
        // nothing to clear
    }
}

// The Shell's side: never blocks on the disk, one write at a time.
export class UsageWriter {
    constructor(file = usageFile()) {
        this._file = file;
        this._queue = Promise.resolve();
    }

    // `text`: what was written; only its number of words is kept.
    add(text, seconds, now = new Date()) {
        const words = countWords(text);
        if (!words)
            return;
        this._queue = this._queue.then(() => this._add(words, seconds, dayKey(now))).catch(e =>
            console.warn(`voice-hold: usage: ${e.message}`));
    }

    async _add(words, seconds, today) {
        const data = record(await this._load(), today, words, seconds);
        const dir = this._file.get_parent();
        try {
            dir.make_directory_with_parents(null);
        } catch {
            // already there
        }
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(data)));
        await new Promise((resolve, reject) => {
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

    _load() {
        return new Promise(resolve => {
            this._file.load_contents_async(null, (f, res) => {
                try {
                    const [, bytes] = f.load_contents_finish(res);
                    resolve(JSON.parse(new TextDecoder().decode(bytes)));
                } catch {
                    resolve({});
                }
            });
        });
    }
}
