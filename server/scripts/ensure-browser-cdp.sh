#!/bin/bash
# ensure-browser-cdp.sh — 确保当前用户的 CDP Chrome 实例正在运行
#
# 调用方式：在 playwright-cli open 之前执行，幂等。
# 从 CWD 定位当前 workspace，查 browser-ports.json 获取端口，
# 检查 Chrome 是否已在该端口监听，没有则启动。
#
# admin 用户走 extension 模式，本脚本静默退出。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
PORTS_FILE="$SERVER_DIR/data/browser-ports.json"
WORKSPACE_ROOT="/Users/admin/workspace"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

USER_CWD="$PWD"
while [[ "$USER_CWD" == "$WORKSPACE_ROOT"* && "$USER_CWD" != "$WORKSPACE_ROOT" ]]; do
  if [[ -d "$USER_CWD/.ky-agent" ]]; then
    break
  fi
  USER_CWD="$(dirname "$USER_CWD")"
done

USER=""
if [[ -f "$USER_CWD/.ky-agent/workspace.json" ]]; then
  USER=$(python3 - "$USER_CWD/.ky-agent/workspace.json" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as f:
        print(json.load(f).get("username", ""))
except Exception:
    print("")
PY
)
fi

if [[ -z "$USER" ]]; then
  # 兼容旧扁平 workspace：/Users/admin/workspace/<username>/...
  USER=$(echo "$PWD" | sed -n "s|^$WORKSPACE_ROOT/\([^/]*\).*|\1|p")
  USER_CWD="$WORKSPACE_ROOT/$USER"
fi

if [[ -z "$USER" ]]; then
  echo "[ensure-browser-cdp] 无法从 CWD 定位用户 workspace，跳过" >&2
  exit 0
fi

# admin 走 extension 模式，不启动 CDP
if [[ "$USER" == "admin" ]]; then
  exit 0
fi

# 读端口映射
if [[ ! -f "$PORTS_FILE" ]]; then
  echo "[ensure-browser-cdp] 端口映射文件不存在: $PORTS_FILE" >&2
  exit 1
fi

PORT=$(python3 -c "import json,sys; d=json.load(open('$PORTS_FILE')); print(d['ports'].get('$USER',''))")

if [[ -z "$PORT" ]]; then
  echo "[ensure-browser-cdp] 用户 $USER 无端口映射，跳过" >&2
  exit 0
fi

PROFILE="$USER_CWD/.ky-agent/runtime/browser-profile"

# 检查 Chrome 是否已在该端口监听
if curl -s --connect-timeout 2 "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
  exit 0
fi

# 确保 profile 目录存在
mkdir -p "$PROFILE"

# 启动 Chrome（headless=new：完整 Chrome 功能，无窗口，省资源）
nohup "$CHROME" \
  --headless=new \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  >/dev/null 2>&1 &
disown

# 等待 Chrome 就绪（最多 10 秒）
for i in $(seq 1 20); do
  if curl -s --connect-timeout 1 "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
    echo "[ensure-browser-cdp] Chrome 已就绪: 用户=$USER 端口=$PORT"
    exit 0
  fi
  sleep 0.5
done

echo "[ensure-browser-cdp] Chrome 启动超时: 用户=$USER 端口=$PORT" >&2
exit 1
