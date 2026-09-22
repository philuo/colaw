#!/usr/bin/env bash
# One-time creation of the self-signed code-signing identity that gives
# Colaw.app a stable Designated Requirement: TCC grants (Accessibility,
# Screen Recording) survive app updates because every build is signed by the
# same certificate — no Apple Developer account required.
#
# Idempotent: re-running prints the existing identity and exits.
# The signing keychain password is generated here and stored next to it
# (0600) so `codesign` can run non-interactively from the pack.

set -euo pipefail

CERT_CN="colaw-codesign"
KEYCHAIN="colaw-sign"
KEYCHAIN_DIR="${HOME}/.colaw"
KEYCHAIN_PATH="${KEYCHAIN_DIR}/${KEYCHAIN}.keychain-db"
PASS_FILE="${KEYCHAIN_DIR}/${KEYCHAIN}.keychain-pass"

existing="$(security find-identity -v -p codesign 2>/dev/null | grep "${CERT_CN}" || true)"
if [ -n "$existing" ]; then
  echo "create-colaw-signing-cert: identity already present:"
  echo "$existing"
  exit 0
fi

mkdir -p "$KEYCHAIN_DIR"

# A dedicated keychain with its own generated password keeps `codesign`
# non-interactive without touching the login keychain.
if [ ! -f "$PASS_FILE" ]; then
  password="$(openssl rand -hex 24)"
  printf '%s' "$password" > "$PASS_FILE"
  chmod 600 "$PASS_FILE"
fi
password="$(cat "$PASS_FILE")"

if [ ! -f "$KEYCHAIN_PATH" ]; then
  security create-keychain -p "$password" "$KEYCHAIN_PATH"
  security set-keychain-settings -t 0 "$KEYCHAIN_PATH"
fi
security unlock-keychain -p "$password" "$KEYCHAIN_PATH"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A code-signing self-signed root with a 10-year validity: the signing
# identity never lapses inside the app's supported lifetime.
openssl req -newkey rsa:3072 -nodes -keyout "$work/key.pem" \
  -x509 -days 3650 -out "$work/cert.pem" \
  -subj "/CN=${CERT_CN}" \
  -addext "keyUsage=digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  >/dev/null 2>&1

# macOS `security import` predates PBES2/AES p12: export with the SHA1/3DES
# algorithms it can read.
openssl pkcs12 -export -out "$work/identity.p12" \
  -inkey "$work/key.pem" -in "$work/cert.pem" \
  -password pass:colaw -name "$CERT_CN" \
  -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES >/dev/null 2>&1

security import "$work/identity.p12" -k "$KEYCHAIN_PATH" -P colaw -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -k "$password" "$KEYCHAIN_PATH" >/dev/null 2>&1
security add-certificates -k "$KEYCHAIN_PATH" "$work/cert.pem" >/dev/null 2>&1 || true

echo "create-colaw-signing-cert: created identity ${CERT_CN}"
security find-identity -v -p codesign 2>/dev/null | grep "${CERT_CN}"
