#!/bin/bash
# 等待 scraper.js 执行完成，然后通过剪贴板提取数据
# 原理：在 Web Inspector 控制台中轮询 window.__SCRAPER_DONE__，
#       完成后执行 copy(JSON.stringify(window.__SCRAPER_RESULT__))
# 前置条件：Web Inspector 已打开并连接到目标 WebView

set -euo pipefail

MAX_WAIT=60  # 最多等待 60 次 × 5 秒 = 5 分钟
OUTPUT_FILE="${1:-/tmp/dingtalk-tianyuan-$(date +%Y%m%d%H%M%S).json}"

log() { echo "$(date +%H:%M:%S) $1"; }

# 聚焦 Web Inspector 窗口
focus_inspector() {
  # 查找 Web Inspector 窗口的 window-index
  local win_index
  win_index=$(peekaboo window list --app "Safari浏览器" --json 2>/dev/null | python3 -c "
import sys,json
data=json.load(sys.stdin)
for w in data.get('data',{}).get('windows',[]):
    if '网页检查器' in w.get('title','') or 'Web Inspector' in w.get('title',''):
        print(w.get('window_index','')); break
" 2>/dev/null)

  if [ -z "$win_index" ]; then
    log "❌ 找不到 Web Inspector 窗口"
    return 1
  fi

  peekaboo window focus --app "Safari浏览器" --window-index "$win_index" --space-switch > /dev/null 2>&1
  sleep 0.3
}

# 在 Web Inspector 控制台中执行 JS 代码
# 方法：写入剪贴板 → 粘贴 → 执行
run_in_console() {
  local js_code="$1"
  echo -n "$js_code" | pbcopy
  sleep 0.2
  # 清空当前输入
  peekaboo hotkey --keys "cmd,a" --app "Safari浏览器" > /dev/null 2>&1
  sleep 0.1
  # 粘贴
  peekaboo hotkey --keys "cmd,v" --app "Safari浏览器" > /dev/null 2>&1
  sleep 0.3
  # 执行
  peekaboo hotkey --keys "cmd,return" --app "Safari浏览器" > /dev/null 2>&1
  sleep 0.5
}

# ============ 主流程 ============

log "🔍 聚焦 Web Inspector..."
focus_inspector || exit 1

log "⏳ 等待 scraper.js 完成..."

for i in $(seq 1 $MAX_WAIT); do
  # 执行检查命令，结果会显示在控制台
  run_in_console "window.__SCRAPER_DONE__"

  # 读取剪贴板（上一次 run_in_console 会覆盖剪贴板，但控制台返回值不会进剪贴板）
  # 改用截屏检查控制台输出中是否有完成标记
  # 更简单的方法：直接执行 copy() 试试，如果数据还没好，copy 的内容会是 undefined
  run_in_console "if(window.__SCRAPER_DONE__){copy(JSON.stringify(window.__SCRAPER_RESULT__))}else{copy('__NOT_READY__')}"

  sleep 1
  CLIPBOARD=$(pbpaste 2>/dev/null | head -c 20)

  if [ "$CLIPBOARD" != "__NOT_READY__" ] && [ -n "$CLIPBOARD" ] && [ "$CLIPBOARD" != "undefined" ]; then
    log "✅ 数据已复制到剪贴板"
    pbpaste > "$OUTPUT_FILE"

    # 验证 JSON
    if python3 -c "import json; d=json.load(open('$OUTPUT_FILE')); print(f'✅ {d[\"total_rows\"]} 条记录, {d[\"total_pages\"]} 页')" 2>/dev/null; then
      log "📁 文件已保存: $OUTPUT_FILE"
      echo "$OUTPUT_FILE"
      exit 0
    else
      log "⚠️ 剪贴板内容不是有效 JSON，继续等待..."
    fi
  fi

  if [ $((i % 6)) -eq 0 ]; then
    log "⏳ 已等待 $((i*5)) 秒..."
  fi
done

log "❌ 超时：scraper.js 未在 5 分钟内完成"
exit 1
