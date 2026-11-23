#!/bin/bash
# Copy the shared engine from ../chess-cheat/ into both iOS targets.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$SCRIPT_DIR/../chess-cheat"
APP_RES="$SCRIPT_DIR/app/PupsiChess/Resources"
TWEAK_RES="$SCRIPT_DIR/tweak/layout/Library/Application Support/Pupsi"

for DEST in "$APP_RES" "$TWEAK_RES"; do
  mkdir -p "$DEST/popup" "$DEST/stockfish" "$DEST/icons"
  cp "$ENGINE/content.js" "$ENGINE/styles.css" "$ENGINE/page-bridge.js" "$DEST/"
  cp "$ENGINE/popup/"* "$DEST/popup/"
  cp "$ENGINE/stockfish/"* "$DEST/stockfish/"
  cp "$ENGINE/icons/"* "$DEST/icons/"
  if [ "$DEST" != "$APP_RES" ]; then
    cp "$APP_RES/pupsi-shim.js" "$DEST/pupsi-shim.js"
  fi
  echo "==> Engine sync: $DEST"
done
