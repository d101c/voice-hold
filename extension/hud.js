import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {cursorPosition, islandPosition, trailing, ISLAND_OVERLAP} from './hudGeometry.js';

// The pill: microphone icon, level bars, and a line of text (status, then the
// words as they come). It never takes focus and only exists while there is
// something to show. Two placements:
//
// - "island": a capsule that is part of the top bar, like the Dynamic Island
//   of a phone. It shares the bar's background, hangs from its bottom edge
//   with rounded lower corners only, swells out of the bar when it opens,
//   grows from both ends as the text grows, and shrinks back into it. Always
//   in the same place, whatever has the focus.
// - "cursor": next to the text cursor (the pointer when the application does
//   not report one).
//
// Structure: an outer capsule (fixed size, animated, paints the background
// and the shadow) around a clipping box around the content (natural size,
// centred). The clip is a box inside the capsule, not the capsule itself,
// so the shadow is drawn whole: a clipped shadow shows as dark squares
// around the rounded corners. The content always has its natural size and
// the capsule opens over it: squeezed into a capsule that is still growing,
// the text would flash an ellipsis at every new word.

const BARS = 7;
const BAR_WEIGHTS = [0.45, 0.7, 1.0, 0.8, 1.0, 0.7, 0.45];
const BAR_MIN = 3;
const BAR_MAX = 20;
const HIDE_DELAY_MS = 450;
// Longer than what fits in the label: Pango cuts the start at the label's
// max-width, so a long sentence keeps the capsule at one steady width.
const MAX_CHARS = 120;

const ISLAND_SEED_W = 64;    // width of the bump the capsule swells from
const ISLAND_IN_MS = 380;
const ISLAND_OUT_MS = 240;
const RESIZE_MS = 220;
const CONTENT_FADE_MS = 160;
const CURSOR_FADE_MS = 150;
const PANEL_OPAQUE_ALPHA = 200;   // below this the bar is see-through (Blur my Shell…): use black
const MONITOR_MARGIN = 24;        // the capsule never comes closer than this to the monitor's edges

export class Hud {
    // getPosition: () => 'island' | 'cursor', read each time the pill opens.
    constructor(iconPath, gettext, getPosition = () => 'island') {
        this._ = gettext || (s => s);
        this._iconPath = iconPath;
        this._getPosition = getPosition;
        this._island = true;
        this._scale = 1;
        this._box = null;       // outer capsule
        this._clip = null;      // clipping box
        this._content = null;   // icon, bars, text
        this._icon = null;
        this._bars = [];
        this._heights = new Array(BARS).fill(BAR_MIN);
        this._label = null;
        this._hideId = 0;
        this._hideAt = 0;       // when the pending hide fires (monotonic ms)
        this._decayId = 0;
        this._level = 0;
        this._leaving = false;
    }

    destroy() {
        this._cancelHide();
        this._stopDecay();
        this._destroyBox();
    }

    // -- building --------------------------------------------------------

