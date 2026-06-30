#!/opt/homebrew/bin/bash
# WireGuard wrapper for launchd
# - 启动 wg0 接口
# - 前台运行，每 60s 检查接口存活
# - 接口断了自动重建
#
# sudoers 规则：/etc/sudoers.d/wireguard
#   admin ALL=(root) NOPASSWD: /opt/homebrew/bin/wg-quick, /opt/homebrew/bin/wg

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/sbin:/sbin:/usr/bin:/bin"

# 清除代理环境变量
export NO_PROXY="*"
export ALL_PROXY=""
export all_proxy=""
export HTTP_PROXY=""
export http_proxy=""
export HTTPS_PROXY=""
export https_proxy=""

WG_INTERFACE="wg0"
LOG="/Users/admin/.config/wireguard/wireguard.log"

mkdir -p /Users/admin/.config/wireguard

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"
}

# 启动 WireGuard 接口
start_wg() {
    sudo wg-quick up "$WG_INTERFACE" >> "$LOG" 2>&1
    if [ $? -eq 0 ]; then
        log "WireGuard interface $WG_INTERFACE started"
    else
        log "ERROR: Failed to start $WG_INTERFACE"
    fi
}

# 停止 WireGuard 接口
stop_wg() {
    sudo wg-quick down "$WG_INTERFACE" >> "$LOG" 2>&1
}

# 检查接口是否存活
check_wg() {
    sudo wg show "$WG_INTERFACE" > /dev/null 2>&1
    return $?
}

# 清理旧接口（如果存在）
stop_wg 2>/dev/null

# 启动
log "=== WireGuard wrapper starting ==="
start_wg

# 前台循环：每 60s 检查接口
while true; do
    sleep 60
    if ! check_wg; then
        log "WARNING: WireGuard interface down, restarting..."
        stop_wg 2>/dev/null
        sleep 2
        start_wg
    fi
done
