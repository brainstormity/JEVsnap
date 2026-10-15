#!/usr/bin/env bash
# Builds build/JEVsnap.app for THIS Mac's architecture (works with just the Command Line Tools).
#   VERSION=1.0.0 ./scripts/build-app.sh
#   ARCHS="arm64 x86_64" ./scripts/build-app.sh               # universal; requires full Xcode
#   SIGN_IDENTITY="Developer ID Application: …" ./scripts/build-app.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "JEVsnap's app target only builds on macOS." >&2
  exit 1
fi

VERSION="${VERSION:-0.2.0}"
ARCHS="${ARCHS:-$(uname -m)}"   # arm64 on Apple Silicon, x86_64 on Intel
ARCH_FLAGS=()
# Passing --arch switches SwiftPM to the Xcode build system (xcbuild), which needs full Xcode.
# Only do that for a universal build; a native build uses plain SwiftPM.
if [[ "$(wc -w <<<"$ARCHS")" -gt 1 ]]; then
  for a in $ARCHS; do ARCH_FLAGS+=(--arch "$a"); done
fi

swift build -c release ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"}
BIN="$(swift build -c release ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"} --show-bin-path)/JEVsnap"

APP="build/JEVsnap.app"
mkdir -p build
staging_dir="$(mktemp -d build/.jevsnap-staging.XXXXXX)"
trap 'rm -rf "$staging_dir"' EXIT
staged_app="$staging_dir/JEVsnap.app"
mkdir -p "$staged_app/Contents/MacOS" "$staged_app/Contents/Resources"
cp "$BIN" "$staged_app/Contents/MacOS/JEVsnap"
sed "s/__VERSION__/$VERSION/g" Resources/Info.plist > "$staged_app/Contents/Info.plist"
./scripts/sign-app.sh "$staged_app" "$APP"
# Replace the old bundle only after building, signing, and verification succeed.
rm -rf "$APP"
mv "$staged_app" "$APP"

echo "Built $APP"
echo "Run it with:  open $APP"
