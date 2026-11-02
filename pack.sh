#!/usr/bin/env bash
# Build the uploadable bundle for extensions.gnome.org.
# Produces voice-hold@griffit.gmail.com.shell-extension.zip in the repo root.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO/extension"
SCHEMA="schemas/org.gnome.shell.extensions.voice-hold.gschema.xml"
DOMAIN="voice-hold"
ZIP="$REPO/voice-hold@griffit.gmail.com.shell-extension.zip"

if command -v msgfmt >/dev/null 2>&1; then
    for po in "$SRC"/po/*.po; do
        [ -e "$po" ] || continue
        lang="$(basename "$po" .po)"
        dest="$SRC/locale/$lang/LC_MESSAGES"
        mkdir -p "$dest"
        msgfmt "$po" -o "$dest/$DOMAIN.mo"
    done
fi

PODIR=()
[ -d "$SRC/po" ] && PODIR=(--podir=po --gettext-domain="$DOMAIN")

gnome-extensions pack "$SRC" \
  --extra-source=dictation.js \
  --extra-source=engine.js \
  --extra-source=holdMachine.js \
  --extra-source=hud.js \
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
