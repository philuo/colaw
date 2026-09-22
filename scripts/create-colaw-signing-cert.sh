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

# Register the keychain in the user's search list. `codesign --keychain <path>`
# is NOT enough on its own: for an identity in an unlisted keychain it reports
# "The specified item could not be found in the keychain", and `find-identity`
# reads the caller's search list as well. Appending is idempotent, and `-d user`
# keeps this to the account's own list. Runs on both the create and the
# already-present path, so a keychain that lost its listing is repaired.
ensure_keychain_listed() {
  local search=() entry registered=0
  while IFS= read -r entry; do
    search+=("$entry")
  done < <(security list-keychains -d user \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')
  for entry in ${search[@]+"${search[@]}"}; do
    if [ "$entry" = "$KEYCHAIN_PATH" ]; then registered=1; fi
  done
  if [ "$registered" -eq 0 ]; then
    security list-keychains -s ${search[@]+"${search[@]}"} "$KEYCHAIN_PATH"
  fi
}

# `-p codesigning` is the policy name security accepts; `-p codesign` is a
# usage error that prints help and matches nothing, which made the old check
# fall through and re-import the certificate on every run.
valid="$(security find-identity -v -p codesigning "${KEYCHAIN_PATH}" 2>/dev/null | grep "${CERT_CN}" || true)"
if [ -n "$valid" ]; then
  ensure_keychain_listed
  echo "create-colaw-signing-cert: identity already present:"
  echo "$valid"
  exit 0
fi

mkdir -p "$KEYCHAIN_DIR"

# Rebuild a keychain that holds an identity but no valid one: a run from
# before the trust step below existed leaves the certificate untrusted, and
# codesign refuses an untrusted identity.
if [ -f "$KEYCHAIN_PATH" ]; then
  echo "create-colaw-signing-cert: rebuilding ${KEYCHAIN_PATH} (no valid identity)"
  security delete-keychain "$KEYCHAIN_PATH" 2>/dev/null || rm -f "$KEYCHAIN_PATH"
fi

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
fi
security unlock-keychain -p "$password" "$KEYCHAIN_PATH"

# Deliberately no `set-keychain-settings -t 0`: it takes no password argument,
# so on a non-interactive shell `security` raises a GUI "enter the keychain
# password" panel and the script hangs there. The pack unlocks this keychain
# explicitly before every `codesign` call, which covers the auto-lock timer
# the setting would have disabled.

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

# Register the keychain in the user's search list. `codesign --keychain <path>`
# is NOT enough on its own: for an identity in an unlisted keychain it reports
# "The specified item could not be found in the keychain", and `find-identity`
# reads the caller's search list as well. Appending is idempotent, and
# `-d user` keeps this to the account's own list.
ensure_keychain_listed

# Trust the certificate for code signing in the user's trust settings. An
# untrusted identity cannot sign at all — codesign reports "The specified item
# could not be found in the keychain" — and only a signature that verifies
# produces the designated requirement TCC keys grants on. `-d` would install
# the anchor system-wide for every account; the user trust settings are enough
# for this machine's builds.
#
# No `-k`: the certificate is already in the keychain above, and naming the
# keychain here only makes `security` ask for that keychain's password in a GUI
# panel — which a non-interactive run cannot answer.
security add-trusted-cert -r trustRoot -p codeSign "$work/cert.pem"

echo "create-colaw-signing-cert: created identity ${CERT_CN}"
security find-identity -v -p codesigning "${KEYCHAIN_PATH}" | grep "${CERT_CN}"
