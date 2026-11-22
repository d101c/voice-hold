#!/usr/bin/env bash
# Runs inside the private D-Bus session set up by run.sh.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$S/env"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.desktop.input-sources sources "[('xkb','fr')]"
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
# ACCENT=slate: the system accent colour the pills take.
[ -n "${ACCENT:-}" ] && gsettings set org.gnome.desktop.interface accent-color "$ACCENT"
gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 --wayland-display=wayland-t > "$T/shell.log" 2>&1 &
SH=$!
sleep 6
gnome-extensions enable voice-hold@griffit.gmail.com
# HUD=cursor: the pill next to the text cursor instead of the island.
[ -n "${HUD:-}" ] && gsettings --schemadir "$T/data/gnome-shell/extensions/voice-hold@griffit.gmail.com/schemas" \
    set org.gnome.shell.extensions.voice-hold hud-position "$HUD"
# COMMANDS=1: the voice commands switched on (Ctrl+Alt+Space).
[ "${COMMANDS:-0}" = 1 ] && gsettings --schemadir "$T/data/gnome-shell/extensions/voice-hold@griffit.gmail.com/schemas" \
    set org.gnome.shell.extensions.voice-hold commands-enabled true
[ "${SNAP:-0}" = 1 ] && gnome-extensions enable snap@test
# MPRIS=1: a media player that is playing; its Pause / Play go to mpris.log.
[ "${MPRIS:-0}" = 1 ] && { "$S/../../engine/.venv/bin/python" "$S/fake_mpris.py" "$T/mpris.log" & MP=$!; }
sleep 1
# APP="libreoffice --writer": that application instead of the test client.
if [ -n "${APP:-}" ]; then
    WAYLAND_DISPLAY=wayland-t GDK_BACKEND=wayland bash -c "$APP" > "$T/client.err" 2>&1 &
else
    WAYLAND_DISPLAY=wayland-t GDK_BACKEND=wayland GTK_A11Y=none NO_AT_BRIDGE=1 python3 "$S/client.py" "$T/client.log" > "$T/client.err" 2>&1 &
fi
sleep 3
echo "dconf=$(ls "$XDG_CONFIG_HOME/dconf" 2>/dev/null) bus=$DBUS_SESSION_BUS_ADDRESS" >&2
# PREFS=1: open the preferences window instead (its errors go to prefs.err).
if [ "${PREFS:-0}" = 1 ]; then
    WAYLAND_DISPLAY=wayland-t GDK_BACKEND=wayland gnome-extensions prefs voice-hold@griffit.gmail.com > "$T/prefs.err" 2>&1 &
    sleep 4
fi
# WARM="down:ctrl sp p:12000 up:ctrl p:2000": a first dictation so the model
# is loaded before the frames of the demo are grabbed. Everything runs in one
# virtual keyboard session (the `go` token starts the grabber).
SEQ="$1"
[ "${SNAP:-0}" = 1 ] && SEQ="go $SEQ"
[ -n "${WARM:-}" ] && SEQ="$WARM $SEQ"
python3 "$S/inject.py" "$SEQ"
# FULL=name (with SNAP=1): one screenshot of the whole screen at the end,
# in frames/name.png.
[ -n "${FULL:-}" ] && { echo "$FULL" > "$S/frames/full"; sleep 1.5; }
[ "${SNAP:-0}" = 1 ] && { sleep 0.8; touch "$S/frames/stop"; sleep 0.5; }
# Let the engine log its tail before the bus goes away.
sleep 0.5
dbus-send --session --print-reply --dest=org.griffit.VoiceHold /org/griffit/VoiceHold org.griffit.VoiceHold.Quit >/dev/null 2>&1
kill $SH; wait $SH 2>/dev/null
[ -n "${MP:-}" ] && kill $MP
echo "=== client.log"; cat "$T/client.log"
echo "=== shell.log (voice-hold lines)"; grep -i -E "voice-hold|JS ERROR|Extension .*voice" "$T/shell.log" | tail -20
