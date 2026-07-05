#!/bin/bash
# ============================================================================
# ensure-cli.sh — 按需从 ky-azeroth 生产 server 拉取 CLI bundle
# ============================================================================
#
# 设计目的：让 azeroth CLI 永远跟 ky-azeroth server 同版本，无需任何手工
# 同步动作。流程：
#   1. 检查本地 cache 是否存在 + stamp 是否过期（默认 1h TTL）
#   2. 过期/不存在 → 调 GET /cli-bundle/hash 比对
#   3. hash 一致 → touch stamp 跳过下载（轻量探活）
#   4. hash 变了或 cache 空 → 下载完整 bundle，原子覆盖
#   5. cache 路径在 PATH 里（dispatch.ts 注入），LLM 直接 azeroth ... 即可
#
# 调用：从 SKILL.md 引导 LLM 在使用 ky-data-query 之前先 source 一次。
# 幂等可重跑。
#
# 必需 env（dispatch.ts 已注入）:
#   AZEROTH_TOKEN  — 当前用户的 PAT
#   AZEROTH_API_URL — https://fc.kaiyan.net/ky-azeroth
# 可选 env:
#   AZEROTH_CLI_TTL_SECS — cache TTL，默认 3600
#   AZEROTH_CLI_FORCE    — 任何非空值 → 强制重新拉取（绕过 stamp）
# ============================================================================
set -euo pipefail

# 实际 user / USER env 在 ACS Sandbox 内不一定存在；用 cwd 推断更稳。
CACHE_DIR="${AZEROTH_CLI_CACHE_DIR:-$(pwd)/.cache/azeroth-cli}"
BIN_PATH="$CACHE_DIR/azeroth"
STAMP_PATH="$CACHE_DIR/.last-check"
TTL_SECS="${AZEROTH_CLI_TTL_SECS:-3600}"

mkdir -p "$CACHE_DIR"
case ":$PATH:" in
  *":$CACHE_DIR:"*) ;;
  *) export PATH="$CACHE_DIR:$PATH" ;;
esac

TMP_PATH=""
cleanup_tmp() {
  [[ -n "${TMP_PATH:-}" ]] && rm -f "$TMP_PATH"
}

# ── 前置检查 ──────────────────────────────────────────────────────
if [[ -z "${AZEROTH_TOKEN:-}" ]]; then
  echo "[ensure-cli] ERROR: 未注入 AZEROTH_TOKEN env，agent 平台 dispatch 应自动注入；" >&2
  echo "             如果你看到这条，说明当前用户未在 server/config/azeroth-tokens.json 配 PAT。" >&2
  echo "             联系 admin 补一个。" >&2
  trap - EXIT; cleanup_tmp 2>/dev/null || true; return 1 2>/dev/null || exit 1
fi
API="${AZEROTH_API_URL:-https://fc.kaiyan.net/ky-azeroth}"

# ── 检查是否需要刷新 ──────────────────────────────────────────────
NEED_CHECK=0
if [[ ! -x "$BIN_PATH" ]]; then
  # 首次：必须下载
  NEED_CHECK=1
elif [[ -n "${AZEROTH_CLI_FORCE:-}" ]]; then
  NEED_CHECK=1
elif [[ ! -f "$STAMP_PATH" ]]; then
  NEED_CHECK=1
else
  # mtime 比 TTL 旧 → 刷新
  if [[ "$(uname)" == "Darwin" ]]; then
    STAMP_AGE=$(( $(date +%s) - $(stat -f %m "$STAMP_PATH") ))
  else
    STAMP_AGE=$(( $(date +%s) - $(stat -c %Y "$STAMP_PATH") ))
  fi
  if (( STAMP_AGE > TTL_SECS )); then
    NEED_CHECK=1
  fi
fi

if (( NEED_CHECK == 0 )); then
  # cache 命中且未过期，0 网络请求
  trap - EXIT; cleanup_tmp 2>/dev/null || true; return 0 2>/dev/null || exit 0
fi

# ── hash 探活 ──────────────────────────────────────────────────────
REMOTE_HASH=$(curl -sS --max-time 10 \
  -H "Authorization: Bearer $AZEROTH_TOKEN" \
  "$API/api/v1/cli-bundle/hash" \
  | sed -E 's/.*"sha256":[[:space:]]*"([a-f0-9]+)".*/\1/' || true)

if [[ -z "$REMOTE_HASH" ]] || [[ ${#REMOTE_HASH} -ne 64 ]]; then
  if [[ -x "$BIN_PATH" ]]; then
    echo "[ensure-cli] WARN: 拉取 hash 失败，使用本地 cache 旧版（可能已过期）" >&2
    trap - EXIT; cleanup_tmp 2>/dev/null || true; return 0 2>/dev/null || exit 0
  fi
  echo "[ensure-cli] ERROR: 拉取 hash 失败且无本地 cache。检查网络/PAT 有效性。" >&2
  echo "             API: $API/api/v1/cli-bundle/hash" >&2
  trap - EXIT; cleanup_tmp 2>/dev/null || true; return 1 2>/dev/null || exit 1
fi

LOCAL_HASH=""
if [[ -x "$BIN_PATH" ]]; then
  if command -v sha256sum >/dev/null; then
    LOCAL_HASH=$(sha256sum "$BIN_PATH" | cut -d' ' -f1)
  else
    LOCAL_HASH=$(shasum -a 256 "$BIN_PATH" | cut -d' ' -f1)
  fi
fi

if [[ "$REMOTE_HASH" == "$LOCAL_HASH" ]]; then
  # 服务端版本未变，刷新 stamp 跳过下载
  touch "$STAMP_PATH"
  trap - EXIT; cleanup_tmp 2>/dev/null || true; return 0 2>/dev/null || exit 0
fi

# ── 下载新版 bundle ────────────────────────────────────────────────
TMP_PATH="$BIN_PATH.tmp.$$"
trap cleanup_tmp EXIT

if ! curl -sS --max-time 60 \
  -H "Authorization: Bearer $AZEROTH_TOKEN" \
  -o "$TMP_PATH" \
  "$API/api/v1/cli-bundle"; then
  if [[ -x "$BIN_PATH" ]]; then
    echo "[ensure-cli] WARN: 下载 bundle 失败，沿用本地 cache 旧版" >&2
    trap - EXIT; cleanup_tmp 2>/dev/null || true; return 0 2>/dev/null || exit 0
  fi
  echo "[ensure-cli] ERROR: 下载 bundle 失败且无本地 cache。" >&2
  trap - EXIT; cleanup_tmp 2>/dev/null || true; return 1 2>/dev/null || exit 1
fi

# 校验下载完整性
if command -v sha256sum >/dev/null; then
  DL_HASH=$(sha256sum "$TMP_PATH" | cut -d' ' -f1)
else
  DL_HASH=$(shasum -a 256 "$TMP_PATH" | cut -d' ' -f1)
fi
if [[ "$DL_HASH" != "$REMOTE_HASH" ]]; then
  echo "[ensure-cli] ERROR: 下载文件 hash 不匹配（remote=$REMOTE_HASH dl=$DL_HASH）" >&2
  trap - EXIT; cleanup_tmp 2>/dev/null || true; return 1 2>/dev/null || exit 1
fi

chmod +x "$TMP_PATH"
mv "$TMP_PATH" "$BIN_PATH"
trap - EXIT
touch "$STAMP_PATH"

echo "[ensure-cli] ✓ azeroth CLI 已更新到 ${REMOTE_HASH:0:12}..." >&2
