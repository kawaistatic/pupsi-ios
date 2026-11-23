#!/bin/bash
# Pupsi Chess - generate and open the iOS Xcode project
# Needs: brew install xcodegen
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen fehlt. Installieren mit: brew install xcodegen"
  exit 1
fi

./sync.sh
xcodegen generate --spec project.yml
echo "==> Xcode-Projekt erzeugt: PupsiChess.xcodeproj"
echo "==> In Xcode: Team wählen, iPhone anschließen, Run."
open PupsiChess.xcodeproj
