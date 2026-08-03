#!/bin/bash
# dws PATH 前置薄 wrapper：对业务动作子命令注入 `--format json`（2026-08-03 方案 A，曾磊拍板）。
#
# 目标：保证连接器业务调用输出可被 toolPresentationBuilder 硬提取（receipt/失败摘要），
# 作为「模型不带 flag / CLI 默认值漂移」的护栏。不改官方 CLI 本体（红线）。
#
# 行为边界（白名单式，宁漏勿错）：
#   1. KY_DWS_WRAPPER_ENABLE != "1"        → 直通（默认 disable；灰度租户经 wire env 显式置 1）
#   2. 参数已含 --format / -f              → 直通（尊重模型显式选择）
#   3. 参数含 --help / -h / --version      → 直通（文档/诊断类）
#   4. 首个非 flag 子命令不在业务模块白名单 → 直通（auth 等诊断模块不注入）
#   5. 其余                               → 追加 --format json
#   6. wrapper 自身任何异常                → exec 真实 CLI 原参数（fail-open）
#
# 真实 CLI 查找：按 PATH 顺序取第一个非本 wrapper 目录的 dws（用户在 sandbox 内
# npm 自装升级版也会被正确透传）。找不到时报错语义与无 wrapper 时一致。

set -u

SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || SELF_DIR="/opt/ky-agent/wrappers"

find_real_dws() {
  local IFS=':'
  local dir
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    [ "$dir" = "$SELF_DIR" ] && continue
    if [ -x "$dir/dws" ]; then
      printf '%s' "$dir/dws"
      return 0
    fi
  done
  return 1
}

REAL_DWS="$(find_real_dws)" || {
  echo "dws: command not found (wrapper could not locate real CLI on PATH)" >&2
  exit 127
}

# 1. 软开关：默认 disable，wire env 显式置 "1" 才启用
if [ "${KY_DWS_WRAPPER_ENABLE:-}" != "1" ]; then
  exec "$REAL_DWS" "$@"
fi

# 2/3. 已带 format、help/version、`--` terminator → 直通（追加会被 -- 吞成位置参数）
first_sub=""
for arg in "$@"; do
  case "$arg" in
    --format|--format=*|-f|-f=*) exec "$REAL_DWS" "$@" ;;
    --help|-h|--version) exec "$REAL_DWS" "$@" ;;
    --) exec "$REAL_DWS" "$@" ;;
    -*) ;;
    *) [ -z "$first_sub" ] && first_sub="$arg" ;;
  esac
done

# 4. 业务模块白名单（与 server/src/agent/connectorDictionary.ts dws modules 同源；
#    刻意排除 auth——诊断模块不注入）。修改词典模块时同步这里。
case "$first_sub" in
  im|kb|doc|axls|chat|mail|todo|drive|sheet|table|report|aitable|contact|minutes|approval|calendar|attendance)
    exec "$REAL_DWS" "$@" --format json
    ;;
  *)
    exec "$REAL_DWS" "$@"
    ;;
esac
