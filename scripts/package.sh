#!/usr/bin/env bash
# Packages JARVIS as a standalone, signed macOS app.
#
# This is not a convenience step — it is required for voice to work at all.
# macOS attributes privacy prompts to the "responsible process". When JARVIS is
# started via `npx electron .`, that process is the terminal (or whatever
# launched it), which has no microphone or speech-recognition usage strings, so
# TCC kills the voice helper with SIGABRT before it can ask for anything.
# Running as its own signed .app makes JARVIS the responsible process.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/JARVIS.app"
ELECTRON="$ROOT/node_modules/electron/dist/Electron.app"

[[ -d "$ELECTRON" ]] || { echo "error: Electron not installed. Run npm install."; exit 1; }

echo "› building renderer + main"
(cd "$ROOT" && npm run build >/dev/null)

echo "› assembling JARVIS.app"
rm -rf "$APP"
mkdir -p "$DIST"
cp -R "$ELECTRON" "$APP"

# Rename the executable to JARVIS so the menu bar and Force Quit read correctly.
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/JARVIS"

PLIST="$APP/Contents/Info.plist"
set_key() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null \
         || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"; }

set_key CFBundleExecutable JARVIS
set_key CFBundleName JARVIS
set_key CFBundleDisplayName JARVIS
set_key CFBundleIdentifier com.jarvis.app
set_key CFBundleShortVersionString 0.1.0
set_key NSMicrophoneUsageDescription "JARVIS listens to your voice commands."
set_key NSSpeechRecognitionUsageDescription "JARVIS uses on-device speech recognition to understand your voice commands."
set_key NSAppleEventsUsageDescription "JARVIS controls applications on your Mac to carry out your requests."
set_key NSSystemAdministrationUsageDescription "JARVIS performs system tasks you ask it to."

# App code.
RES="$APP/Contents/Resources/app"
mkdir -p "$RES"
cp -R "$ROOT/out" "$RES/out"
cp "$ROOT/package.json" "$RES/package.json"

# The voice helper bundle ships inside Resources/native.
mkdir -p "$APP/Contents/Resources/native"
cp -R "$ROOT/native/bin/JarvisVoice.app" "$APP/Contents/Resources/native/"

# Prefer a real signing identity over ad-hoc.
#
# Ad-hoc signatures change on every build, and macOS TCC ties microphone and
# speech grants to the signature — so each rebuild re-prompts for permission.
# A stable identity keeps the designated requirement constant, so the grants
# survive. Override with JARVIS_IDENTITY.
IDENTITY="${JARVIS_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -oE '"(Apple Development|Developer ID Application|JARVIS Local Signing)[^"]*"' \
    | head -1 | tr -d '"')"
fi
[[ -n "$IDENTITY" ]] || IDENTITY="-"

if [[ "$IDENTITY" == "-" ]]; then
  echo "› signing (ad-hoc — permissions will reset on each rebuild)"
else
  echo "› signing as: $IDENTITY"
fi

# Sign inner code first, then the outer bundle, or the seal will not verify.
codesign --force --sign "$IDENTITY" --timestamp=none \
  "$APP/Contents/Resources/native/JarvisVoice.app/Contents/MacOS/jarvis-voice" 2>/dev/null || true
codesign --force --sign "$IDENTITY" --timestamp=none \
  "$APP/Contents/Resources/native/JarvisVoice.app" 2>/dev/null || true
codesign --force --deep --sign "$IDENTITY" --timestamp=none "$APP" 2>/dev/null || true

codesign -v "$APP" 2>&1 | head -3 || true

# Install into /Applications so JARVIS behaves like a real app. Keeping it at a
# stable path also stops macOS from re-asking for microphone and speech access:
# TCC keys the grant to the app's location and signature.
INSTALLED="/Applications/JARVIS.app"
if [[ "${JARVIS_INSTALL:-1}" == "1" ]]; then
  echo "› installing to $INSTALLED"
  # Quit any running copy so the bundle can be replaced cleanly.
  pkill -f "JARVIS.app/Contents/MacOS/JARVIS" 2>/dev/null || true
  sleep 1
  rm -rf "$INSTALLED"
  cp -R "$APP" "$INSTALLED"
  APP="$INSTALLED"
fi

echo
echo "✓ JARVIS installed at $APP"
echo "  Launch:        open -a JARVIS"
echo "  Start at login: npm run autostart"
