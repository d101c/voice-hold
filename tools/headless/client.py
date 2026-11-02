# Demo/test client: a big GTK4 text view. Every change of its text (and of
# the preedit, i.e. the live partial) is appended to the log file given as
# first argument, with a timestamp, so a harness can check that words arrive
# progressively.
import sys
import time

import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gdk

LOG = sys.argv[1] if len(sys.argv) > 1 else '/dev/null'
TITLE = sys.argv[2] if len(sys.argv) > 2 else 'Voice Hold'
T0 = time.monotonic()
css = b"""
textview, textview text { font-size: 30px; font-family: 'Cantarell', sans-serif; }
textview { padding: 28px 32px; }
"""


def log(kind, text):
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(f'{time.monotonic() - T0:7.3f} {kind} {text!r}\n')


def activate(app):
    p = Gtk.CssProvider()
    p.load_from_data(css)
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), p, 800)
    win = Gtk.ApplicationWindow(application=app, title=TITLE)
    win.set_default_size(860, 320)
    tv = Gtk.TextView()
    tv.set_wrap_mode(Gtk.WrapMode.WORD)
    buf = tv.get_buffer()
    buf.connect('changed', lambda b: log('text', b.get_text(b.get_start_iter(), b.get_end_iter(), True)))
    tv.connect('preedit-changed', lambda _tv, preedit: log('preedit', preedit))
    win.set_child(tv)
    win.present()
    tv.grab_focus()


app = Gtk.Application(application_id='io.github.d101c.VoiceHoldDemo')
app.connect('activate', activate)
app.run([])
