#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Never log BASH_COMMAND or enable xtrace: commands can contain signing credentials.
BUILD_STAGE=validate-inputs
trap 'status=$?; printf "[iOS native build] stage=%s failed (exit=%s)\n" "$BUILD_STAGE" "$status" >&2; exit "$status"' ERR

MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_PATH="${1:?output IPA path required}"
SOURCE_SHA="${2:?source SHA required}"
BUILD_NUMBER="${3:?iOS build number required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${IOS_DISTRIBUTION_P12_BASE64:?IOS_DISTRIBUTION_P12_BASE64 is required}"
: "${IOS_DISTRIBUTION_P12_PASSWORD:?IOS_DISTRIBUTION_P12_PASSWORD is required}"
: "${IOS_APP_PROFILE_BASE64:?IOS_APP_PROFILE_BASE64 is required}"
: "${IOS_SHARE_PROFILE_BASE64:?IOS_SHARE_PROFILE_BASE64 is required}"

[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]*(\.[0-9]+){0,2}$ ]] || { echo '[iOS native build] invalid build number' >&2; exit 1; }

WORK_DIR="$RUNNER_TEMP/ios-native-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
KEYCHAIN_PATH="$WORK_DIR/release.keychain-db"
PROFILE_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$WORK_DIR" "$PROFILE_DIR"

decode_secret() {
  BUILD_STAGE="decode-$1"
  node - "$1" "$2" <<'NODE'
const fs = require('node:fs');
const name = process.argv[2];
const fail = (reason) => {
  console.error(`[iOS native build] ${name}: ${reason}; re-import this signing secret from the original credential file.`);
  process.exit(3);
};
const encoded = (process.env[name] || '').replace(/[ \t\r\n]/g, '');
if (!encoded) fail('missing or empty Base64 credential');
const data = Buffer.from(encoded, 'base64');
const canonical = data.toString('base64');
// Buffer.from is permissive: reject ignored garbage, incomplete bytes and a literal dash.
// Accept standard padded/unpadded Base64 and wrapped output, but not Base64URL.
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || !data.length ||
    canonical.replace(/=+$/, '') !== encoded.replace(/=+$/, '') ||
    (encoded.includes('=') && canonical !== encoded)) {
  fail('invalid Base64 credential');
}
try {
  fs.writeFileSync(process.argv[3], data, { mode: 0o600 });
} catch {
  fail('unable to write decoded credential');
}
NODE
}

P12_PATH="$WORK_DIR/distribution.p12"
APP_PROFILE="$WORK_DIR/app.mobileprovision"
SHARE_PROFILE="$WORK_DIR/share.mobileprovision"
decode_secret IOS_DISTRIBUTION_P12_BASE64 "$P12_PATH"
decode_secret IOS_APP_PROFILE_BASE64 "$APP_PROFILE"
decode_secret IOS_SHARE_PROFILE_BASE64 "$SHARE_PROFILE"

profile_value() {
  local profile="$1" key="$2" plist="$WORK_DIR/profile.plist"
  security cms -D -i "$profile" > "$plist"
  /usr/libexec/PlistBuddy -c "Print :$key" "$plist"
}

BUILD_STAGE=read-provisioning-profiles
APP_UUID="$(profile_value "$APP_PROFILE" UUID)"
APP_PROFILE_NAME="$(profile_value "$APP_PROFILE" Name)"
APP_IDENTIFIER="$(profile_value "$APP_PROFILE" Entitlements:application-identifier)"
APP_TEAM="$(profile_value "$APP_PROFILE" TeamIdentifier:0)"
SHARE_UUID="$(profile_value "$SHARE_PROFILE" UUID)"
SHARE_PROFILE_NAME="$(profile_value "$SHARE_PROFILE" Name)"
SHARE_IDENTIFIER="$(profile_value "$SHARE_PROFILE" Entitlements:application-identifier)"
SHARE_TEAM="$(profile_value "$SHARE_PROFILE" TeamIdentifier:0)"

BUILD_STAGE=verify-release-identity
IDENTITY="$(node "$MOBILE_DIR/scripts/verify-release-manifest.mjs" --profile production --platform ios --git-sha "$SOURCE_SHA" --print-artifact-identity)"
TEAM_ID="$(printf '%s' "$IDENTITY" | jq -er .identity.iosAppleTeamId)"
APP_BUNDLE_ID="$(printf '%s' "$IDENTITY" | jq -er .identity.iosBundleIdentifier)"
APP_GROUP="$(printf '%s' "$IDENTITY" | jq -er .identity.iosAppGroupIdentifier)"
SHARE_BUNDLE_ID="$APP_BUNDLE_ID.share-extension"
MARKETING_VERSION="$(printf '%s' "$IDENTITY" | jq -er .version.marketingVersion)"
. "$MOBILE_DIR/scripts/load-ios-production-config.sh"
[ "$MOBILE_IOS_APPLE_TEAM_ID" = "$TEAM_ID" ] && [ "$MOBILE_IOS_SHARE_APP_GROUP" = "$APP_GROUP" ] || { echo '[iOS native build] reviewed production identity drift' >&2; exit 1; }

