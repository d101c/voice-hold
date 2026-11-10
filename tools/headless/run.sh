#!/usr/bin/env bash
# End-to-end run in a headless GNOME Shell, fully isolated from the user's
# session: private HOME/XDG dirs and a private D-Bus session, so nothing here
# touches the real dconf. The engine is D-Bus-activated inside that session
# and reads a WAV file instead of the microphone.
#
#   tools/headless/run.sh [wav] [key sequence]
#
# Outputs: tools/headless/env/{client.log,shell.log} (the engine, activated
# by the private bus, logs to this script's stderr); frames in
# tools/headless/frames when SNAP=1.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$S/../.." && pwd)"; T="$S/env"
WAV="${1:-$REPO/engine/tests/data/cafe.wav}"
SEQ="${2:-down:ctrl sp p:12000 up:ctrl p:1500}"
ENGINE="${ENGINE:-$REPO/engine/.venv/bin/voice-hold-engine}"
MODELS="${VOICE_HOLD_MODELS:-$HOME/.local/share/voice-hold/models}"

rm -rf "$T"; RT=$(mktemp -d /tmp/vhd.XXXX)
mkdir -p "$T/config" "$T/data/gnome-shell/extensions" "$T/data/dbus-1/services" "$S/frames"
rm -f "$S"/frames/*
cp -r "$REPO/extension" "$T/data/gnome-shell/extensions/voice-hold@griffit.gmail.com"
glib-compile-schemas "$T/data/gnome-shell/extensions/voice-hold@griffit.gmail.com/schemas"
[ -d "$S/snap@test" ] && cp -r "$S/snap@test" "$T/data/gnome-shell/extensions/"
printf '[D-BUS Service]\nName=org.griffit.VoiceHold\nExec=%s serve\n' "$ENGINE" \
  > "$T/data/dbus-1/services/org.griffit.VoiceHold.service"

env -u WAYLAND_DISPLAY -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
  HOME="$T" XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_CACHE_HOME="$RT/c" \
  XDG_RUNTIME_DIR="$RT" SNAP_DIR="$S/frames" GSETTINGS_BACKEND=dconf \
  VOICE_HOLD_AUDIO_FILE="$WAV" VOICE_HOLD_MODELS="$MODELS" VOICE_HOLD_IDLE_S=20 \
  dbus-run-session -- "$S/inner.sh" "$SEQ"
rm -rf "$RT"
