#!/bin/bash
# M10-04 local release build wrapper.
# Android always requires an explicit Store or Enterprise distribution:
#   Store      -> production-store EAS profile -> AAB, never sideload publication
#   Enterprise -> production-enterprise profile -> APK, optional signed manifest preparation
# Android artifacts are never uploaded here. Publication remains a separately approved operation.

set -uo pipefail

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILDS_DIR="$MOBILE_DIR/builds"
EXIT_CODE=0
BUILD_ATTEMPTED=false
PLATFORM_IOS=false
PLATFORM_ANDROID=false
DO_CLEAN=false
PREPARE_ENTERPRISE_UPDATE=false
ANDROID_DISTRIBUTION=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    ios) PLATFORM_IOS=true ;;
    android) PLATFORM_ANDROID=true ;;
    --build) ;;
    --submit)
      echo "[M60-04] Build and submit are separate. Use scripts/submit-ios.sh with an already verified IPA." >&2
      exit 2
      ;;
    --clean) DO_CLEAN=true ;;
    --no-clean) DO_CLEAN=false ;;
    --prepare-enterprise-update) PREPARE_ENTERPRISE_UPDATE=true ;;
    --distribution)
      shift
      if [ "$#" -eq 0 ]; then
        echo "[M10-04] --distribution requires store or enterprise." >&2
        exit 2
      fi
      ANDROID_DISTRIBUTION="$1"
      ;;
    --distribution=*) ANDROID_DISTRIBUTION="${1#*=}" ;;
    *)
      echo "[M10-04] Unknown build argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if ! $PLATFORM_IOS && ! $PLATFORM_ANDROID; then
  PLATFORM_IOS=true
  PLATFORM_ANDROID=true
fi

if $PLATFORM_ANDROID; then
  case "$ANDROID_DISTRIBUTION" in
    store|enterprise) ;;
    "")
      echo "[M10-04] Android production build is blocked: explicitly pass --distribution store or --distribution enterprise." >&2
      exit 1
      ;;
    *)
      echo "[M10-04] Unsupported Android distribution: $ANDROID_DISTRIBUTION" >&2
      exit 2
      ;;
  esac
  BUILD_GATE_PLATFORM=android
elif [ -n "$ANDROID_DISTRIBUTION" ]; then
  echo "[M10-04] --distribution is valid only when Android is selected." >&2
  exit 2
else
  BUILD_GATE_PLATFORM=ios
fi

if $PREPARE_ENTERPRISE_UPDATE && { ! $PLATFORM_ANDROID || [ "$ANDROID_DISTRIBUTION" != enterprise ]; }; then
  echo "[M10-04] Signed sideload manifest preparation is Enterprise-only." >&2
  exit 2
fi

if ! SOURCE_GIT_SHA="$(git -C "$MOBILE_DIR" rev-parse --verify HEAD 2>/dev/null)"; then
  echo "[M10-03] Unable to read current Git SHA; production build refused." >&2
  exit 1
