#!/usr/bin/env bash
# Build a universal (arm64 + x86_64) release agency-native and print its path.
#   scripts/build-universal.sh [out-dir]     default out-dir: dist/
# Multi-arch SwiftPM builds need full Xcode (xcbuild); with Command Line Tools only, this builds each
# architecture separately and joins them with lipo.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-dist}"
mkdir -p "$out"

if swift build -c release --arch arm64 --arch x86_64 --product agency-native >/dev/null 2>&1; then
  bin="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)/agency-native"
  cp "$bin" "$out/agency-native"
else
  echo "Multi-arch build unavailable here; building each architecture and joining with lipo." >&2
  parts=()
  for arch in arm64 x86_64; do
    swift build -c release --triple "$arch-apple-macosx13.0" --product agency-native --scratch-path ".build/$arch"
    parts+=("$(swift build -c release --triple "$arch-apple-macosx13.0" --scratch-path ".build/$arch" --show-bin-path)/agency-native")
  done
  lipo -create "${parts[@]}" -output "$out/agency-native"
fi

lipo -info "$out/agency-native" >&2
echo "$(cd "$out" && pwd)/agency-native"