    _build() {
        if (this._box)
            return;
        this._island = this._getPosition() !== 'cursor';
        // Sizes set from here are in physical pixels; the stylesheet's are
        // scaled by St.
        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;

        this._box = new St.Widget({
            style_class: `voice-hud-capsule ${this._island ? 'voice-hud-island' : 'voice-hud-cursor'}`,
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            opacity: 0,
        });
        if (this._island)
            this._box.set_style(`background-color: ${this._panelColor()};`);

        this._clip = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: this._island,
            x_expand: true,
            y_expand: true,
        });
        this._box.add_child(this._clip);

        this._content = new St.BoxLayout({
            style_class: `voice-hud ${this._island ? 'voice-hud-content-island' : ''}`,
        });
        this._content.add_constraint(new Clutter.AlignConstraint({
            source: this._clip,
            align_axis: Clutter.AlignAxis.BOTH,
            factor: 0.5,
        }));
        this._clip.add_child(this._content);

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(this._iconPath),
            style_class: 'voice-hud-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_child(this._icon);

        const bars = new St.BoxLayout({style_class: 'voice-hud-bars', y_align: Clutter.ActorAlign.CENTER});
        this._bars = [];
        for (let i = 0; i < BARS; i++) {
            const bar = new St.Widget({style_class: 'voice-hud-bar', y_align: Clutter.ActorAlign.CENTER});
            bar.set_height(BAR_MIN * this._scale);
            bar.add_style_pseudo_class('quiet');
            bars.add_child(bar);
            this._bars.push(bar);
        }
        this._content.add_child(bars);

        this._label = new St.Label({style_class: 'voice-hud-text', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.START);
        this._label.clutter_text.set_single_line_mode(true);
        this._content.add_child(this._label);

        Main.layoutManager.uiGroup.add_child(this._box);
        // Above everything, but never grabbing anything.
        Main.layoutManager.uiGroup.set_child_above_sibling(this._box, null);
    }

    _destroyBox() {
        if (this._box) {
            this._box.destroy();
            this._box = null;
        }
        this._clip = null;
        this._content = null;
        this._icon = null;
        this._label = null;
        this._bars = [];
        this._heights.fill(BAR_MIN);
        this._level = 0;
        this._leaving = false;
    }

    // The bar's own background, so the capsule reads as a part of it. A
    // see-through bar (transparency extensions) gets plain black, the colour
    // of the bar they are imitating anyway.
    _panelColor() {
        try {
            const c = Main.panel.get_theme_node().get_background_color();
            if (c.alpha >= PANEL_OPAQUE_ALPHA)
                return `rgb(${c.red},${c.green},${c.blue})`;
        } catch {
            // fall through
        }
        return 'rgb(0,0,0)';
    }

    // -- geometry --------------------------------------------------------

    // Natural size of the capsule: that of its content.
    _natural() {
        const monitor = Main.layoutManager.primaryMonitor;
        const maxW = monitor ? monitor.width - 2 * MONITOR_MARGIN * this._scale : 10000;
        let [, w] = this._content.get_preferred_width(-1);
        w = Math.min(Math.ceil(w), maxW);
        const [, h] = this._content.get_preferred_height(w);
        return [w, Math.ceil(h) + (this._island ? ISLAND_OVERLAP : 0)];
    }

    // Where the capsule hangs from: centred under the primary monitor's bar,
    // or the top of that monitor when the bar is not there (hudGeometry.js).
    _islandAnchor(width) {
        const lm = Main.layoutManager;
        const box = lm.panelBox;
        const panel = box ? {x: box.x, y: box.y, width: box.width, height: box.height, visible: box.visible} : null;
        return islandPosition(lm.primaryMonitor, panel, width);
    }

    _place(animate = false) {
        if (this._island)
            this._placeIsland(animate);
        else
            this._placeAtCursor();
    }

    // Island: ease the capsule to its new natural size, keeping it centred,
    // so a longer text makes it grow from both ends.
    _placeIsland(animate) {
        const [w, h] = this._natural();
        const [x, y] = this._islandAnchor(w);
        for (const prop of ['x', 'width', 'height'])
            this._box.remove_transition(prop);
        this._box.set_y(y);
        if (animate && this._box.opacity > 0 && !this._leaving) {
            this._box.ease({x, width: w, height: h, duration: RESIZE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            this._box.set_position(x, y);
            this._box.set_size(w, h);
        }
    }

    // Cursor: below the text cursor when the application reports it, else
    // the pointer, kept inside its monitor.
    _placeAtCursor() {
        const lm = Main.layoutManager;
        const [px, py] = global.get_pointer();
        const [width, height] = this._natural();
        const [x, y] = cursorPosition({
            cursor: Main.inputMethod?._cursorRect ?? null,
            pointer: [px, py],
            // findMonitorForPoint() only exists from GNOME 46: the monitor
            // is looked up by hand.
            monitors: lm.monitors,
            primary: lm.primaryMonitor,
            width,
            height,
        });
        this._box.set_position(x, y);
    }

    // -- entrance / exit -------------------------------------------------

    // Island: a small bump swells out of the bar into the full capsule, the
    // content fading in once there is room for it. Cursor: a short fade.
    _enter() {
        this._leaving = false;
        this._box.remove_all_transitions();
        this._content.remove_all_transitions();
        if (!this._island) {
            this._content.opacity = 255;
            this._box.ease({opacity: 255, duration: CURSOR_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return;
        }
        const [w, h] = this._natural();
        const [x, y] = this._islandAnchor(w);
        const seedW = Math.min(ISLAND_SEED_W * this._scale, w);
        this._box.set_position(Math.round(x + (w - seedW) / 2), y);
        this._box.set_size(seedW, 0);
        this._box.opacity = 255;
        this._content.opacity = 0;
        this._box.ease({
            x, width: w, height: h,
            duration: ISLAND_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        this._content.ease({
            opacity: 255,
            duration: CONTENT_FADE_MS,
            delay: ISLAND_IN_MS - CONTENT_FADE_MS - 60,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // ... and back into the bar.
    _leave(onComplete) {
        this._leaving = true;
        this._box.remove_all_transitions();
        this._content.remove_all_transitions();
        if (!this._island) {
            this._box.ease({opacity: 0, duration: CURSOR_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete});
            return;
        }
        const w = this._box.width;
        const seedW = Math.min(ISLAND_SEED_W * this._scale, w);
        this._content.ease({opacity: 0, duration: CONTENT_FADE_MS * 0.6, mode: Clutter.AnimationMode.EASE_IN_QUAD});
        this._box.ease({
            x: Math.round(this._box.x + (w - seedW) / 2),
            width: seedW,
            height: 0,
            duration: ISLAND_OUT_MS,
            delay: 40,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete,
        });
    }

    // -- public ----------------------------------------------------------

    // On screen and not on its way out: status(), live() and pending() act.
    get visible() {
        return !!this._box && !this._leaving;
    }

    show(status, pseudo = '') {
        this._cancelHide();
        this._build();
        const fresh = this._box.opacity === 0;
        const leaving = this._leaving;
        this._setIconState(pseudo);
        this._setText(status, 'hint');
        if (fresh || leaving) {
            // New, or caught on its way out: (re)open.
            if (!this._island)
                this._place();
            this._enter();
        } else {
            this._place(true);
        }
    }

    status(text, pseudo = '') {
        if (!this._box || this._leaving)
            return;
        this._setIconState(pseudo);
        this._setText(text, 'hint');
        this._place(true);
    }

    live(text) {
        if (!this._box || this._leaving)
            return;
        // Words again after a block that failed: the dictation goes on.
        if (this._showsError())
            this._setIconState('listening');
        this._setText(trailing(text.replace(/\n/g, ' ⏎ '), MAX_CHARS), 'live');
        this._place(true);
    }

    // The last words are still being decoded: the icon breathes and the
    // words already shown stay; a hint that no longer holds ("release to
    // stop") gives way to an ellipsis.
    pending() {
        if (!this._box || this._leaving || this._showsError())
            return;                       // an error stays up until read
        this._setIconState('busy');
        if (this._label.has_style_pseudo_class('hint')) {
            this._setText('…', 'hint');
            this._place(true);
        }
    }

    error(text) {
        this.show(text, 'error');
        this.hide(4000);
    }

    level(v) {
        if (!this._box)
            return;
        this._level = Math.max(0, Math.min(1, v));
        this._paintBars();
        this._startDecay();
    }

    // Close after `delay`, with the exit animation. An error already on its
    // way out keeps the time it was given: the end of the session, which
    // follows it at once, must not take it away before it can be read.
    hide(delay = HIDE_DELAY_MS) {
        const now = GLib.get_monotonic_time() / 1000;
        if (delay > 0 && this._hideId && this._showsError() && this._hideAt > now + delay)
            return;
        this._cancelHide();
        if (!this._box || this._leaving)
            return;
        if (delay <= 0) {
            this._close();
            return;
        }
        this._hideAt = now + delay;
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hideId = 0;
            this._close();
            return GLib.SOURCE_REMOVE;
        });
    }

    hideNow() {
        this._cancelHide();
        this._stopDecay();
        this._destroyBox();
    }

    // -- internals -------------------------------------------------------

    _showsError() {
        return !!this._icon?.has_style_pseudo_class('error');
    }

    _close() {
        this._stopDecay();
        if (this._box)
            this._leave(() => this._destroyBox());
    }

    _setIconState(pseudo) {
        if (!this._icon)
            return;
        for (const p of ['listening', 'loading', 'busy', 'error'])
            this._icon.remove_style_pseudo_class(p);
        if (pseudo)
            this._icon.add_style_pseudo_class(pseudo);
        // Grey and breathing until the engine says it listens, then solid
        // blue, then blue and breathing while the last words are decoded.
        // One repeating transition, not a chain of them: with
        // animations off (or the actor off stage) an ease ends at once, and
        // a chain would call itself for ever.
        this._icon.remove_all_transitions();
        this._icon.opacity = 255;
        if (pseudo === 'loading' || pseudo === 'busy') {
            this._icon.ease({
                opacity: 90,
                duration: 600,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                repeatCount: -1,
                autoReverse: true,
            });
        }
    }

    _setText(text, pseudo) {
        if (!this._label)
            return;
        for (const p of ['live', 'hint'])
            this._label.remove_style_pseudo_class(p);
        this._label.add_style_pseudo_class(pseudo);
        this._label.set_text(text);
        // No words: the pill is the icon and the level, without a gap.
        this._label.visible = !!text;
    }

    _paintBars() {
        for (let i = 0; i < this._bars.length; i++) {
            const target = BAR_MIN + (BAR_MAX - BAR_MIN) * this._level * BAR_WEIGHTS[i] *
                (0.85 + 0.3 * Math.random());
            // Fast attack, slow release.
            const cur = this._heights[i];
            this._heights[i] = target > cur ? target : cur + (target - cur) * 0.35;
            this._bars[i].set_height(Math.round(this._heights[i] * this._scale));
            if (this._heights[i] > BAR_MIN + 1.5)
                this._bars[i].remove_style_pseudo_class('quiet');
            else
                this._bars[i].add_style_pseudo_class('quiet');
        }
    }

    // The bars fall back on their own between two Level signals. The timer
    // stops once they are flat; the next level() starts it again.
    _startDecay() {
        if (this._decayId)
            return;
        this._decayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            // The stage may have taken the actors with it (shell exit).
            if (!this._box || !this._box.get_stage()) {
                this._decayId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._level *= 0.75;
            this._paintBars();
            if (this._level < 0.01 && this._heights.every(h => h < BAR_MIN + 0.5)) {
                this._decayId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopDecay() {
        if (this._decayId) {
            GLib.source_remove(this._decayId);
            this._decayId = 0;
        }
    }

    _cancelHide() {
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
    }
}
