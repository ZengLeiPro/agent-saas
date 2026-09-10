#!/usr/bin/env bash
set -euo pipefail

[ "$(uname -s)" = Darwin ] || { echo 'native iOS project check requires macOS' >&2; exit 1; }
MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_SHA="$(git -C "$MOBILE_DIR" rev-parse --verify HEAD)"
BASE_BUILD="$(node -p 'require(process.argv[1]).version.iosBuildNumber' "$MOBILE_DIR/release-manifest.json")"
: "${GITHUB_RUN_ID:=1}"
: "${GITHUB_RUN_ATTEMPT:=1}"
export MOBILE_RELEASE_PROFILE=production
export MOBILE_BUILD_PLATFORM=ios
export MOBILE_SOURCE_GIT_SHA="$SOURCE_SHA"
export MOBILE_IOS_BUILD_NUMBER="$BASE_BUILD.$GITHUB_RUN_ID.$GITHUB_RUN_ATTEMPT"
. "$MOBILE_DIR/scripts/load-ios-production-config.sh"

cd "$MOBILE_DIR"
pnpm exec expo prebuild --clean --no-install --platform ios
pod install --project-directory=ios
shopt -s nullglob
PROJECTS=(ios/*.xcodeproj)
[ "${#PROJECTS[@]}" -eq 1 ] || { echo 'expected one generated Xcode project' >&2; exit 1; }

TEAM_ID="$(node -p 'require(process.argv[1]).identity.iosAppleTeamId' release-manifest.json)"
APP_BUNDLE_ID="$(node -p 'require(process.argv[1]).identity.iosBundleIdentifier' release-manifest.json)"
APP_GROUP="$(node -p 'require(process.argv[1]).identity.iosAppGroupIdentifier' release-manifest.json)"
MARKETING_VERSION="$(node -p 'require(process.argv[1]).version.marketingVersion' release-manifest.json)"
ruby scripts/configure-ios-signing.rb "${PROJECTS[0]}" "$TEAM_ID" "$MARKETING_VERSION" "$MOBILE_IOS_BUILD_NUMBER" \
  "$APP_BUNDLE_ID" 'Contract Main Profile' '00000000-0000-0000-0000-000000000001' \
  "$APP_BUNDLE_ID.share-extension" 'Contract Share Profile' '00000000-0000-0000-0000-000000000002'

ruby -rxcodeproj -e '
  project = Xcodeproj::Project.open(ARGV.fetch(0))
  expected = ARGV.drop(1)
  targets = project.targets.select { |target| expected.include?(target.build_configurations.first.build_settings["PRODUCT_BUNDLE_IDENTIFIER"]) }
  abort "generated signing targets missing" unless targets.length == 2
  abort "manual signing not applied" unless targets.flat_map(&:build_configurations).all? { |config| config.build_settings["CODE_SIGN_STYLE"] == "Manual" }
' "${PROJECTS[0]}" "$APP_BUNDLE_ID" "$APP_BUNDLE_ID.share-extension"
echo "generated iOS project and both manual-signing targets verified (app-group=$APP_GROUP)"
