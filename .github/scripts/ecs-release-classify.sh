#!/usr/bin/env bash
# 判断生产 active ECS SHA 到目标 SHA 的累计变更是否需要滚动 Web/API 与 Runtime Worker。
# 只有明确属于 Web、Mobile、文档或测试的变更才跳过；未知路径一律保守部署。
set -euo pipefail

changed_files="${1:?usage: ecs-release-classify.sh <changed_files_path>}"
required=false
reasons=()
skipped=()

while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    server/src/__tests__/*|server/src/*.test.ts|server/src/**/*.test.ts)
      skipped+=("$file")
      ;;
    server/*|shared/*|workspace-shared/*)
      required=true
      reasons+=("$file")
      ;;
    web/*|mobile/*|docs/*|assets/*|*.md|scripts/deploy-recovery-web.sh|scripts/rollback-recovery-web.sh)
      skipped+=("$file")
      ;;
    *)
      required=true
      reasons+=("$file")
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
