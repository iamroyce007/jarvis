#!/usr/bin/env bash
# Registers (or removes) JARVIS as a macOS login item.
#   npm run autostart        → launch JARVIS at login
#   npm run autostart -- off → stop launching at login
set -euo pipefail

APP="/Applications/JARVIS.app"

if [[ "${1:-on}" == "off" ]]; then
  osascript -e 'tell application "System Events" to delete login item "JARVIS"' 2>/dev/null || true
  echo "✓ JARVIS will no longer start at login."
  exit 0
fi

[[ -d "$APP" ]] || { echo "error: $APP not found. Run: npm run package"; exit 1; }

# Replace any stale entry so repeated runs stay idempotent.
osascript -e 'tell application "System Events" to delete login item "JARVIS"' 2>/dev/null || true
osascript -e "tell application \"System Events\" to make login item at end \
  with properties {path:\"$APP\", hidden:false, name:\"JARVIS\"}" >/dev/null

echo "✓ JARVIS will start automatically at login."
