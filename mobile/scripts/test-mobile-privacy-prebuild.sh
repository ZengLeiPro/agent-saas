#!/bin/bash
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_MANIFEST="$MOBILE_DIR/release-manifest.json"
ORIGINAL_MANIFEST="$(mktemp)"
cp "$RELEASE_MANIFEST" "$ORIGINAL_MANIFEST"

cleanup() {
  cp "$ORIGINAL_MANIFEST" "$RELEASE_MANIFEST"
  rm -f "$ORIGINAL_MANIFEST"
  rm -rf "$MOBILE_DIR/android" "$MOBILE_DIR/ios"
}
trap cleanup EXIT

restore_and_disarm_cleanup() {
  cp "$ORIGINAL_MANIFEST" "$RELEASE_MANIFEST"
  cmp "$ORIGINAL_MANIFEST" "$RELEASE_MANIFEST"
  rm -f "$ORIGINAL_MANIFEST"
  rm -rf "$MOBILE_DIR/android" "$MOBILE_DIR/ios"
  trap - EXIT
}

HEAD_SHA="$(git -C "$MOBILE_DIR" rev-parse --verify HEAD)"

write_test_only_manifest() {
  local distribution="$1"
  M10_05_TEST_DISTRIBUTION="$distribution" M10_05_TEST_GIT_SHA="$HEAD_SHA" \
    node - "$RELEASE_MANIFEST" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
manifest.version.androidVersionCode = 86;
manifest.version.latestPublished = {
  marketingVersion: '1.9.4-m10-05-static-fixture',
  iosBuildNumber: 84,
  androidVersionCode: 85,
};
manifest.oauthCallback.profiles.production = ['https://mobile.example.test/oauth/callback'];
manifest.target = {
  profile: 'production',
  distribution: process.env.M10_05_TEST_DISTRIBUTION,
  gitSha: process.env.M10_05_TEST_GIT_SHA,
};
manifest.verification = {
  identity: 'verified',
  versions: 'verified',
  distribution: 'verified',
};
fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

cd "$MOBILE_DIR"
echo "M10-05: using an ephemeral production manifest fixture for native static generation only; no external verification is claimed."

write_test_only_manifest store
EXPO_PUBLIC_V1_PROFILE=production \
MOBILE_BUILD_PLATFORM=android \
MOBILE_ANDROID_DISTRIBUTION=store \
pnpm exec expo prebuild --clean --no-install --platform android
node scripts/verify-mobile-privacy-prebuild.mjs \
  --platform android --profile production --distribution store --updater disabled
rm -rf "$MOBILE_DIR/android"

write_test_only_manifest enterprise
EXPO_PUBLIC_V1_PROFILE=production \
MOBILE_BUILD_PLATFORM=android \
MOBILE_ANDROID_DISTRIBUTION=enterprise \
MOBILE_ENTERPRISE_UPDATER_ENABLED=true \
MOBILE_ENTERPRISE_UPDATE_MANIFEST_URL=https://updates.example.test/android/enterprise/latest.json \
MOBILE_ENTERPRISE_UPDATE_PUBLIC_KEY=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo= \
MOBILE_ENTERPRISE_UPDATE_KEY_ID=m10-05-prebuild-test \
pnpm exec expo prebuild --clean --no-install --platform android
node scripts/verify-mobile-privacy-prebuild.mjs \
  --platform android --profile production --distribution enterprise --updater enabled
rm -rf "$MOBILE_DIR/android"

# iOS production does not consume the Android distribution, but the canonical
# manifest schema keeps a test-only value while the clean prebuild runs.
write_test_only_manifest store
EXPO_PUBLIC_V1_PROFILE=production \
MOBILE_BUILD_PLATFORM=ios \
pnpm exec expo prebuild --clean --no-install --platform ios
node scripts/verify-mobile-privacy-prebuild.mjs \
  --platform ios --profile production --updater disabled

restore_and_disarm_cleanup
echo "M10-05 production Store/Enterprise Android and production iOS clean prebuild checks passed; canonical release manifest restored."
