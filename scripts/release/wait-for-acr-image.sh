#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_SHA:?RELEASE_SHA is required}"
: "${ACR_INSTANCE_ID:?ACR_INSTANCE_ID is required}"
: "${ACR_REPO_ID:?ACR_REPO_ID is required}"
: "${ACR_REGISTRY:?ACR_REGISTRY is required}"
: "${ACR_REPOSITORY:?ACR_REPOSITORY is required}"
: "${OUTPUT_FILE:?OUTPUT_FILE is required}"

printf '%s' "$RELEASE_SHA" | grep -Eq '^[a-f0-9]{40}$'
short_sha="${RELEASE_SHA:0:6}"
matches="$(git rev-list --all | grep -Ec "^${short_sha}" || true)"
test "$matches" = 1 || {
  echo "The ACR six-character tag prefix is not unique in repository history" >&2
  exit 1
}

attempt=0
while [ "$attempt" -lt 60 ]; do
  attempt=$((attempt + 1))
  aliyun cr ListRepoBuildRecord \
    --region "${ACR_REGION_ID:-cn-shenzhen}" \
    --InstanceId "$ACR_INSTANCE_ID" --RepoId "$ACR_REPO_ID" \
    --PageNo 1 --PageSize 100 >"$RUNNER_TEMP/acr-build-records.json"
  node - "$short_sha" "$RUNNER_TEMP/acr-build-records.json" "$RUNNER_TEMP/acr-build.json" <<'NODE'
const [shortSha, source, target] = process.argv.slice(2);
const body = JSON.parse(require('node:fs').readFileSync(source, 'utf8'));
const matches = (body.BuildRecords ?? []).filter((entry) =>
  String(entry?.Image?.ImageTag ?? '').endsWith(`-${shortSha}`),
);
if (matches.length > 1) throw new Error('Multiple ACR records match the release SHA prefix');
if (matches.length === 1) require('node:fs').writeFileSync(target, JSON.stringify(matches[0]));
NODE
  if [ -s "$RUNNER_TEMP/acr-build.json" ]; then
    status="$(node -p "require('$RUNNER_TEMP/acr-build.json').BuildStatus")"
    case "$status" in
      SUCCESS) break ;;
      FAILED|CANCELED) echo "Exact ACR build failed: $status" >&2; exit 1 ;;
    esac
  fi
  sleep 30
done
test -s "$RUNNER_TEMP/acr-build.json" || { echo "Exact ACR build record did not appear" >&2; exit 1; }
tag="$(node -p "require('$RUNNER_TEMP/acr-build.json').Image.ImageTag")"
aliyun cr GetRepoTag \
  --region "${ACR_REGION_ID:-cn-shenzhen}" \
  --InstanceId "$ACR_INSTANCE_ID" --RepoId "$ACR_REPO_ID" --Tag "$tag" \
  >"$RUNNER_TEMP/acr-tag.json"
node scripts/release/resolve-acr-image.mjs \
  "$RELEASE_SHA" "$RUNNER_TEMP/acr-build.json" "$RUNNER_TEMP/acr-tag.json" \
  "$ACR_REGISTRY" "$ACR_REPOSITORY" >"$OUTPUT_FILE"
