#!/usr/bin/env bash
# CI-friendly Android enterprise release APK via Expo prebuild + Gradle.
# Mirrors the EAS local production-enterprise APK path without requiring EXPO_TOKEN.
# Signing remains fail-closed through withAndroidSigningConfig (ANDROID_RELEASE_*).

set -euo pipefail
umask 077

# Never enable xtrace: commands can contain signing credentials.
BUILD_STAGE=validate-inputs
trap 'status=$?; printf "[Android native build] stage=%s failed (exit=%s)\n" "$BUILD_STAGE" "$status" >&2; exit "$status"' ERR

MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_PATH="${1:?output APK path required}"
DISTRIBUTION="${2:?android distribution required}"

case "$DISTRIBUTION" in
  enterprise) ;;
  store)
    echo "[Android native build] Gradle engine is enterprise-APK only; store/AAB remains on EAS local." >&2
    exit 2
    ;;
  *)
    echo "[Android native build] Unsupported distribution: $DISTRIBUTION" >&2
    exit 2
    ;;
esac

: "${ANDROID_RELEASE_KEYSTORE_PATH:?ANDROID_RELEASE_KEYSTORE_PATH is required}"
: "${ANDROID_RELEASE_STORE_PASSWORD:?ANDROID_RELEASE_STORE_PASSWORD is required}"
: "${ANDROID_RELEASE_KEY_ALIAS:?ANDROID_RELEASE_KEY_ALIAS is required}"
: "${ANDROID_RELEASE_KEY_PASSWORD:?ANDROID_RELEASE_KEY_PASSWORD is required}"

if [ ! -f "$ANDROID_RELEASE_KEYSTORE_PATH" ]; then
  echo "[Android native build] ANDROID_RELEASE_KEYSTORE_PATH does not point to a regular file" >&2
  exit 1
fi

if [ -e "$OUTPUT_PATH" ]; then
  echo "[Android native build] Refusing to overwrite existing artifact: $OUTPUT_PATH" >&2
  exit 1
fi

cd "$MOBILE_DIR"

# Export production API/WSS allowlists (parity with EAS profile + iOS loader).
# shellcheck source=load-android-production-config.sh
. "$MOBILE_DIR/scripts/load-android-production-config.sh"

export MOBILE_BUILD_PLATFORM=android
export MOBILE_ANDROID_DISTRIBUTION=enterprise
# Align Expo config resolution with the production-enterprise EAS profile name.
export EAS_BUILD_PROFILE="${EAS_BUILD_PROFILE:-production-enterprise}"

BUILD_STAGE=generate-native-project
pnpm exec expo prebuild --clean --no-install --platform android

ANDROID_ROOT="$MOBILE_DIR/android"
WRAPPER="$ANDROID_ROOT/gradlew"
if [ ! -x "$WRAPPER" ]; then
  echo "[Android native build] generated Android Gradle wrapper is missing after prebuild" >&2
  exit 1
fi

BUILD_STAGE=assemble-release-apk
(
  cd "$ANDROID_ROOT"
  ./gradlew :app:assembleRelease --no-daemon --console=plain
)

BUILD_STAGE=locate-release-apk
shopt -s nullglob
CANDIDATES=(
  "$ANDROID_ROOT/app/build/outputs/apk/release/app-release.apk"
  "$ANDROID_ROOT/app/build/outputs/apk/release/"*.apk
)
FOUND=""
for candidate in "${CANDIDATES[@]}"; do
  if [ -f "$candidate" ]; then
    FOUND="$candidate"
    break
  fi
done
if [ -z "$FOUND" ]; then
  echo "[Android native build] assembleRelease did not produce a release APK under app/build/outputs/apk/release/" >&2
  exit 1
fi

BUILD_STAGE=copy-artifact
mkdir -p "$(dirname "$OUTPUT_PATH")"
cp -f "$FOUND" "$OUTPUT_PATH"
chmod 0644 "$OUTPUT_PATH"

echo "Android enterprise Gradle build complete: $OUTPUT_PATH"
