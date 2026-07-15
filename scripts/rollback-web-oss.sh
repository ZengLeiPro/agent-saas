#!/usr/bin/env bash
set -euo pipefail

: "${TARGET_SHA:?Usage: TARGET_SHA=<successful release SHA> bash scripts/rollback-web-oss.sh}"
: "${OSS_ACCESS_KEY_ID:?Missing OSS_ACCESS_KEY_ID}"
: "${OSS_ACCESS_KEY_SECRET:?Missing OSS_ACCESS_KEY_SECRET}"

OSS_BUCKET="${OSS_BUCKET:-agent-saas-web}"
OSS_REGION="${OSS_REGION:-cn-shenzhen}"
SOURCE="oss://${OSS_BUCKET}/_releases/${TARGET_SHA}/current"

# 依赖先恢复，sw.js 最后切换，避免新旧入口短暂错位。
for f in manifest.webmanifest index.html sw.js; do
  ossutil cp "${SOURCE}/${f}" "oss://${OSS_BUCKET}/${f}" -f \
    --region "$OSS_REGION" --copy-props default
done

echo "Web OSS rolled back to ${TARGET_SHA}"
