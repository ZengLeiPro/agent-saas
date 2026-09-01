#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
asset_root="${1:?asset root is required}"
target_base="${2:?target OSS prefix is required}"
credentials_path="${3:?OSS SDK credentials file is required}"
oss_module_path="${4:-}"
region="${OSS_REGION:?OSS_REGION is required}"
test -d "$asset_root"
test -s "$credentials_path"
asset_root="${asset_root%/}"
case "$target_base" in oss://*/*) ;; *) echo 'target must be an OSS prefix' >&2; exit 1 ;; esac
target_base="${target_base%/}"
bucket_and_prefix="${target_base#oss://}"
bucket="${bucket_and_prefix%%/*}"
public_origin="https://${bucket}.oss-${region}.aliyuncs.com"

uploaded=0
reused=0
javascript_assets=0
css_assets=0
while IFS= read -r -d '' source_path; do
  key="${source_path#"$asset_root"/}"
  printf '%s' "$key" | grep -Eq '^[A-Za-z0-9._/-]+$'
  target_uri="$target_base/$key"
  upload_path="$source_path"
  cache_control='public, max-age=31536000, immutable'
  expected_type="$(file --brief --mime-type "$source_path")"
  expected_encoding=''
  compressed=''
  case "$key" in
    *.js|*.mjs)
      javascript_assets=$((javascript_assets + 1))
      compressed="$(mktemp)"
      gzip -n -9 -c "$source_path" > "$compressed"
      upload_path="$compressed"
      expected_type='text/javascript; charset=utf-8'
      expected_encoding=gzip
      ;;
    *.css)
      css_assets=$((css_assets + 1))
      compressed="$(mktemp)"
      gzip -n -9 -c "$source_path" > "$compressed"
      upload_path="$compressed"
      expected_type='text/css; charset=utf-8'
      expected_encoding=gzip
      ;;
    *) ;;
  esac

  put_log="$(mktemp)"
  # ali-oss sends the real conditional request header; exit 17 means an exact 409 conflict.
  set +e
  node "$script_dir/put-web-asset-create-only.mjs" \
    "$upload_path" "$bucket" "${target_uri#"oss://$bucket/"}" "$region" \
    "$cache_control" "$expected_type" "$expected_encoding" \
    "$credentials_path" "$oss_module_path" > "$put_log" 2>&1
  put_status=$?
  set -e
  if [ "$put_status" -eq 0 ]; then
    uploaded=$((uploaded + 1))
  else
    if [ "$put_status" -ne 17 ] || \
      ! grep -Fxq 'OSS_CREATE_ONLY_CONFLICT FileAlreadyExists status=409' "$put_log"; then
      cat "$put_log" >&2
      rm -f "$put_log" "$compressed"
      exit 1
    fi
    stat_log="$(mktemp)"
    if ! ossutil stat "$target_uri" --region "$region" > "$stat_log" 2>&1; then
      cat "$put_log" >&2
      cat "$stat_log" >&2
      rm -f "$put_log" "$stat_log" "$compressed"
      exit 1
    fi
    rm -f "$stat_log"
    reused=$((reused + 1))
  fi
  rm -f "$put_log"

  readback="$(mktemp)"
  unlink "$readback"
  ossutil cp "$target_uri" "$readback" -f --region "$region"
  cmp "$upload_path" "$readback"
  # Verify the public object contract, not only the authenticated readback bytes.
  headers="$(mktemp)"
  curl -fsSI -H 'Accept-Encoding: gzip' \
    "$public_origin/${target_uri#"oss://$bucket/"}?immutable_probe=$$" > "$headers"
  tr -d '\r' < "$headers" | grep -Fxi "cache-control: $cache_control" >/dev/null
  tr -d '\r' < "$headers" | grep -Fxi "content-type: $expected_type" >/dev/null
  if [ "$expected_encoding" = gzip ]; then
    tr -d '\r' < "$headers" | grep -Fxi 'content-encoding: gzip' >/dev/null
  elif tr -d '\r' < "$headers" | grep -Eiq '^content-encoding:'; then
    echo "unexpected Content-Encoding for immutable asset: $key" >&2
    exit 1
  fi
  if tr -d '\r' < "$headers" \
    | grep -Eiq '^(content-disposition|content-language|expires|x-oss-meta-[^:]+):'; then
    echo "unexpected mutable metadata for immutable asset: $key" >&2
    exit 1
  fi
  rm -f "$readback" "$headers" "$compressed"
done < <(find "$asset_root" -type f -print0 | LC_ALL=C sort -z)

if [ "$javascript_assets" -eq 0 ] || [ "$css_assets" -eq 0 ]; then
  echo 'immutable Web asset set must contain JavaScript and CSS' >&2
  exit 1
fi
echo "immutable Web assets verified: uploaded=$uploaded reused=$reused js=$javascript_assets css=$css_assets"
