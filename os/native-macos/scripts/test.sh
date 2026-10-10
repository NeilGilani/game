#!/usr/bin/env bash
# Build agency-native and the test app, then run the swift-testing suites.
#   scripts/test.sh                              unit tests + protocol tests against the real binary
#   AGENCY_NATIVE_INTEGRATION=1 scripts/test.sh  also drive AgencyTestApp through the accessibility API
#                                                (needs Accessibility permission for the terminal or CI agent,
#                                                and briefly brings a test window to the front)
set -euo pipefail
cd "$(dirname "$0")/.."

# With Command Line Tools only (no Xcode), SwiftPM sometimes forgets the swift-testing macro plugin on
# incremental builds ("plugin for module 'TestingMacros' not found"). Pointing at it explicitly fixes that.
extra=()
plugins="$(cd "$(dirname "$(xcrun --find swift)")/.." && pwd)/lib/swift/host/plugins/testing"
if [[ -d "$plugins" ]]; then extra=(-Xswiftc -plugin-path -Xswiftc "$plugins"); fi

swift build "${extra[@]}"
swift test "${extra[@]}"
