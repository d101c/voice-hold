// Frame grabber for the demo GIF: once $SNAP_DIR/go exists, screenshots the
// focused window and everything above it, up to the top bar the island hangs
// from, every ~30 ms into $SNAP_DIR/fNNNNNN.png until $SNAP_DIR/stop.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
export default class Snap {
    enable() {
        this._dir = GLib.getenv('SNAP_DIR');
        this._busy = false;
        this._t0 = 0;
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => this._tick());
    }
    // $SNAP_DIR/full holds a name: one screenshot of the whole screen.
    _full() {
        const req = `${this._dir}/full`;
        if (!GLib.file_test(req, GLib.FileTest.EXISTS))
            return;
        const [, bytes] = GLib.file_get_contents(req);
        GLib.unlink(req);
        const name = new TextDecoder().decode(bytes).trim();
        const stream = Gio.File.new_for_path(`${this._dir}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
        new Shell.Screenshot().screenshot(false, stream, (o, res) => {
            try { o.screenshot_finish(res); } catch (e) { logError(e, 'snap'); }
            stream.close(null);
        });
    }
    _tick() {
        this._full();
        const go = GLib.file_test(`${this._dir}/go`, GLib.FileTest.EXISTS);
        const stop = GLib.file_test(`${this._dir}/stop`, GLib.FileTest.EXISTS);
        if (!go || stop || this._busy)
            return GLib.SOURCE_CONTINUE;
        if (!this._t0) {
            this._t0 = GLib.get_monotonic_time();
            const w = global.display.focus_window;
            const r = w.get_frame_rect();
            // From the top of the screen (the island), with room below the
            // window for the pill when it follows the cursor.
            this._rect = [r.x, 0, r.width, r.y + r.height + 70];
            GLib.file_set_contents(`${this._dir}/rect`, this._rect.join(' '));
        }
        this._busy = true;
        const ms = Math.round((GLib.get_monotonic_time() - this._t0) / 1000);
        const file = Gio.File.new_for_path(`${this._dir}/f${String(ms).padStart(6, '0')}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shot = new Shell.Screenshot();
        shot.screenshot_area(...this._rect, stream, (o, res) => {
            try { o.screenshot_area_finish(res); } catch (e) { logError(e, 'snap'); }
            stream.close(null);
            this._busy = false;
        });
        return GLib.SOURCE_CONTINUE;
    }
    disable() { GLib.source_remove(this._id); }
}
