#!/bin/bash
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MOBILE_DIR"
cleanup() {
  rm -rf "$MOBILE_DIR/android"
}
trap cleanup EXIT

COMMON_ENV=(
  EXPO_PUBLIC_V1_PROFILE=preview
  MOBILE_BUILD_PLATFORM=android
)

cleanup
env "${COMMON_ENV[@]}" \
  MOBILE_ANDROID_DISTRIBUTION=store \
  pnpm exec expo prebuild --clean --no-install --platform android
env "${COMMON_ENV[@]}" \
  MOBILE_ANDROID_DISTRIBUTION=store \
  node scripts/verify-android-distribution-prebuild.mjs \
    --distribution store --updater disabled

cleanup
env "${COMMON_ENV[@]}" \
  MOBILE_ANDROID_DISTRIBUTION=enterprise \
  MOBILE_ENTERPRISE_UPDATER_ENABLED=true \
  MOBILE_ENTERPRISE_UPDATE_MANIFEST_URL=https://updates.example.test/android/enterprise/latest.json \
  MOBILE_ENTERPRISE_UPDATE_PUBLIC_KEY=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo= \
  MOBILE_ENTERPRISE_UPDATE_KEY_ID=m10-04-prebuild-test \
  pnpm exec expo prebuild --clean --no-install --platform android
env "${COMMON_ENV[@]}" \
  MOBILE_ANDROID_DISTRIBUTION=enterprise \
  MOBILE_ENTERPRISE_UPDATER_ENABLED=true \
  MOBILE_ENTERPRISE_UPDATE_MANIFEST_URL=https://updates.example.test/android/enterprise/latest.json \
  MOBILE_ENTERPRISE_UPDATE_PUBLIC_KEY=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo= \
  MOBILE_ENTERPRISE_UPDATE_KEY_ID=m10-04-prebuild-test \
  node scripts/verify-android-distribution-prebuild.mjs \
    --distribution enterprise --updater enabled
