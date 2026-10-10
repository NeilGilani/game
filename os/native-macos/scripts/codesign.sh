#!/usr/bin/env bash
# Codesigning hook for Instance 1's packaging. Signs agency-native with the hardened runtime and AGENCY's
# entitlements. Run it on the copy embedded in AGENCY.app (Contents/MacOS/agency-native or
# Contents/Resources/bin/agency-native) BEFORE signing the app bundle itself, with the same identity, so macOS
# attributes Accessibility, Screen Recording, camera and microphone permissions to AGENCY.
#
#   scripts/codesign.sh <path-to-agency-native> [identity]
#
# identity: a "Developer ID Application: ..." name or SHA-1 from the keychain; defaults to $AGENCY_SIGN_IDENTITY,
# then "-" (ad-hoc, for local builds; permissions then reset on every rebuild). No secrets live in this repo:
# CI imports the certificate from its own secret store before calling this.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
bin="${1:?usage: codesign.sh <path-to-agency-native> [identity]}"
identity="${2:-${AGENCY_SIGN_IDENTITY:--}}"
entitlements="$here/agency-native.entitlements"

flags=(--force --options runtime --entitlements "$entitlements" --identifier org.agency.native)
if [[ "$identity" != "-" ]]; then flags+=(--timestamp); fi

codesign "${flags[@]}" --sign "$identity" "$bin"
codesign --verify --strict --verbose=2 "$bin"
codesign --display --entitlements - "$bin" >/dev/null
echo "Signed $bin with identity '$identity'."
