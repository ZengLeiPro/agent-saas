#!/usr/bin/env bash
# Publish hashed Web assets from a Shenzhen ECS host via OSS internal endpoint.
# Runner only supplies the already-hydrated archive + short-lived credentials file;
# no US→China bulk object stream. Public origin header checks stay identical.
set -euo pipefail

archive="${1:?web-assets archive is required}"
expected_digest="${2:?web-assets sha256 digest is required}"
extract_root="${3:?extract root is required}"
target_base="${4:?target OSS prefix is required}"
credentials_path="${5:?OSS SDK credentials file is required}"
oss_module_path="${6:?ali-oss module path is required}"
public_origin="${7:?public Web origin is required}"
concurrency="${8:-8}"
request_timeout="${9:-60}"
diagnostics="${10:-}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$expected_digest" | grep -Eq '^[a-f0-9]{64}$'
test -f "$archive"
test -s "$credentials_path"
test -d "$oss_module_path"
case "$target_base" in oss://*/*) ;; *) echo 'target must be an OSS prefix' >&2; exit 1 ;; esac
: "${OSS_REGION:?OSS_REGION is required}"

actual="$(sha256sum -- "$archive" | cut -d' ' -f1)"
if [ "$actual" != "$expected_digest" ]; then
  echo "web-assets digest mismatch: expected=$expected_digest actual=$actual" >&2
  exit 1
fi

rm -rf -- "$extract_root"
install -d -m 0700 "$extract_root"
tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$extract_root"
test -d "$extract_root/assets"
test -s "$extract_root/index.html"

export OSS_INTERNAL=1
bash "$script_dir/upload-web-assets-immutable.sh" \
  "$extract_root/assets" "$target_base" "$credentials_path" "$oss_module_path" \
  "$public_origin" "$concurrency" "$request_timeout" "$diagnostics" internal
