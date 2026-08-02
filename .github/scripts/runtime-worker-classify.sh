#!/usr/bin/env bash
# 判断一组变更是否需要滚动 Runtime Worker。纯 Web/文档/测试变更不切 worker；
# 生产 server/shared/技能源或运行依赖变化时保守切换。
set -euo pipefail

changed_files="${1:?usage: runtime-worker-classify.sh <changed_files_path>}"
required=false
reasons=()
skipped=()

while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    server/src/__tests__/*|server/src/*.test.ts|server/src/**/*.test.ts|server/scripts/*)
      skipped+=("$file")
      ;;
    server/src/*|server/package.json|shared/*|workspace-shared/*|patches/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|.npmrc|daemon-packaging/systemd/agent-saas-runtime-worker@.service.template|.github/scripts/runtime-worker-classify.sh)
      required=true
      reasons+=("$file")
      ;;
    *)
      skipped+=("$file")
      ;;
  esac
done < "$changed_files"

join_items() {
  if [ "$#" -eq 0 ]; then
    printf 'none'
    return
  fi
  local first=true item
  for item in "$@"; do
    if [ "$first" = true ]; then
      printf '%s' "$item"
      first=false
    else
      printf '; %s' "$item"
    fi
  done
}

if [ "${#reasons[@]}" -gt 0 ]; then
  reason="$(join_items "${reasons[@]}")"
else
  reason=none
fi
if [ "${#skipped[@]}" -gt 0 ]; then
  skipped_out="$(join_items "${skipped[@]}")"
else
  skipped_out=none
fi

echo "required=$required"
echo "reason=$reason"
echo "skipped=$skipped_out"
