// How the pill comes and goes. Shared by the dictation pill (hud.js) and the
// command pill (commands/commandHud.js): both hand over the same parts.
//
//   swell   a bump swells out of the bar (the quiet one)
//   drop    a drop falls from the bar, then springs open sideways
//   spring  the whole capsule zooms out of the bar and wobbles
//   glow    swell, with a blue halo that flashes as it opens and closes
//
// `parts` is {box, content, bars, scale}; `geo` is {x, y, w, h}: where the
// open capsule sits. Everything is done with eases, so with animations off
// (or the actor off stage) each step ends at once.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

export const EFFECTS = ['swell', 'drop', 'spring', 'glow'];
export const DEFAULT_EFFECT = 'drop';

const SEED_W = 64;           // width of the bump or drop the capsule opens from
const FADE_MS = 160;
const GLOW_CLASS = 'voice-hud-glow';
const M = Clutter.AnimationMode;

export function effectOf(name) {
    return EFFECTS.includes(name) ? name : DEFAULT_EFFECT;
}

// Timers of an effect in flight, kept on the parts so that the next effect
// (or the pill's destruction) can drop them.
function later(parts, ms, fn) {
    parts.fx ??= new Set();
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        parts.fx.delete(id);
        fn();
        return GLib.SOURCE_REMOVE;
    });
    parts.fx.add(id);
}

export function cancel(parts) {
    for (const id of parts?.fx ?? [])
        GLib.source_remove(id);
    parts?.fx?.clear();
}

function reset(parts) {
    cancel(parts);
    const {box, content, bars} = parts;
    box.remove_all_transitions();
    content.remove_all_transitions();
    box.remove_style_class_name(GLOW_CLASS);
    box.set_pivot_point(0.5, 0);
    box.set_scale(1, 1);
    content.translation_y = 0;
    for (const bar of bars ?? []) {
        bar.remove_transition('scale-y');
        bar.set_pivot_point(0.5, 0.5);
        bar.scale_y = 1;
    }
}

// The content comes up from below while it fades in; the level bars pop one
// after the other.
function reveal(parts, delay, rise = 0) {
    const {content, bars, scale} = parts;
    content.opacity = 0;
    content.translation_y = rise * scale;
    content.ease({opacity: 255, translation_y: 0, delay, duration: FADE_MS + (rise ? 80 : 0), mode: M.EASE_OUT_CUBIC});
    if (!rise)
        return;
    (bars ?? []).forEach((bar, i) => {
        bar.scale_y = 0;
        bar.ease({scale_y: 1, delay: delay + 40 + i * 35, duration: 260, mode: M.EASE_OUT_BACK});
    });
}

function seed(parts, geo) {
    const {box, scale} = parts;
    const seedW = Math.min(SEED_W * scale, geo.w);
    box.set_position(Math.round(geo.x + (geo.w - seedW) / 2), geo.y);
    box.set_size(seedW, 0);
    box.opacity = 255;
    return seedW;
}

export function enter(parts, geo, name, island = true) {
    const effect = effectOf(name);
    const {box, content} = parts;
    reset(parts);
    if (!island) {
        // Next to the cursor there is no bar to come out of: a fade, with a
        // small pop for the livelier effects.
        content.opacity = 255;
        box.set_pivot_point(0.5, 0.5);
        if (effect !== 'swell')
            box.set_scale(0.8, 0.8);
        box.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: effect === 'swell' ? 150 : 280,
            mode: effect === 'swell' ? M.EASE_OUT_QUAD : M.EASE_OUT_BACK});
        return;
    }
    const {x, w, h} = geo;
    switch (effect) {
    case 'drop':
        seed(parts, geo);
        box.ease({height: h, duration: 170, mode: M.EASE_OUT_QUAD});
        box.ease({x, width: w, delay: 150, duration: 620, mode: M.EASE_OUT_ELASTIC});
        reveal(parts, 300, 10);
        break;
    case 'spring':
        box.set_position(x, geo.y);
        box.set_size(w, h);
        box.opacity = 255;
        box.set_scale(0.25, 0);
        box.ease({scale_x: 1, scale_y: 1, duration: 640, mode: M.EASE_OUT_ELASTIC});
        reveal(parts, 140, 6);
        break;
    case 'glow':
        seed(parts, geo);
        box.ease({x, width: w, height: h, duration: 420, mode: M.EASE_OUT_BACK});
        reveal(parts, 220, 8);
        box.add_style_class_name(GLOW_CLASS);
        later(parts, 520, () => box.remove_style_class_name(GLOW_CLASS));
        break;
    default:
        seed(parts, geo);
        box.ease({x, width: w, height: h, duration: 380, mode: M.EASE_OUT_BACK});
        reveal(parts, 380 - FADE_MS - 60);
    }
}

export function leave(parts, name, island, onComplete) {
    const effect = effectOf(name);
    const {box, content, scale} = parts;
    cancel(parts);
    box.remove_all_transitions();
    content.remove_all_transitions();
    if (!island) {
        box.set_pivot_point(0.5, 0.5);
        const to = effect === 'swell' ? 1 : 0.85;
        box.ease({opacity: 0, scale_x: to, scale_y: to, duration: 150, mode: M.EASE_OUT_QUAD, onComplete});
        return;
    }
    const w = box.width;
    const seedW = Math.min(SEED_W * scale, w);
    const seedX = Math.round(box.x + (w - seedW) / 2);
    content.ease({opacity: 0, duration: FADE_MS * 0.6, mode: M.EASE_IN_QUAD});
    const shrink = (delay = 40) => box.ease({x: seedX, width: seedW, height: 0, delay, duration: 240, mode: M.EASE_IN_CUBIC, onComplete});
    switch (effect) {
    case 'drop':
        // Back to a drop, which the bar then swallows.
        box.ease({x: seedX, width: seedW, delay: 40, duration: 230, mode: M.EASE_IN_BACK});
        box.ease({height: 0, delay: 250, duration: 140, mode: M.EASE_IN_QUAD, onComplete});
        break;
    case 'spring':
        box.set_pivot_point(0.5, 0);
        box.ease({scale_x: 0.25, scale_y: 0, delay: 40, duration: 260, mode: M.EASE_IN_BACK, onComplete});
        break;
    case 'glow':
        box.add_style_class_name(GLOW_CLASS);
        later(parts, 160, () => box.remove_style_class_name(GLOW_CLASS));
        shrink(140);
        break;
    default:
        shrink();
    }
}
