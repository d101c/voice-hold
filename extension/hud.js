// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {accentColor} from './accentColor.js';
import * as effects from './hudEffects.js';
import {cursorPosition, islandPosition, levelCurve, trailing, ISLAND_OVERLAP} from './hudGeometry.js';
import {anchorMonitor, bottomAnchor, PILL_NAME} from './hudPlacement.js';
import {systemFontCss} from './systemFont.js';

// The pill: level bars, and a line of text (status, then the
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

const BARS = 9;
const BAR_WEIGHTS = [0.4, 0.6, 0.85, 1.0, 0.8, 1.0, 0.85, 0.6, 0.4];
const BAR_MIN = 4;
const BAR_MAX = 34;
const HIDE_DELAY_MS = 450;
// The label wraps: the capsule widens with the words up to the label's
// max-width (stylesheet.css), then grows downwards. Past this many
// characters (about three lines) the start of the block gives way.
const MAX_CHARS = 240;

const RESIZE_MS = 220;
// The model's progress bar fills to this share of its width over the
// expected load time, then waits for the engine: never full before it is.
const PROGRESS_CAP = 0.9;
const PROGRESS_W = 52;
// The countdown ring the bars curl into (countdown()).
const RING_RADIUS = 12;
const DOT = 6;
const MORPH_MS = 380;
const PANEL_OPAQUE_ALPHA = 200;   // below this the bar is see-through (Blur my Shell…): use black
const MONITOR_MARGIN = 24;        // the capsule never comes closer than this to the monitor's edges

