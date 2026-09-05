#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_SHA:?RELEASE_SHA is required}"
: "${ACR_INSTANCE_ID:?ACR_INSTANCE_ID is required}"
: "${ACR_REPO_ID:?ACR_REPO_ID is required}"
: "${ACR_REGISTRY:?ACR_REGISTRY is required}"
: "${ACR_REPOSITORY:?ACR_REPOSITORY is required}"
: "${OUTPUT_FILE:?OUTPUT_FILE is required}"
ACR_REGION_ID="${ACR_REGION_ID:-cn-shenzhen}"
ACR_AK="${ACR_AK:-${ALIBABACLOUD_ACCESS_KEY_ID:-}}"
ACR_SK="${ACR_SK:-${ALIBABACLOUD_ACCESS_KEY_SECRET:-}}"
: "${ACR_AK:?ACR read access key id is required}"
: "${ACR_SK:?ACR read access key secret is required}"
export ACR_REGION_ID ACR_AK ACR_SK

printf '%s' "$RELEASE_SHA" | grep -Eq '^[a-f0-9]{40}$'
short_sha="${RELEASE_SHA:0:6}"
matches="$(git rev-list --all | grep -Ec "^${short_sha}" || true)"
test "$matches" = 1 || {
  echo 'The ACR six-character tag prefix is not unique in repository history' >&2
  exit 1
}

records="$RUNNER_TEMP/acr-build-records.json"
build="$RUNNER_TEMP/acr-build.json"
selected_build_record_id=''
attempt=0
while [ "$attempt" -lt 60 ]; do
  attempt=$((attempt + 1))
  bash scripts/release/list-acr-build-records.sh "$records"
  rm -f -- "$build"
  node - "$short_sha" "$records" "$build" <<'NODE'
const [shortSha, source, target] = process.argv.slice(2);
const body = JSON.parse(require('node:fs').readFileSync(source, 'utf8'));
const matches = body.BuildRecords.filter((entry) =>
  String(entry?.Image?.ImageTag ?? '').endsWith(`-${shortSha}`),
);
if (matches.length > 1) throw new Error('Multiple ACR records match the release SHA prefix');
if (matches.length === 1) require('node:fs').writeFileSync(target, JSON.stringify(matches[0]));
NODE
  if [ -s "$build" ]; then
    build_record_id="$(jq -r .BuildRecordId "$build")"
    test -n "$build_record_id" && test "$build_record_id" != null
    if [ -n "$selected_build_record_id" ] && [ "$build_record_id" != "$selected_build_record_id" ]; then
      echo 'The selected ACR build record changed while polling' >&2
      exit 1
    fi
    selected_build_record_id="${selected_build_record_id:-$build_record_id}"
    status="$(jq -r .BuildStatus "$build")"
    case "$status" in
      SUCCESS)
        logs="$RUNNER_TEMP/acr-build-record-$build_record_id-logs.json"
        aliyun cr ListRepoBuildRecordLog \
          --mode AK --access-key-id "$ACR_AK" --access-key-secret "$ACR_SK" \
          --region "$ACR_REGION_ID" --InstanceId "$ACR_INSTANCE_ID" \
          --BuildRecordId "$build_record_id" --Offset 0 > "$logs"
        node scripts/release/verify-acr-build-revision.mjs "$logs" "$RELEASE_SHA" main
        break
        ;;
      FAILED|CANCELED)
        echo "Exact ACR build failed: $status" >&2
        exit 1
        ;;
      PENDING|BUILDING) ;;
      *) echo "Unexpected ACR build status: $status" >&2; exit 1 ;;
    esac
  fi
  sleep 30
done
test -s "$build" || { echo 'Exact ACR build record did not appear' >&2; exit 1; }
test "$(jq -r .BuildStatus "$build")" = SUCCESS || {
  echo 'Exact ACR build did not become successful' >&2
  exit 1
}
tag="$(jq -r .Image.ImageTag "$build")"

aliyun cr GetRepoTag \
  --mode AK --access-key-id "$ACR_AK" --access-key-secret "$ACR_SK" \
  --region "$ACR_REGION_ID" --InstanceId "$ACR_INSTANCE_ID" \
  --RepoId "$ACR_REPO_ID" --Tag "$tag" > "$RUNNER_TEMP/acr-tag.json"
bash scripts/release/list-acr-build-records.sh "$RUNNER_TEMP/acr-build-records-confirmed.json"
node - "$tag" "$selected_build_record_id" "$RUNNER_TEMP/acr-build-records-confirmed.json" <<'NODE'
const [tag, expectedId, source] = process.argv.slice(2);
const body = JSON.parse(require('node:fs').readFileSync(source, 'utf8'));
const matches = body.BuildRecords.filter(
  (record) => String(record?.Image?.ImageTag ?? '') === tag,
);
if (
  matches.length !== 1 ||
  String(matches[0]?.BuildRecordId ?? '') !== expectedId ||
  matches[0]?.BuildStatus !== 'SUCCESS'
)
  throw new Error('ACR tag no longer has one successful selected BuildRecordId');
NODE
aliyun cr GetRepoTag \
  --mode AK --access-key-id "$ACR_AK" --access-key-secret "$ACR_SK" \
  --region "$ACR_REGION_ID" --InstanceId "$ACR_INSTANCE_ID" \
  --RepoId "$ACR_REPO_ID" --Tag "$tag" > "$RUNNER_TEMP/acr-tag-confirmed.json"
first_digest="$(jq -r .Digest "$RUNNER_TEMP/acr-tag.json")"
confirmed_digest="$(jq -r .Digest "$RUNNER_TEMP/acr-tag-confirmed.json")"
test "$(jq -r .Status "$RUNNER_TEMP/acr-tag.json")" = NORMAL
test "$(jq -r .Status "$RUNNER_TEMP/acr-tag-confirmed.json")" = NORMAL
test "${first_digest#sha256:}" = "${confirmed_digest#sha256:}"
printf '%s' "${first_digest#sha256:}" | grep -Eq '^[a-f0-9]{64}$'

node scripts/release/resolve-acr-image.mjs \
  "$RELEASE_SHA" "$build" "$RUNNER_TEMP/acr-tag.json" \
  "$ACR_REGISTRY" "$ACR_REPOSITORY" > "$OUTPUT_FILE"
