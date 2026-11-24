// SPDX-License-Identifier: GPL-2.0-or-later

// Run: gjs -m extension/tests/media.test.js
import {Ducker, LOWER} from '../media.js';

let failures = 0;
function test(name, fn) {
    try {
        fn();
        print(`PASS ${name}`);
    } catch (e) {
        failures++;
        print(`FAIL ${name}: ${e.message}`);
    }
}
function eq(got, want, msg) {
    if (JSON.stringify(got) !== JSON.stringify(want))
        throw new Error(`${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// A stream of GNOME's mixer, as far as the ducker uses it.
function stream(id, volume, {muted = false, event = false} = {}) {
    return {
        is_event_stream: event,
        pushed: 0,
        get_id: () => id,
        get_is_muted: () => muted,
        get_volume() {
            return volume;
        },
        set_volume(v) {
            volume = v;
        },
        push_volume() {
            this.pushed++;
        },
    };
}
function mixer(streams) {
    return {
        get_sink_inputs: () => streams,
        lookup_stream_id: id => streams.find(s => s.get_id() === id) ?? null,
    };
}

test('what plays goes down to a quarter and comes back', () => {
    const music = stream(1, 60000), call = stream(2, 40000);
    const d = new Ducker(() => mixer([music, call]));
    d.lower();
    eq([music.get_volume(), call.get_volume()], [60000 * LOWER, 40000 * LOWER], 'lowered');
    d.restore();
    eq([music.get_volume(), call.get_volume()], [60000, 40000], 'restored');
    eq([music.pushed, call.pushed], [2, 2], 'each change is pushed to the server');
});

test('our own sounds, muted and silent streams are left alone', () => {
    const cue = stream(1, 50000, {event: true}), muted = stream(2, 50000, {muted: true}), silent = stream(3, 0);
    const d = new Ducker(() => mixer([cue, muted, silent]));
    d.lower();
    eq([cue.get_volume(), muted.get_volume(), silent.get_volume()], [50000, 50000, 0], 'untouched');
    eq(cue.pushed + muted.pushed + silent.pushed, 0, 'nothing pushed');
});

test('a volume moved by hand meanwhile is kept', () => {
    const music = stream(1, 60000);
    const d = new Ducker(() => mixer([music]));
    d.lower();
    music.set_volume(30000);
    d.restore();
    eq(music.get_volume(), 30000, 'the user decides');
});

test('a stream that ended meanwhile is forgotten, a second lower does not stack', () => {
    const music = stream(1, 60000), gone = stream(2, 60000);
    const streams = [music, gone];
    const d = new Ducker(() => mixer(streams));
    d.lower();
    d.lower();
    eq(music.get_volume(), 60000 * LOWER, 'lowered once');
    streams.pop();
    d.restore();
    eq(music.get_volume(), 60000, 'restored');
    d.restore();
    eq(music.get_volume(), 60000, 'restoring twice changes nothing');
});

test('no mixer: nothing happens, nothing throws', () => {
    const d = new Ducker(() => {
        throw new Error('no mixer');
    });
    d.lower();
    d.restore();
});

if (failures) {
    print(`${failures} failed`);
    imports.system.exit(1);
}
print('all passed');
