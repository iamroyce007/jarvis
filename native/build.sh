#!/usr/bin/env bash
# Builds the JARVIS native voice helper (on-device STT + TTS + VAD).
#
# The helper ships as a real .app bundle, not a bare executable: TCC will not
# honour usage strings from a command-line tool's embedded __info_plist, and
# kills the process with SIGABRT the moment it touches the microphone or the
# speech recognizer. A bundle with Contents/Info.plist is the only reliable form.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/bin"
APP="$OUT/JarvisVoice.app"
MACOS="$APP/Contents/MacOS"
SRC="$DIR/jarvis-voice.swift"
BIN="$MACOS/jarvis-voice"

# macOS attributes some prompts to the responsible parent process (Electron),
# so the usage strings must exist there too.
DEV_PLIST="$DIR/../node_modules/electron/dist/Electron.app/Contents/Info.plist"
add_usage() {
  local key="$1" text="$2"
  if ! /usr/libexec/PlistBuddy -c "Print :$key" "$DEV_PLIST" &>/dev/null; then
    /usr/libexec/PlistBuddy -c "Add :$key string '$text'" "$DEV_PLIST" &>/dev/null \
      && echo "native: added $key to dev Electron"
  fi
}
if [[ -f "$DEV_PLIST" ]]; then
  add_usage NSMicrophoneUsageDescription \
    'JARVIS listens to your voice commands.'
  add_usage NSSpeechRecognitionUsageDescription \
    'JARVIS uses on-device speech recognition to understand your voice commands.'
  add_usage NSAppleEventsUsageDescription \
    'JARVIS controls applications on your Mac to carry out your requests.'
fi

if [[ -f "$BIN" && "$BIN" -nt "$SRC" ]]; then
  echo "native: JarvisVoice.app up to date"
  exit 0
fi

echo "native: building JarvisVoice.app…"
mkdir -p "$MACOS"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"

swiftc -O \
  -framework AVFoundation \
  -framework Speech \
  -framework AppKit \
  -o "$BIN" \
  "$SRC"

# A stable ad-hoc signature keeps the TCC grant attached across rebuilds.
codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo "native: built $APP"
