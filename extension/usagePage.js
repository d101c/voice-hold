// SPDX-License-Identifier: GPL-2.0-or-later

// Preferences page "Usage": how much was dictated, from the numbers kept by
// usage.js (never the words). Three figures, the last thirty days as bars,
// and the details in rows.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {TYPING_WPM, clear, dayKey, duration, load, summarize} from './usage.js';

function figure(value, caption) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        hexpand: true,
        css_classes: ['card'],
    });
    const number = new Gtk.Label({label: value, css_classes: ['title-1', 'numeric'], margin_top: 18});
    const label = new Gtk.Label({
        label: caption,
        css_classes: ['caption', 'dim-label'],
        margin_bottom: 18, margin_start: 8, margin_end: 8,
        wrap: true, justify: Gtk.Justification.CENTER,
    });
    box.append(number);
    box.append(label);
    return {box, number, label};
}

// The thirty bars. Today's takes the accent colour, the others the text
// colour, dimmed; a day without a word keeps a short stub so the rhythm of
// the days stays readable.
function chart(getDays) {
    const area = new Gtk.DrawingArea({content_height: 96, hexpand: true, margin_top: 6, margin_bottom: 2});
    area.set_draw_func((a, cr, w, h) => {
        const days = getDays();
        const max = Math.max(1, ...days.map(d => d.words));
        const gap = 4;
        const bw = Math.max(2, (w - gap * (days.length - 1)) / days.length);
        const fg = a.get_color();
        const style = a.get_style_context();
        const [hasAccent, accent] = style.lookup_color('accent_bg_color');
        days.forEach((d, i) => {
            const bh = d.words ? Math.max(4, Math.round((h - 2) * d.words / max)) : 2;
            const x = i * (bw + gap), y = h - bh, r = Math.min(3, bw / 2, bh / 2);
            const last = i === days.length - 1;
            if (last && hasAccent)
                cr.setSourceRGBA(accent.red, accent.green, accent.blue, 1);
            else
                cr.setSourceRGBA(fg.red, fg.green, fg.blue, d.words ? (last ? 0.9 : 0.45) : 0.15);
            cr.newPath();
            cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
            cr.arc(x + bw - r, y + r, r, 1.5 * Math.PI, 2 * Math.PI);
            cr.lineTo(x + bw, h);
            cr.lineTo(x, h);
            cr.closePath();
            cr.fill();
        });
        cr.$dispose();
    });
    return area;
}

export function buildUsagePage(settings, gettext, ngettext) {
    const _ = gettext;
    const page = new Adw.PreferencesPage({title: _('Usage'), icon_name: 'power-profile-balanced-symbolic'});
    let s = summarize(load(), dayKey(new Date()));
    const number = n => n.toLocaleString();

    // -- the three figures --
    const top = new Adw.PreferencesGroup();
    page.add(top);
    const cards = new Gtk.Box({spacing: 12, homogeneous: true});
    const words = figure('', _('words dictated'));
    const saved = figure('', _('saved, next to typing'));
    const streak = figure('', '');
    for (const f of [words, saved, streak])
        cards.append(f.box);
    top.add(cards);

    // -- thirty days --
    const month = new Adw.PreferencesGroup({title: _('The last 30 days')});
    page.add(month);
    const frame = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['card']});
    const inner = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_top: 14, margin_bottom: 12, margin_start: 16, margin_end: 16,
    });
    const bars = chart(() => s.last30);
    inner.append(bars);
    const legend = new Gtk.Box({margin_top: 6});
    const from = new Gtk.Label({css_classes: ['caption', 'dim-label'], hexpand: true, xalign: 0});
    const to = new Gtk.Label({label: _('Today'), css_classes: ['caption', 'dim-label'], xalign: 1});
    legend.append(from);
    legend.append(to);
    inner.append(legend);
    frame.append(inner);
    month.add(frame);

    // -- details --
    const details = new Adw.PreferencesGroup();
    page.add(details);
    const row = title => {
        const r = new Adw.ActionRow({title});
        const v = new Gtk.Label({css_classes: ['dim-label', 'numeric']});
        r.add_suffix(v);
        details.add(r);
        return v;
    };
    const today = row(_('Today'));
    const week = row(_('This week'));
    const speed = row(_('Your speaking speed'));
    const count = row(_('Dictations'));
    const spoken = row(_('Time spent dictating'));

    // -- what is kept --
    const kept = new Adw.PreferencesGroup({
        description: _('Counted on this computer. Only numbers are kept, one line a day: never your words, never your voice.'),
    });
    page.add(kept);
    const on = new Adw.SwitchRow({title: _('Count what I dictate')});
    kept.add(on);
    settings.bind('usage-stats', on, 'active', Gio.SettingsBindFlags.DEFAULT);
    const reset = new Adw.ActionRow({title: _('Start again from zero')});
    const button = new Gtk.Button({label: _('Reset'), valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
    reset.add_suffix(button);
    kept.add(reset);

    const fill = () => {
        s = summarize(load(), dayKey(new Date()));
        words.number.label = number(s.words);
        saved.number.label = duration(s.savedSeconds, _);
        streak.number.label = number(s.streak);
        streak.label.label = ngettext('day in a row', 'days in a row', s.streak);
        today.label = ngettext('%s word', '%s words', s.today).replace('%s', number(s.today));
        week.label = ngettext('%s word', '%s words', s.week).replace('%s', number(s.week));
        speed.label = s.wpm
            ? _('%d words a minute, against about %d typed').replace('%d', s.wpm).replace('%d', TYPING_WPM)
            : _('Not enough yet');
        count.label = number(s.dictations);
        spoken.label = duration(s.seconds, _);
        const first = s.last30[0].day.split('-').map(Number);
        from.label = GLib.DateTime.new_local(first[0], first[1], first[2], 0, 0, 0).format('%e %B').trim();
        month.description = s.words ? '' : _('Nothing yet. Hold the shortcut and say a sentence: the first bar appears here.');
        bars.queue_draw();
        button.sensitive = s.words > 0;
    };
    button.connect('clicked', () => {
        clear();
        fill();
    });
    // The numbers move while the window is open: read them again when the
    // page is shown.
    page.connect('map', fill);
    fill();
    return page;
}
