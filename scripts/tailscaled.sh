#!/bin/bash
# Tailscale daemon wrapper for launchd
# - 确保状态/socket 目录存在
# - 清除代理环境变量（避免 Go 程序被系统代理劫持）
# - 以 TUN 模式运行（创建 utun 设备 + 系统路由，需要 sudo）
#
# sudoers 规则：/etc/sudoers.d/tailscaled
#   admin ALL=(root) NOPASSWD: /opt/homebrew/opt/tailscale/bin/tailscaled

STATE_DIR="$HOME/.config/tailscale"
SOCKET_DIR="/tmp/tailscale"

mkdir -p "$STATE_DIR"
mkdir -p "$SOCKET_DIR"

# 清除代理（同 frpc.sh 的逻辑）
export NO_PROXY="*"
export ALL_PROXY=""
export all_proxy=""
export HTTP_PROXY=""
export http_proxy=""
export HTTPS_PROXY=""
export https_proxy=""

exec sudo /opt/homebrew/opt/tailscale/bin/tailscaled \
  --state="$STATE_DIR/tailscaled.state" \
  --socket="$SOCKET_DIR/tailscaled.sock" \
  --port=41641
