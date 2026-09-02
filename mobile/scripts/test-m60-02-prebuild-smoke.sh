#!/bin/bash
set -euo pipefail
MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cleanup() { rm -rf "$MOBILE_DIR/android" "$MOBILE_DIR/ios"; }
trap cleanup EXIT
cd "$MOBILE_DIR"
EXPO_PUBLIC_V1_PROFILE=development pnpm exec expo prebuild --clean --no-install
for generated in android/app/src/main/AndroidManifest.xml ios/AgentSaaS/Info.plist; do
  test -s "$generated" || { echo "missing generated native file: $generated" >&2; exit 1; }
done
echo "M60-02 Android+iOS clean prebuild smoke passed; generated projects removed."
