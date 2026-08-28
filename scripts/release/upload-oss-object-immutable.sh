#!/usr/bin/env bash
set -euo pipefail

source_path="${1:?source path is required}"
target_uri="${2:?target OSS URI is required}"
test -f "$source_path"
case "$target_uri" in oss://*) ;; *) echo 'target must be an OSS URI' >&2; exit 1 ;; esac

if aliyun oss stat "$target_uri" >/dev/null 2>&1; then
  :
else
  # ossutil v1 does not implement --forbid-overwrite. Never pass --force: an
  # object appearing after the stat must be refused by the locked WORM bucket
  # or by ossutil's overwrite prompt instead of being silently replaced.
  aliyun oss cp "$source_path" "$target_uri"
fi
readback="$(mktemp)"
trap 'rm -f "$readback"' EXIT
# ossutil v1 treats an existing destination as an overwrite prompt, while
# mktemp creates the file. Remove only that exact empty placeholder first.
unlink "$readback"
aliyun oss cp "$target_uri" "$readback"
cmp "$source_path" "$readback"
