#!/bin/bash
# 自动导航到天元服务平台
# 用法: navigate-to-module.sh
#
# 只负责：激活钉钉 → 进入服务平台。
# 具体模块导航（订单管理/商机管理等）由 scraper.js 的 JS DOM 点击完成，
# 因为 peekaboo accessibility 对 WebView 内元素的坐标映射不准确，
# 侧边栏菜单项密集容易点偏，而 JS DOM 点击是精确的。

set -euo pipefail

log() { echo "$(date +%H:%M:%S) $1"; }

find_element() {
  local app="$1"
  local keyword="$2"
  peekaboo see --app "$app" --json 2>/dev/null | python3 -c "
import sys, json
keyword = '$keyword'
data = json.load(sys.stdin)
elements = data.get('data', {}).get('ui_elements', [])
for e in elements:
    label = e.get('label', '') or e.get('title', '') or ''
    if label == keyword:
        print(e['id']); exit()
for e in elements:
    label = e.get('label', '') or e.get('title', '') or ''
    if keyword in label and '×' not in label:
        print(e['id']); exit()
" 2>/dev/null
}

# ============ 步骤 1: 激活钉钉 ============
log "📱 激活钉钉..."
peekaboo dock launch "钉钉" > /dev/null 2>&1
sleep 1.5

# ============ 步骤 2: 进入服务平台 ============
log "🔍 查找「钉钉服务平台」入口..."
PLATFORM_ID=$(find_element "钉钉" "服务平台")

if [ -z "$PLATFORM_ID" ]; then
  log "❌ 找不到「钉钉服务平台」入口"
  exit 1
fi

log "📂 进入服务平台..."
peekaboo click --on "$PLATFORM_ID" --app "钉钉" > /dev/null 2>&1
sleep 3

log "✅ 已进入天元服务平台"
