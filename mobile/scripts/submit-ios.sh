#!/usr/bin/env bash
set -euo pipefail
umask 077

MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILDS_DIR="$MOBILE_DIR/builds"
if [ "${1:-}" = "--" ]; then shift; fi
IPA_PATH="${1:-}"

if [ -z "$IPA_PATH" ]; then
  echo "[M60-04] Usage: scripts/submit-ios.sh <verified-ipa>" >&2
  exit 2
fi

case "$IPA_PATH" in
  /*) ;;
  *) IPA_PATH="$PWD/$IPA_PATH" ;;
esac

if [ ! -f "$IPA_PATH" ] || [ -L "$IPA_PATH" ]; then
  echo "[M60-04] IPA must be a regular non-symlink file." >&2
  exit 1
fi
IPA_PATH="$(realpath "$IPA_PATH")"
BUILDS_DIR="$(realpath "$BUILDS_DIR")"
case "$IPA_PATH" in
  "$BUILDS_DIR"/*.ipa) ;;
  *)
    echo "[M60-04] IPA must be an immutable artifact under mobile/builds/." >&2
    exit 1
    ;;
esac

SOURCE_PATH="$IPA_PATH.source.json"
VERIFICATION_PATH="$IPA_PATH.verification.json"
if [ ! -f "$SOURCE_PATH" ] || [ ! -f "$VERIFICATION_PATH" ]; then
  echo "[M60-04] Source and verification sidecars from the build step are required." >&2
  exit 1
fi

SOURCE_GIT_SHA="$(jq -er .sourceGitSha "$SOURCE_PATH")"
CURRENT_GIT_SHA="$(git -C "$MOBILE_DIR" rev-parse --verify HEAD)"
if [ "$CURRENT_GIT_SHA" != "$SOURCE_GIT_SHA" ]; then
  echo "[M60-04] Current checkout does not match the IPA source commit." >&2
  exit 1
fi
if [ -n "$(git -C "$MOBILE_DIR" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "[M60-04] Submission requires a clean working tree." >&2
  exit 1
fi
if ! git -C "$MOBILE_DIR" merge-base --is-ancestor "$SOURCE_GIT_SHA" origin/main; then
  echo "[M60-04] IPA source commit is not contained in origin/main." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
EXPECTED_SOURCE="$WORK_DIR/source.json"
CURRENT_VERIFICATION="$WORK_DIR/verification.json"
SUBMIT_IPA="$WORK_DIR/$(basename "$IPA_PATH")"
ARTIFACT_IDENTITY="$(node "$MOBILE_DIR/scripts/verify-release-manifest.mjs" \
  --profile production \
  --platform ios \
  --git-sha "$CURRENT_GIT_SHA" \
  --print-artifact-identity)"
printf '%s\n' "$ARTIFACT_IDENTITY" | jq -S \
  '{profile:"ios-store",sourceGitSha:.sourceGitSha,appId:.identity.iosBundleIdentifier,iosTeamId:.identity.iosAppleTeamId,iosAppGroup:.identity.iosAppGroupIdentifier,version:.version.marketingVersion,buildNumber:.version.iosBuildNumber,versionCode:null}' \
  > "$EXPECTED_SOURCE"
if ! cmp -s "$EXPECTED_SOURCE" "$SOURCE_PATH"; then
  echo "[M60-04] IPA source sidecar does not match the reviewed manifest at current HEAD." >&2
  exit 1
fi
cp -p "$IPA_PATH" "$SUBMIT_IPA"
chmod 400 "$SUBMIT_IPA"
bash "$MOBILE_DIR/scripts/verify-mobile-release-artifact.sh" \
  ios-store "$SUBMIT_IPA" "$EXPECTED_SOURCE" "$CURRENT_VERIFICATION"
if ! cmp -s "$CURRENT_VERIFICATION" "$VERIFICATION_PATH"; then
  echo "[M60-04] IPA verification sidecar does not match the current artifact." >&2
  exit 1
fi

# Pin the verified inode, then remove its pathname before EAS starts. EAS reads
# /dev/fd/9 from the inherited descriptor, so unlink/recreate cannot swap the
# uploaded bytes after verification.
exec 9<"$SUBMIT_IPA"
unlink "$SUBMIT_IPA"

cd "$MOBILE_DIR"
SUBMIT_LOG="$IPA_PATH.submit.log"
SUBMIT_LOG_TMP="$WORK_DIR/submit.log"
if [ -e "$SUBMIT_LOG" ]; then
  echo "[M60-04] Refusing to overwrite an existing submit receipt log." >&2
  exit 1
fi
EAS_CLI_ENTRY="$(node -p 'require.resolve("eas-cli/bin/run")')"
set +e
node "$EAS_CLI_ENTRY" submit -p ios -e production --path /dev/fd/9 --non-interactive --wait \
  2>&1 | tee "$SUBMIT_LOG_TMP"
SUBMIT_STATUS="${PIPESTATUS[0]}"
set -e
exec 9<&-
if [ "$SUBMIT_STATUS" -ne 0 ]; then
  echo "[M60-04] EAS submission failed; no success receipt log was written." >&2
  exit "$SUBMIT_STATUS"
fi
mv "$SUBMIT_LOG_TMP" "$SUBMIT_LOG"
