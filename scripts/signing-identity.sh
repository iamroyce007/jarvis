#!/usr/bin/env bash
# Creates a stable local code-signing identity for JARVIS (one time only).
#
# Ad-hoc signing (`codesign --sign -`) produces a new code hash on every build,
# and macOS TCC keys microphone/speech grants to that hash — so every rebuild
# looks like a brand-new app and re-prompts for permissions. Signing with a
# persistent self-signed certificate keeps the designated requirement stable,
# so permissions are granted once and stay granted.
set -euo pipefail

CN="JARVIS Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$CN"; then
  echo "✓ Signing identity '$CN' already exists."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "› generating certificate"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -subj "/CN=$CN" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  2>/dev/null

openssl pkcs12 -export -out "$TMP/jarvis.p12" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -passout pass: 2>/dev/null

echo "› importing into your login keychain"
echo "  (macOS may ask for your login password — this is the only time)"
security import "$TMP/jarvis.p12" -k "$KEYCHAIN" -P "" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null

# Allow codesign to use the key without prompting on every build.
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -k "" "$KEYCHAIN" >/dev/null 2>&1 || true

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$CN"; then
  echo "✓ Created signing identity '$CN'."
  echo "  Rebuilds now keep the same signature, so permissions persist."
else
  echo "! Identity not usable for code signing; builds will fall back to ad-hoc."
  exit 1
fi
