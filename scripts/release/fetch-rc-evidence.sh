#!/usr/bin/env bash
# Download immutable RC evidence. Prefer OSS records; fall back to GitHub Release
# for historical RCs that still have a tag/release.
set -euo pipefail
release_id="${1:?release id required}"
dest="${2:?destination directory required}"
printf '%s' "$release_id" | grep -Eq '^rc-[0-9]{8}-[0-9]{2,}$'
uri="${RELEASE_RECORD_OSS_URI:-${STAGING_RELEASE_OSS_URI:-}}"
region="${RELEASE_RECORD_OSS_REGION:-cn-shenzhen}"
: "${uri:?Missing RELEASE_RECORD_OSS_URI or STAGING_RELEASE_OSS_URI}"
case "$uri" in oss://*) ;; *) echo 'Release record URI must be OSS' >&2; exit 1 ;; esac
mkdir -p "$dest"
record_uri="$uri/records/$release_id"

# 用 cp 直接判定存在性并落盘，不再单独 `oss stat`：最小权限 RAM 用户对存在的
# 对象也可能因缺 HeadObject 权限让 stat 返回 AccessDenied（见
# upload-oss-object-immutable.sh 的同类说明），而 GetObject/cp 可靠。#677 起
# Staging 不再打 tag/建 Release，OSS 记录是唯一权威来源，这里不能被 stat 误判跳过。
if command -v aliyun >/dev/null \
  && aliyun --secure oss cp "$record_uri/manifest.json" "$dest/manifest.json" --region "$region" >/dev/null 2>&1; then
  aliyun --secure oss cp "$record_uri/artifact-index.json" "$dest/artifact-index.json" --region "$region"
  mkdir -p "$dest/attestations"
  aliyun --secure oss cp "$record_uri/attestations/" "$dest/attestations/" --recursive \
    --region "$region" >/dev/null 2>&1 || true
  shopt -s nullglob
  for file in "$dest/attestations"/*; do
    if [ -f "$file" ]; then
      cp "$file" "$dest/$(basename -- "$file")"
    fi
  done
  echo 'source=oss'
  exit 0
fi

if command -v gh >/dev/null && gh release view "$release_id" >/dev/null 2>&1; then
  gh release download "$release_id" --dir "$dest" \
    --pattern manifest.json --pattern artifact-index.json --pattern 'attestation-*.jsonl'
  echo 'source=github'
  exit 0
fi

echo "no OSS record or GitHub Release for $release_id" >&2
exit 2
