#!/usr/bin/env bash
# Build the uploadable bundle for extensions.gnome.org.
# Produces voice-hold@griffit.gmail.com.shell-extension.zip in the repo root.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO/extension"
SCHEMA="schemas/org.gnome.shell.extensions.voice-hold.gschema.xml"
DOMAIN="voice-hold"
ZIP="$REPO/voice-hold@griffit.gmail.com.shell-extension.zip"

# The .po files are compiled by `gnome-extensions pack` itself (--podir).
# For an in-place install (a symlink to extension/), compile them by hand:
#   msgfmt extension/po/fr.po -o extension/locale/fr/LC_MESSAGES/voice-hold.mo
PODIR=()
[ -d "$SRC/po" ] && PODIR=(--podir=po --gettext-domain="$DOMAIN")

gnome-extensions pack "$SRC" \
  --extra-source=dictation.js \
  --extra-source=engine.js \
  --extra-source=holdMachine.js \
  --extra-source=hud.js \
  --extra-source=keyHook.js \
  --extra-source=panelIndicator.js \
  --extra-source=textSink.js \
  "${PODIR[@]}" \
  --schema="$SCHEMA" \
  --out-dir="$REPO" \
  --force

# `gnome-extensions pack` flattens --extra-source files, so the icons/
# directory is added afterwards with its path preserved.
( cd "$SRC" && zip -r -q "$ZIP" icons )

echo "Built: $ZIP"
