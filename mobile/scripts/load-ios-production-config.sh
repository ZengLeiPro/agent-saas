#!/usr/bin/env bash
set -euo pipefail

MOBILE_CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_value() {
  node -e 'const value=process.argv[2].split(".").reduce((item,key)=>item?.[key],require(process.argv[1]));if(typeof value!=="string"||!value||/[\r\n]/u.test(value))process.exit(2);process.stdout.write(value);' "$1" "$2"
}

export EXPO_PUBLIC_V1_PROFILE=production
export EXPO_PUBLIC_MOBILE_API_ORIGIN="$(config_value "$MOBILE_CONFIG_DIR/eas.json" build.production.env.EXPO_PUBLIC_MOBILE_API_ORIGIN)"
export EXPO_PUBLIC_MOBILE_API_ALLOWLIST="$(config_value "$MOBILE_CONFIG_DIR/eas.json" build.production.env.EXPO_PUBLIC_MOBILE_API_ALLOWLIST)"
export EXPO_PUBLIC_MOBILE_WS_ALLOWLIST="$(config_value "$MOBILE_CONFIG_DIR/eas.json" build.production.env.EXPO_PUBLIC_MOBILE_WS_ALLOWLIST)"
export MOBILE_IOS_APPLE_TEAM_ID="$(config_value "$MOBILE_CONFIG_DIR/release-manifest.json" identity.iosAppleTeamId)"
export MOBILE_IOS_SHARE_APP_GROUP="$(config_value "$MOBILE_CONFIG_DIR/release-manifest.json" identity.iosAppGroupIdentifier)"
