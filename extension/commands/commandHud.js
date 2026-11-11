import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as effects from '../hudEffects.js';
import {cursorPosition, islandPosition, trailing, ISLAND_OVERLAP} from '../hudGeometry.js';
import {systemFontCss} from '../systemFont.js';

// The pill of the voice commands: the same island as the dictation's
// (../hud.js: same placements, same geometry, same entrance and exit), plus
// what a command needs and a dictation does not.
//
// A result (the output of a command, a long answer) opens a second area
// under the status line: several lines, scrollable past its max-height,
// kept until the user clicks the capsule, the next command, or a long delay.
// The capsule only takes the pointer while it shows one.

const BARS = 7;
const BAR_WEIGHTS = [0.45, 0.7, 1.0, 0.8, 1.0, 0.7, 0.45];
const BAR_MIN = 3;
const BAR_MAX = 20;
const HIDE_DELAY_MS = 450;
const MAX_CHARS = 64;

const RESIZE_MS = 220;
const PANEL_OPAQUE_ALPHA = 200;   // below this the bar is see-through (Blur my Shell…): use black
const MONITOR_MARGIN = 24;        // the capsule never comes closer than this to the monitor's edges

export class CommandHud {
    // getPosition: () => 'island' | 'cursor' and getEffect: () => one of
    // hudEffects.EFFECTS, both read each time the pill opens.
    constructor(iconPath, gettext, getPosition = () => 'island', getEffect = () => effects.DEFAULT_EFFECT) {
        this._getEffect = getEffect;
        this._ = gettext || (s => s);
        this._iconPath = iconPath;
        this._getPosition = getPosition;
        this._island = true;
        this._scale = 1;
        this._box = null;       // outer capsule
        this._clip = null;      // clipping box
        this._content = null;   // inner box: a row, then the result
        this._row = null;
        this._scroll = null;    // result area, hidden until there is one
        this._result = null;
        this._onDismiss = null;
        this._hovering = false;
        this._pausedHide = 0;
        this._icon = null;
        this._bars = [];
        this._heights = new Array(BARS).fill(BAR_MIN);
        this._label = null;
        this._hideId = 0;
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
            style_class: `voice-cmd-hud ${this._island ? 'voice-cmd-hud-island' : 'voice-cmd-hud-cursor'}`,
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            track_hover: true,
            opacity: 0,
        });
        // The system's interface font, and for the island the bar's colour.
        this._box.set_style(systemFontCss() + (this._island ? ` background-color: ${this._panelColor()};` : ''));
        this._box.connect('button-press-event', () => {
            if (this._onDismiss)
                this._onDismiss();
            return Clutter.EVENT_STOP;
        });
        this._box.connect('notify::hover', () => {
            this._hovering = this._box.hover;
            if (!this._hovering && this._pausedHide) {
                const delay = this._pausedHide;
                this._pausedHide = 0;
                this.hide(delay);
            }
        });

        this._clip = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: this._island,
            x_expand: true,
            y_expand: true,
        });
        this._box.add_child(this._clip);

        this._content = new St.BoxLayout({
            style_class: `voice-cmd-hud-content ${this._island ? 'voice-cmd-hud-content-island' : ''}`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        setVertical(this._content);
        this._clip.add_child(this._content);

        this._row = new St.BoxLayout({style_class: 'voice-cmd-hud-row', x_align: Clutter.ActorAlign.CENTER});
        this._content.add_child(this._row);

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(this._iconPath),
            style_class: 'voice-cmd-hud-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._row.add_child(this._icon);

        const bars = new St.BoxLayout({style_class: 'voice-cmd-hud-bars', y_align: Clutter.ActorAlign.CENTER});
        this._bars = [];
        for (let i = 0; i < BARS; i++) {
            const bar = new St.Widget({style_class: 'voice-cmd-hud-bar', y_align: Clutter.ActorAlign.CENTER});
            bar.set_height(BAR_MIN * this._scale);
            bar.add_style_pseudo_class('quiet');
            bars.add_child(bar);
            this._bars.push(bar);
        }
        this._row.add_child(bars);

        this._label = new St.Label({style_class: 'voice-cmd-hud-text', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.START);
        this._label.clutter_text.set_single_line_mode(true);
        this._row.add_child(this._label);

        this._scroll = new St.ScrollView({style_class: 'voice-cmd-hud-result', visible: false, x_expand: true});
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        if ('overlay_scrollbars' in this._scroll)
            this._scroll.overlay_scrollbars = true;
        this._result = new St.Label({style_class: 'voice-cmd-hud-result-text'});
        this._result.clutter_text.set_line_wrap(true);
        this._result.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._result.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        // A scroll view's child must be scrollable (St.BoxLayout is; a label is not).
        const scrolled = new St.BoxLayout({x_expand: true});
        setVertical(scrolled);
        scrolled.add_child(this._result);
        if (this._scroll.set_child)
            this._scroll.set_child(scrolled);
        else
            this._scroll.add_actor(scrolled);
        this._content.add_child(this._scroll);

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
        this._row = null;
        this._scroll = null;
        this._result = null;
        this._onDismiss = null;
        this._hovering = false;
        this._pausedHide = 0;
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
        return Object.assign(this._fx, {box: this._box, content: this._content, bars: this._bars, scale: this._scale});
    }

    _enter() {
        this._leaving = false;
        let geo = null;
        if (this._island) {
            const [w, h] = this._natural();
            const [x, y] = this._islandAnchor(w);
            geo = {x, y, w, h};
        }
        effects.enter(this._parts(), geo, this._getEffect(), this._island);
    }

    _leave(onComplete) {
        this._leaving = true;
        effects.leave(this._parts(), this._getEffect(), this._island, onComplete);
    }

    // -- public ----------------------------------------------------------

    show(status, pseudo = '') {
        this._cancelHide();
        this._build();
        const fresh = this._box.opacity === 0;
        const leaving = this._leaving;
        this._setIconState(pseudo);
        this._setText(status, 'hint');
        this._setResult('');
        this._box.reactive = false;
        if (fresh || leaving) {
            // New, or caught on its way out: (re)open from the bar.
            if (!this._island)
                this._place();
            this._enter();
        } else {
            this._place(true);
        }
    }

    // Change the line of a pill that is on screen. Nothing when there is
    // none (the pill is switched off, or was dismissed).
    status(text, pseudo = '') {
        if (!this._box)
            return;
        if (this._leaving) {
            this.show(text, pseudo);      // caught on its way out
            return;
        }
        this._setIconState(pseudo);
        this._setText(text, 'hint');
        this._setResult('');
        this._box.reactive = false;
        this._place(true);
    }

    // A status line with a result under it: several lines, scrollable when
    // long, monospace for a command's output. The capsule takes clicks (to
    // dismiss, see onDismiss) and the wheel (to scroll) while it shows one.
    result(header, text, {pseudo = 'listening', monospace = false, onDismiss = null} = {}) {
        this._cancelHide();
        this._build();
        const fresh = this._box.opacity === 0;
        const leaving = this._leaving;
        this._setIconState(pseudo);
        this._setText(header, 'hint');
        this._setResult(text, monospace);
        this._onDismiss = onDismiss;
        this._box.reactive = true;
        if (fresh || leaving) {
            if (!this._island)
                this._place();
            this._enter();
        } else {
            this._place(true);
        }
    }

    // Change the status line over a result without touching the result.
    header(text, pseudo = '') {
        if (!this._box || this._leaving)
            return;
        this._setIconState(pseudo);
        this._setText(text, 'hint');
        this._place(true);
    }

    get showingResult() {
        return !!this._scroll?.visible && !this._leaving;
    }

    live(text) {
        if (!this._box || this._leaving)
            return;
        this._setText(trailing(text.replace(/\n/g, ' ⏎ '), MAX_CHARS), 'live');
        this._place(true);
    }

    error(text) {
        this.show(text, 'error');
        this.hide(4000);
    }

    level(v) {
        if (!this._box || this._leaving)
            return;
        this._level = Math.max(0, Math.min(1, v));
        this._paintBars();
        this._startDecay();
    }

    hide(delay = HIDE_DELAY_MS) {
        this._cancelHide();
        if (!this._box || this._leaving)
            return;
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hideId = 0;
            if (this._hovering && this._box?.reactive) {
                // Being read: wait until the pointer leaves.
                this._pausedHide = Math.max(HIDE_DELAY_MS * 4, delay / 4);
                return GLib.SOURCE_REMOVE;
            }
            this._stopDecay();
            if (this._box)
                this._leave(() => this._destroyBox());
            return GLib.SOURCE_REMOVE;
        });
    }

    hideNow() {
        this._cancelHide();
        this._stopDecay();
        this._destroyBox();
    }

    // -- internals -------------------------------------------------------

    _setIconState(pseudo) {
        if (!this._icon)
            return;
        for (const p of ['listening', 'loading', 'error'])
            this._icon.remove_style_pseudo_class(p);
        if (pseudo)
            this._icon.add_style_pseudo_class(pseudo);
        // Grey and breathing while something is awaited (the engine, the
        // LLM, a command), solid otherwise. One repeating transition, not a
        // chain of them: with animations off (or the actor off stage) an
        // ease ends at once, and a chain would call itself for ever.
        this._icon.remove_all_transitions();
        this._icon.opacity = 255;
        if (pseudo === 'loading') {
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
    }

    _setResult(text, monospace = false) {
        if (!this._scroll)
            return;
        if (monospace)
            this._result.add_style_pseudo_class('mono');
        else
            this._result.remove_style_pseudo_class('mono');
        this._result.set_text(text);
        this._scroll.visible = !!text;
        if (!text) {
            this._onDismiss = null;
            this._pausedHide = 0;
        }
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
        this._pausedHide = 0;
    }
}

// St.BoxLayout: `orientation` from GNOME 48, `vertical` (deprecated) before.
function setVertical(box) {
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
}
