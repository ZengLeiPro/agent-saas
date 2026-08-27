#!/usr/bin/env bash
set -euo pipefail

source_path="${1:?source path is required}"
target_uri="${2:?target OSS URI is required}"
test -f "$source_path"
case "$target_uri" in oss://*) ;; *) echo 'target must be an OSS URI' >&2; exit 1 ;; esac

if aliyun oss stat "$target_uri" >/dev/null 2>&1; then
  readback="$(mktemp)"
  trap 'rm -f "$readback"' EXIT
  aliyun oss cp "$target_uri" "$readback"
  cmp "$source_path" "$readback"
else
  aliyun oss cp "$source_path" "$target_uri" --forbid-overwrite
fi