fi
if [ -n "$(git -C "$MOBILE_DIR" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "[M60-04] Production build requires a clean working tree." >&2
  exit 1
fi
if ! git -C "$MOBILE_DIR" merge-base --is-ancestor "$SOURCE_GIT_SHA" origin/main; then
  echo "[M60-04] Production build source must already be contained in origin/main." >&2
  exit 1
fi
export MOBILE_RELEASE_PROFILE=production
export MOBILE_SOURCE_GIT_SHA="$SOURCE_GIT_SHA"

VERIFY_ARGS=(
  --profile production
  --platform "$BUILD_GATE_PLATFORM"
  --git-sha "$SOURCE_GIT_SHA"
  --print-build-values
)
if $PLATFORM_ANDROID; then
  VERIFY_ARGS+=(--distribution "$ANDROID_DISTRIBUTION")
fi
if ! MANIFEST_VALUES="$(node "$MOBILE_DIR/scripts/verify-release-manifest.mjs" "${VERIFY_ARGS[@]}")"; then
  echo "[M10-03/M10-04] Release manifest did not satisfy production gates; build was not started." >&2
  exit 1
fi
IFS='|' read -r MANIFEST_VERSION ANDROID_VERSION_CODE <<<"$MANIFEST_VALUES"
if [ -z "$MANIFEST_VERSION" ] || { $PLATFORM_ANDROID && [ -z "$ANDROID_VERSION_CODE" ]; }; then
  echo "[M10-03] Verified release build values are incomplete." >&2
  exit 1
fi

IPA_PATH="$BUILDS_DIR/AgentSaaS-${MANIFEST_VERSION}.ipa"
STORE_AAB_PATH="$BUILDS_DIR/AgentSaaS-store-${ANDROID_VERSION_CODE}.aab"
ENTERPRISE_APK_PATH="$BUILDS_DIR/AgentSaaS-enterprise-${ANDROID_VERSION_CODE}.apk"

cleanup_build_cache() {
  echo ""
  echo "========================================"
  echo "  Cleaning local build caches..."
  echo "========================================"
  local freed=0

  if $PLATFORM_IOS; then
    if [ -d "$HOME/Library/Developer/Xcode/DerivedData" ]; then
      local size
      size=$(du -sm "$HOME/Library/Developer/Xcode/DerivedData" 2>/dev/null | cut -f1)
      rm -rf "$HOME/Library/Developer/Xcode/DerivedData"/*
      mkdir -p "$HOME/Library/Developer/Xcode/DerivedData"
      freed=$((freed + size))
      echo "  DerivedData: freed ${size}MB"
    fi
    if [ -d "$HOME/Library/Caches/CocoaPods" ]; then
      local size
      size=$(du -sm "$HOME/Library/Caches/CocoaPods" 2>/dev/null | cut -f1)
      rm -rf "$HOME/Library/Caches/CocoaPods"
      freed=$((freed + size))
      echo "  CocoaPods cache: freed ${size}MB"
    fi
  fi

  if $PLATFORM_ANDROID; then
    for gw in "$HOME"/.gradle/wrapper/dists/gradle-*/*/gradle-*/bin/gradle; do
      [ -x "$gw" ] && "$gw" --stop 2>/dev/null && break
    done 2>/dev/null
    if [ -d "$HOME/.gradle/caches" ]; then
      local size
      size=$(du -sm "$HOME/.gradle/caches" 2>/dev/null | cut -f1)
      rm -rf "$HOME/.gradle/caches"
      freed=$((freed + size))
      echo "  Gradle caches: freed ${size}MB"
    fi
  fi

  local eas_tmp
  for eas_tmp in /var/folders/*/*/eas-build-local-nodejs /tmp/eas-build-*; do
    if [ -d "$eas_tmp" ]; then
      local size
      size=$(du -sm "$eas_tmp" 2>/dev/null | cut -f1)
      rm -rf "$eas_tmp"
      freed=$((freed + size))
    fi
  done
  echo "  Total freed: ${freed}MB"
}

on_exit() {
  if $DO_CLEAN && $BUILD_ATTEMPTED; then cleanup_build_cache; fi
  exit "$EXIT_CODE"
}
trap on_exit EXIT

cd "$MOBILE_DIR"
mkdir -p "$BUILDS_DIR"
IOS_OK=false
ANDROID_OK=false
ANDROID_ARTIFACT_PATH=""

if $PLATFORM_IOS; then
  BUILD_ATTEMPTED=true
  if [ -e "$IPA_PATH" ]; then
    echo "[M10-04] Refusing to overwrite existing iOS build artifact: $IPA_PATH" >&2
    EXIT_CODE=1
  fi
  echo "Building iOS production IPA..."
  if [ "$EXIT_CODE" -eq 0 ] && MOBILE_BUILD_PLATFORM=ios MOBILE_ANDROID_DISTRIBUTION= EAS_SKIP_AUTO_FINGERPRINT=1 pnpm exec eas build -p ios -e production --local --output "$IPA_PATH" --non-interactive && [ -f "$IPA_PATH" ]; then
    IOS_SOURCE_PATH="$IPA_PATH.source.json"
    IOS_VERIFICATION_PATH="$IPA_PATH.verification.json"
    ARTIFACT_IDENTITY="$(node "$MOBILE_DIR/scripts/verify-release-manifest.mjs" --profile production --platform ios --git-sha "$SOURCE_GIT_SHA" --print-artifact-identity)"
    printf '%s\n' "$ARTIFACT_IDENTITY" | jq -S '{profile:"ios-store",sourceGitSha:.sourceGitSha,appId:.identity.iosBundleIdentifier,iosTeamId:.identity.iosAppleTeamId,iosAppGroup:.identity.iosAppGroupIdentifier,version:.version.marketingVersion,buildNumber:.version.iosBuildNumber,versionCode:null}' > "$IOS_SOURCE_PATH"
    if bash "$MOBILE_DIR/scripts/verify-mobile-release-artifact.sh" ios-store "$IPA_PATH" "$IOS_SOURCE_PATH" "$IOS_VERIFICATION_PATH"; then
      IOS_OK=true
      echo "iOS build and signature verification complete: $IPA_PATH"
    else
      EXIT_CODE=1
      echo "iOS artifact verification failed." >&2
    fi
  else
    EXIT_CODE=1
    echo "iOS build failed." >&2
  fi
fi

if $PLATFORM_ANDROID; then
  BUILD_ATTEMPTED=true
  if [ "$ANDROID_DISTRIBUTION" = store ]; then
    ANDROID_EAS_PROFILE=production-store
    ANDROID_ARTIFACT_PATH="$STORE_AAB_PATH"
  else
    ANDROID_EAS_PROFILE=production-enterprise
    ANDROID_ARTIFACT_PATH="$ENTERPRISE_APK_PATH"
  fi

  if [ -e "$ANDROID_ARTIFACT_PATH" ]; then
    echo "[M10-04] Refusing to overwrite existing Android versionCode ${ANDROID_VERSION_CODE} artifact: $ANDROID_ARTIFACT_PATH" >&2
    EXIT_CODE=1
  fi

  echo "Building Android ${ANDROID_DISTRIBUTION} artifact with ${ANDROID_EAS_PROFILE}..."
  if [ "$EXIT_CODE" -eq 0 ] && MOBILE_BUILD_PLATFORM=android MOBILE_ANDROID_DISTRIBUTION="$ANDROID_DISTRIBUTION" EAS_SKIP_AUTO_FINGERPRINT=1 pnpm exec eas build -p android -e "$ANDROID_EAS_PROFILE" --local --output "$ANDROID_ARTIFACT_PATH" --non-interactive && [ -f "$ANDROID_ARTIFACT_PATH" ]; then
    ANDROID_OK=true
    echo "Android ${ANDROID_DISTRIBUTION} build complete: $ANDROID_ARTIFACT_PATH"
  else
    EXIT_CODE=1
    echo "Android ${ANDROID_DISTRIBUTION} build failed." >&2
  fi
fi

if $PREPARE_ENTERPRISE_UPDATE && $ANDROID_OK; then
  if [ -z "${ENTERPRISE_UPDATE_ARTIFACT_BASE_URL:-}" ]; then
    echo "[M10-04] ENTERPRISE_UPDATE_ARTIFACT_BASE_URL is required for immutable manifest preparation." >&2
    EXIT_CODE=1
  else
    APK_SHA256="$(node -e 'const fs=require("node:fs"),c=require("node:crypto");const h=c.createHash("sha256");h.update(fs.readFileSync(process.argv[1]));process.stdout.write(h.digest("hex"));' "$ANDROID_ARTIFACT_PATH")"
    ARTIFACT_URL="${ENTERPRISE_UPDATE_ARTIFACT_BASE_URL%/}/${ANDROID_VERSION_CODE}/${SOURCE_GIT_SHA}/${APK_SHA256}.apk"
    UPDATE_MANIFEST_PATH="$BUILDS_DIR/AgentSaaS-enterprise-${ANDROID_VERSION_CODE}-${APK_SHA256}.manifest.json"
    if ! node "$MOBILE_DIR/scripts/prepare-enterprise-update.mjs" \
      --apk "$ANDROID_ARTIFACT_PATH" \
      --artifact-url "$ARTIFACT_URL" \
      --output "$UPDATE_MANIFEST_PATH" \
      --git-sha "$SOURCE_GIT_SHA"; then
      EXIT_CODE=1
    else
      echo "Signed immutable Enterprise manifest prepared: $UPDATE_MANIFEST_PATH"
      echo "No upload or overwrite was performed; publication requires separate human approval."
    fi
  fi
fi

if $PLATFORM_IOS && ! $IOS_OK; then EXIT_CODE=1; fi
if $PLATFORM_ANDROID && ! $ANDROID_OK; then EXIT_CODE=1; fi
exit "$EXIT_CODE"
