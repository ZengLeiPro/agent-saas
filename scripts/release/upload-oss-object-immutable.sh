#!/usr/bin/env bash
set -euo pipefail

source_path="${1:?source path is required}"
target_uri="${2:?target OSS URI is required}"
region="${RELEASE_RECORD_OSS_REGION:?RELEASE_RECORD_OSS_REGION is required}"
test -f "$source_path"
case "$target_uri" in oss://*) ;; *) echo 'target must be an OSS URI' >&2; exit 1 ;; esac
case "$region" in cn-*) ;; *) echo 'invalid OSS region' >&2; exit 1 ;; esac

stat_error="$(mktemp)"
readback=''
cleanup() {
  rm -f "$stat_error"
  if [[ -n "$readback" ]]; then rm -f "$readback"; fi
}
trap cleanup EXIT

if aliyun --secure oss stat "$target_uri" --region "$region" >"$stat_error" 2>&1; then
  :
else
  stat_status=$?
  if grep -Eiq '(^|[^[:digit:]])404([^[:digit:]]|$)|NoSuchKey' "$stat_error"; then
    # ossutil v1 does not implement --forbid-overwrite. Never pass --force: an
    # object appearing after the stat must be refused by the locked WORM bucket
    # or by ossutil's overwrite prompt instead of being silently replaced.
    aliyun --secure oss cp "$source_path" "$target_uri" --region "$region"
  else
    cat "$stat_error" >&2
    exit "$stat_status"
  fi
fi

readback="$(mktemp)"
# ossutil v1 treats an existing destination as an overwrite prompt, while
# mktemp creates the file. Remove only that exact empty placeholder first.
unlink "$readback"
aliyun --secure oss cp "$target_uri" "$readback" --region "$region"
cmp "$source_path" "$readback"