export class Hud {
    // getPosition: () => 'bottom' | 'island' | 'cursor' and getEffect: () => one of
    // hudEffects.EFFECTS, both read each time the pill opens.
    constructor(gettext, getPosition = () => 'bottom', getEffect = () => effects.DEFAULT_EFFECT) {
        this._getEffect = getEffect;
        this._ = gettext;
        this._getPosition = getPosition;
        this._where = 'bottom';  // 'bottom' | 'island' | 'cursor', fixed while the pill is up
        this._scale = 1;
        this._box = null;       // outer capsule
        this._clip = null;      // clipping box
        this._content = null;   // icon, bars, text
        this._meter = null;     // the bars: they also carry the state
        this._state = '';
        this._bars = [];
        this._heights = new Array(BARS).fill(BAR_MIN);
        this._label = null;
        this._ringTimeline = null;  // the countdown, while the bars are a ring
        this._morphed = false;
        this._progress = null;
        this._progressFill = null;
        this._accent = '';
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
        const where = this._getPosition();
        this._where = ['island', 'cursor'].includes(where) ? where : 'bottom';
        // Sizes set from here are in physical pixels; the stylesheet's are
        // scaled by St.
        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        // Read at each opening: a change in Settings shows at the next pill.
        this._accent = accentColor();

        this._box = new St.Widget({
            style_class: `voice-hud-capsule voice-hud-${this._where}`,
            name: PILL_NAME,
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            opacity: 0,
        });
        // The system's interface font, and for the island the bar's colour.
        this._box.set_style(systemFontCss() + (this._where === 'island' ? ` background-color: ${this._panelColor()};` : ''));

        this._clip = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: this._where !== 'cursor',
            x_expand: true,
            y_expand: true,
        });
        this._box.add_child(this._clip);

        this._content = new St.BoxLayout({
            style_class: `voice-hud voice-hud-content-${this._where}`,
        });
        this._content.add_constraint(new Clutter.AlignConstraint({
            source: this._clip,
            align_axis: Clutter.AlignAxis.BOTH,
            factor: 0.5,
        }));
        this._clip.add_child(this._content);

        // No icon: the level takes its room, and its state too (breathing
        // while the model loads or the last words are decoded).
        const bars = new St.BoxLayout({style_class: 'voice-hud-bars', y_align: Clutter.ActorAlign.CENTER});
        this._meter = bars;
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
        const ct = this._label.clutter_text;
        ct.set_single_line_mode(false);
        ct.set_line_wrap(true);
        ct.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        ct.set_ellipsize(Pango.EllipsizeMode.NONE);
        this._content.add_child(this._label);

        this._progress = new St.Widget({
            style_class: 'voice-hud-progress',
            layout_manager: new Clutter.FixedLayout(),
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._progressFill = new St.Widget({style_class: 'voice-hud-progress-fill'});
        this._progressFill.set_style(`background-color: ${this._accent};`);
        this._progress.add_child(this._progressFill);
        this._content.add_child(this._progress);

        Main.layoutManager.uiGroup.add_child(this._box);
        // Above everything, but never grabbing anything.
        Main.layoutManager.uiGroup.set_child_above_sibling(this._box, null);
    }

    _destroyBox() {
        effects.cancel(this._fx);
        if (this._box) {
            this._box.destroy();
            this._box = null;
        }
        this._clip = null;
        this._content = null;
        this._meter = null;
        this._state = '';
        this._label = null;
        this._ringTimeline?.stop();
        this._ringTimeline = null;
        this._morphed = false;
        this._progress = null;
        this._progressFill = null;
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

    // Natural size of the capsule: that of its content. The content is then
    // given that size: left to the clip's FixedLayout, it would get the
    // height of one line, and a wrapped second line would be cut off.
    _natural() {
        const monitor = this._where === 'bottom' ? anchorMonitor() : Main.layoutManager.primaryMonitor;
        const maxW = monitor ? monitor.width - 2 * MONITOR_MARGIN * this._scale : 10000;
        this._content.set_size(-1, -1);
        let [, w] = this._content.get_preferred_width(-1);
        w = Math.min(Math.ceil(w), maxW);
        let [, h] = this._content.get_preferred_height(w);
        h = Math.ceil(h);
        this._content.set_size(w, h);
        return [w, h + (this._where === 'island' ? ISLAND_OVERLAP : 0)];
    }

    // Where the capsule hangs from: centred under the primary monitor's bar,
    // or the top of that monitor when the bar is not there (hudGeometry.js).
    _islandAnchor(width) {
        const lm = Main.layoutManager;
        const box = lm.panelBox;
        const panel = box ? {x: box.x, y: box.y, width: box.width, height: box.height, visible: box.visible} : null;
        return islandPosition(lm.primaryMonitor, panel, width);
    }

    // Bottom: centred on the focused monitor, above the dock (hudPlacement.js).
    _anchor(w, h) {
        return this._where === 'island' ? this._islandAnchor(w) : bottomAnchor(w, h, this._scale);
    }

    _place(animate = false) {
        if (this._where === 'cursor')
            this._placeAtCursor();
        else
            this._placeAnchored(animate);
    }

    // Island or bottom: ease the capsule to its new natural size, keeping it
    // centred, so a longer text makes it grow from both ends; at the bottom
    // its lower edge stays put and it grows upwards.
    _placeAnchored(animate) {
        const [w, h] = this._natural();
        const [x, y] = this._anchor(w, h);
        for (const prop of ['x', 'y', 'width', 'height'])
            this._box.remove_transition(prop);
        if (this._where === 'island')
            this._box.set_y(y);
        if (animate && this._box.opacity > 0 && !this._leaving) {
            this._box.ease({x, y, width: w, height: h, duration: RESIZE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
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

    // How the pill comes and goes is in hudEffects.js; the effect is read
    // each time, so a change in the settings shows at the next pill.
    _parts() {
        this._fx ??= {};
        return Object.assign(this._fx, {box: this._box, content: this._content, bars: this._bars, scale: this._scale,
            accent: this._accent});
    }

    _enter() {
        this._leaving = false;
        let geo = null;
        if (this._where !== 'cursor') {
            const [w, h] = this._natural();
            const [x, y] = this._anchor(w, h);
            geo = {x, y, w, h};
        }
        effects.enter(this._parts(), geo, this._getEffect(), this._where);
    }

    _leave(onComplete) {
        this._leaving = true;
        effects.leave(this._parts(), this._getEffect(), this._where, onComplete);
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
        this._progress.visible = false;
        this._setIconState(pseudo);
        this._setText(status, 'hint');
        if (fresh || leaving) {
            // New, or caught on its way out: (re)open.
            if (this._where === 'cursor')
                this._place();
            this._enter();
        } else {
            this._place(true);
        }
    }

    status(text, pseudo = '') {
        if (!this._box || this._leaving)
            return;
        if (pseudo !== 'loading' && this._progress)
            this._progress.visible = false;
        this._setIconState(pseudo);
        this._setText(text, 'hint');
        this._place(true);
    }

    live(text) {
        if (!this._box || this._leaving)
            return;
        // Words: the model is there, whatever state the engine is in.
        this._progress.visible = false;
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
        // Still loading: the hint and the bar say more than an ellipsis.
        if (this._label.has_style_pseudo_class('hint') && !this.loadingShown) {
            this._setText('…', 'hint');
            this._place(true);
        }
    }

    // The speech model is loading: the hint, and a bar that fills over the
    // time the last load took (`expectMs`), short of full until ready().
    loading(text, expectMs) {
        if (!this._box || this._leaving)
            return;
        this.status(text, 'loading');
        const fill = this._progressFill;
        const width = Math.round(PROGRESS_W * this._scale);
        this._progress.visible = true;
        fill.remove_all_transitions();
        fill.width = 0;
        fill.ease({
            width: Math.round(width * PROGRESS_CAP),
            duration: Math.max(500, expectMs),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._place(true);
    }

    // The model is there: the bar completes and goes, the icon turns blue
    // with a short pop, and `text` says so until the first words.
    ready(text) {
        if (!this._box || this._leaving)
            return;
        this._progress.visible = false;
        this._progressFill.remove_all_transitions();
        this.status(text, 'listening');
        this._meter.set_pivot_point(0.5, 0.5);
        this._meter.set_scale(1.35, 1.35);
        this._meter.ease({scale_x: 1, scale_y: 1, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    get loadingShown() {
        return !!this._progress?.visible;
    }

    // Hands-free, the silence stop comes in `ms`: the bars, flat by now,
    // glide into a ring of dots in the accent colour, which then go out one
    // after the other around it, each with a fade. stopCountdown() unrolls
    // the ring back into bars.
    countdown(ms) {
        if (!this._meter || this._leaving)
            return;
        this.stopCountdown(false);
        this._morphed = true;
        const n = this._bars.length;
        const radius = RING_RADIUS * this._scale;
        const dot = DOT * this._scale;
        const box = this._meter.get_allocation_box();
        const cx = (box.x2 - box.x1) / 2;
        const cy = (box.y2 - box.y1) / 2;
        this._bars.forEach((bar, i) => {
            // Clockwise from twelve o'clock: the line curls into the ring.
            const a = -Math.PI / 2 + 2 * Math.PI * i / n;
            const bx = bar.x + bar.width / 2;
            bar.remove_all_transitions();
            bar.set_style(`background-color: ${this._accent};`);
            bar.set_height(Math.round(dot));
            bar.ease({
                translation_x: cx + radius * Math.cos(a) - bx,
                translation_y: radius * Math.sin(a) + (cy - (bar.y + dot / 2)),
                duration: MORPH_MS,
                delay: i * 18,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
        this._ringTimeline = new Clutter.Timeline({actor: this._meter, duration: Math.max(MORPH_MS + 200, Math.round(ms))});
        const morphShare = MORPH_MS / this._ringTimeline.get_duration();
        this._ringTimeline.connect('new-frame', tl => {
            // After the morph, dot i fades out over its own slice of the time.
            const p = Math.max(0, (tl.get_progress() - morphShare) / (1 - morphShare));
            this._bars.forEach((bar, i) => {
                const lit = 1 - Math.min(1, Math.max(0, p * n - i));
                bar.opacity = Math.round(45 + 210 * lit);
            });
        });
        this._ringTimeline.start();
    }

    stopCountdown(animate = true) {
        this._ringTimeline?.stop();
        this._ringTimeline = null;
        if (!this._morphed)
            return;
        this._morphed = false;
        for (const bar of this._bars) {
            bar.remove_all_transitions();
            bar.opacity = 255;
            bar.set_style(null);
            bar.add_style_pseudo_class('quiet');
            bar.set_height(Math.round(BAR_MIN * this._scale));
            if (animate) {
                bar.ease({translation_x: 0, translation_y: 0, duration: MORPH_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            } else {
                bar.translation_x = 0;
                bar.translation_y = 0;
            }
        }
    }

    error(text) {
        this.show(text, 'error');
        this.hide(4000);
    }

    level(v) {
        if (!this._box)
            return;
        this._level = levelCurve(v);
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
        return this._state === 'error';
    }

    _close() {
        this._stopDecay();
        if (this._box)
            this._leave(() => this._destroyBox());
    }

    // '' | 'listening' | 'loading' | 'busy' | 'error'. Loading and busy:
    // the bars breathe. Error: the text turns red.
    _setIconState(pseudo) {
        this._state = pseudo;
        if (!this._meter)
            return;
        if (pseudo === 'error')
            this._label.add_style_pseudo_class('error');
        else
            this._label.remove_style_pseudo_class('error');
        // One repeating transition, not a chain of them: with animations
        // off (or the actor off stage) an ease ends at once, and a chain
        // would call itself for ever.
        this._meter.remove_transition('opacity');
        this._meter.opacity = 255;
        if (pseudo === 'loading' || pseudo === 'busy') {
            this._meter.ease({
                opacity: 80,
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
        if (this._morphed)
            return;                   // the bars are the countdown ring
        for (let i = 0; i < this._bars.length; i++) {
            const target = BAR_MIN + (BAR_MAX - BAR_MIN) * this._level * BAR_WEIGHTS[i] *
                (0.85 + 0.3 * Math.random());
            // Fast attack, slow release.
            const cur = this._heights[i];
            this._heights[i] = target > cur ? target : cur + (target - cur) * 0.35;
            const bar = this._bars[i];
            bar.set_height(Math.round(this._heights[i] * this._scale));
            const quiet = this._heights[i] <= BAR_MIN + 1.5;
            if (quiet !== bar.has_style_pseudo_class('quiet')) {
                if (quiet)
                    bar.add_style_pseudo_class('quiet');
                else
                    bar.remove_style_pseudo_class('quiet');
                bar.set_style(quiet ? null : `background-color: ${this._accent};`);
            }
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
            GLib.Source.remove(this._decayId);
            this._decayId = 0;
        }
    }

    _cancelHide() {
        if (this._hideId) {
            GLib.Source.remove(this._hideId);
            this._hideId = 0;
        }
    }
}