[ "$APP_TEAM" = "$TEAM_ID" ] && [ "$SHARE_TEAM" = "$TEAM_ID" ] || { echo '[iOS native build] profile Team ID mismatch' >&2; exit 1; }
[ "$APP_IDENTIFIER" = "$TEAM_ID.$APP_BUNDLE_ID" ] || { echo '[iOS native build] main profile bundle mismatch' >&2; exit 1; }
[ "$SHARE_IDENTIFIER" = "$TEAM_ID.$SHARE_BUNDLE_ID" ] || { echo '[iOS native build] Share profile bundle mismatch' >&2; exit 1; }

BUILD_STAGE=create-signing-keychain
KEYCHAIN_PASSWORD="$(openssl rand -hex 32)"
cleanup() {
  security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  rm -f "$PROFILE_DIR/$APP_UUID.mobileprovision" "$PROFILE_DIR/$SHARE_UUID.mobileprovision"
}
trap cleanup EXIT
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 7200 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security list-keychains -d user -s "$KEYCHAIN_PATH"

BUILD_STAGE=import-distribution-certificate
CERT_PEM="$WORK_DIR/distribution-cert.pem"
KEY_PEM="$WORK_DIR/distribution-key.pem"
openssl pkcs12 -in "$P12_PATH" -clcerts -nokeys -passin env:IOS_DISTRIBUTION_P12_PASSWORD -out "$CERT_PEM"
openssl pkcs12 -in "$P12_PATH" -nocerts -nodes -passin env:IOS_DISTRIBUTION_P12_PASSWORD -out "$KEY_PEM"
security import "$CERT_PEM" -k "$KEYCHAIN_PATH" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security import "$KEY_PEM" -k "$KEYCHAIN_PATH" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" >/dev/null
cp "$APP_PROFILE" "$PROFILE_DIR/$APP_UUID.mobileprovision"
cp "$SHARE_PROFILE" "$PROFILE_DIR/$SHARE_UUID.mobileprovision"

cd "$MOBILE_DIR"
BUILD_STAGE=generate-native-project
pnpm exec expo prebuild --clean --no-install --platform ios
BUILD_STAGE=install-pods
pod install --project-directory=ios

shopt -s nullglob
PROJECTS=(ios/*.xcodeproj)
WORKSPACES=(ios/*.xcworkspace)
[ "${#PROJECTS[@]}" -eq 1 ] && [ "${#WORKSPACES[@]}" -eq 1 ] || { echo '[iOS native build] expected one Xcode project and workspace' >&2; exit 1; }
BUILD_STAGE=configure-signing
ruby scripts/configure-ios-signing.rb "${PROJECTS[0]}" "$TEAM_ID" "$MARKETING_VERSION" "$BUILD_NUMBER" \
  "$APP_BUNDLE_ID" "$APP_PROFILE_NAME" "$APP_UUID" \
  "$SHARE_BUNDLE_ID" "$SHARE_PROFILE_NAME" "$SHARE_UUID"

SCHEME="$(basename "${PROJECTS[0]}" .xcodeproj)"
ARCHIVE_PATH="$WORK_DIR/$SCHEME.xcarchive"
EXPORT_PATH="$WORK_DIR/export"
EXPORT_OPTIONS="$WORK_DIR/ExportOptions.plist"
plutil -create xml1 "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c 'Add :method string app-store-connect' "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c 'Add :destination string export' "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c 'Add :signingStyle string manual' "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :teamID string $TEAM_ID" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c 'Add :signingCertificate string Apple Distribution' "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c 'Add :manageAppVersionAndBuildNumber bool false' "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c 'Add :provisioningProfiles dict' "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :provisioningProfiles:$APP_BUNDLE_ID string $APP_PROFILE_NAME" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :provisioningProfiles:$SHARE_BUNDLE_ID string $SHARE_PROFILE_NAME" "$EXPORT_OPTIONS"

BUILD_STAGE=archive
xcodebuild -workspace "${WORKSPACES[0]}" -scheme "$SCHEME" -configuration Release -sdk iphoneos \
  -archivePath "$ARCHIVE_PATH" -destination 'generic/platform=iOS' \
  OTHER_CODE_SIGN_FLAGS="--keychain $KEYCHAIN_PATH" archive
BUILD_STAGE=export-ipa
xcodebuild -exportArchive -archivePath "$ARCHIVE_PATH" -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" OTHER_CODE_SIGN_FLAGS="--keychain $KEYCHAIN_PATH"

BUILD_STAGE=copy-ipa
IPAS=("$EXPORT_PATH"/*.ipa)
[ "${#IPAS[@]}" -eq 1 ] || { echo '[iOS native build] expected exactly one exported IPA' >&2; exit 1; }
[ ! -e "$OUTPUT_PATH" ] || { echo '[iOS native build] refusing to overwrite IPA' >&2; exit 1; }
cp "${IPAS[0]}" "$OUTPUT_PATH"
echo "iOS native archive exported version=$MARKETING_VERSION build=$BUILD_NUMBER team=$TEAM_ID appGroup=$APP_GROUP"
