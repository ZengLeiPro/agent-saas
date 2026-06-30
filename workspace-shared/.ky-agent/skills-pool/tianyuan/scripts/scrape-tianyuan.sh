#!/bin/bash
# 天元服务平台数据抓取 - 统一入口脚本
# 用法: scrape-tianyuan.sh [模块名称] [--no-db]
# 示例:
#   scrape-tianyuan.sh                    # 抓订单管理 + 入库
#   scrape-tianyuan.sh 订单管理            # 同上
#   scrape-tianyuan.sh 商机管理            # 抓商机管理 + 入库
#   scrape-tianyuan.sh 订单管理 --no-db    # 抓订单管理，不入库，只输出 JSON 路径
#
# 输出：
#   成功时最后一行打印 JSON 文件路径，供 Agent 读取
#   每个步骤有 ✅/❌ 状态，失败时打印原因后 exit 1
#
# 设计原则：
#   顺利时全自动跑完，Agent 零介入
#   失败时给出明确错误信息，Agent 可据此决定如何补救

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_MODULE="${1:-订单管理}"
NO_DB=false
for arg in "$@"; do
  [[ "$arg" == "--no-db" ]] && NO_DB=true
done

TS=$(date +%Y%m%d%H%M%S)
OUTPUT_FILE="/tmp/dingtalk-tianyuan-${TS}.json"

log()  { echo "$(date +%H:%M:%S) $1"; }
fail() { echo "$(date +%H:%M:%S) ❌ $1" >&2; exit 1; }

# ============================================================
# 步骤 0：屏幕状态检查
# ============================================================
log "🖥️  [0/6] 检查屏幕状态..."
peekaboo image --mode screen --screen-index 0 --path /tmp/_screen_check.png > /dev/null 2>&1

# 检查截图是否全黑（文件太小 = 纯色/黑屏）
FILE_SIZE=$(wc -c < /tmp/_screen_check.png | tr -d ' ')
if [ "$FILE_SIZE" -lt 5000 ]; then
  fail "屏幕疑似锁定（截图仅 ${FILE_SIZE} 字节）。请解锁屏幕后重新运行。"
fi
log "✅ [0/6] 屏幕正常"

# ============================================================
# 步骤 1：检查钉钉 + Frida 注入
# ============================================================
log "🔧 [1/6] 检查钉钉进程..."
if ! pgrep -x DingTalk > /dev/null 2>&1; then
  fail "钉钉未运行。请先打开钉钉。"
fi

log "🔧 [1/6] Frida 注入..."
INJECT_OUTPUT=$(bash "$SCRIPT_DIR/dingtalk-inject.sh" 2>&1) || true
if ! echo "$INJECT_OUTPUT" | grep -q "done"; then
  # 常见错误判断
  if echo "$INJECT_OUTPUT" | grep -q "unable to access process"; then
    fail "Frida 无法附着（Hardened Runtime）。需执行：codesign -s - --deep --force /Applications/DingTalk.app 后重开钉钉。"
  fi
  fail "Frida 注入失败: $INJECT_OUTPUT"
fi
OK_COUNT=$(echo "$INJECT_OUTPUT" | grep -c "OK:" || true)
log "✅ [1/6] Frida 注入成功（${OK_COUNT} 个 WebView）"

# ============================================================
# 步骤 2：进入天元服务平台
# ============================================================
log "📱 [2/6] 激活钉钉..."
peekaboo dock launch "钉钉" > /dev/null 2>&1
sleep 1.5

log "📱 [2/6] 查找「钉钉服务平台」..."
PLATFORM_ID=$(peekaboo see --app "钉钉" --json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for e in data.get('data', {}).get('ui_elements', []):
    label = e.get('label', '') or e.get('title', '') or ''
    if '服务平台' in label:
        print(e['id']); break
" 2>/dev/null)

if [ -z "$PLATFORM_ID" ]; then
  fail "找不到「钉钉服务平台」入口。请确认钉钉在主界面且左侧栏可见。"
fi

peekaboo click --on "$PLATFORM_ID" --app "钉钉" > /dev/null 2>&1
sleep 3
log "✅ [2/6] 已进入天元服务平台"

# ============================================================
# 步骤 3：连接 Web Inspector + 执行 JS
# ============================================================
log "🌐 [3/6] 生成抓取脚本（目标: ${TARGET_MODULE}）..."
JS_FILE="/tmp/scraper-with-nav-${TS}.js"
echo "window.__TARGET_MODULE__ = '${TARGET_MODULE}';" > "$JS_FILE"
cat "$SCRIPT_DIR/scraper.js" >> "$JS_FILE"

log "🌐 [3/6] 连接 Web Inspector + 执行 JS..."
SAFARI_OUTPUT=$(bash "$SCRIPT_DIR/safari-run-js.sh" "$JS_FILE" h5.dingtalk.com 2>&1) || true
if ! echo "$SAFARI_OUTPUT" | grep -q "JS 已提交执行"; then
  log "⚠️  safari-run-js.sh 输出: $SAFARI_OUTPUT"
  fail "Web Inspector 连接或 JS 执行失败。请检查 Safari 开发菜单是否启用。"
fi
log "✅ [3/6] JS 已提交执行"

# ============================================================
# 步骤 4：等待抓取完成
# ============================================================
log "⏳ [4/6] 等待抓取完成（翻页中，预计 30-90 秒）..."

# 聚焦 Web Inspector
INSPECTOR_INDEX=$(peekaboo window list --app "Safari浏览器" --json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for w in data.get('data', {}).get('windows', []):
    if '网页检查器' in w.get('title', '') or 'Web Inspector' in w.get('title', ''):
        print(w.get('window_index', '')); break
" 2>/dev/null)

if [ -z "$INSPECTOR_INDEX" ]; then
  fail "找不到 Web Inspector 窗口。"
fi

peekaboo window focus --app "Safari浏览器" --window-index "$INSPECTOR_INDEX" --space-switch > /dev/null 2>&1
sleep 1

# 轮询 __SCRAPER_DONE__，每 5 秒检查一次
MAX_POLL=60  # 60 × 5s = 5 分钟
for i in $(seq 1 $MAX_POLL); do
  # 在控制台执行：如果完成则 copy 数据，否则 copy 标记
  JS_CHECK='if(window.__SCRAPER_DONE__){copy(JSON.stringify(window.__SCRAPER_RESULT__))}else{copy("__NOT_READY__")}'
  echo -n "$JS_CHECK" | pbcopy
  sleep 0.2
  peekaboo hotkey --keys "cmd,a" --app "Safari浏览器" > /dev/null 2>&1
  sleep 0.1
  peekaboo hotkey --keys "cmd,v" --app "Safari浏览器" > /dev/null 2>&1
  sleep 0.3
  peekaboo hotkey --keys "cmd,return" --app "Safari浏览器" > /dev/null 2>&1
  sleep 1.5

  CLIP=$(pbpaste 2>/dev/null | head -c 30)
  if [ "$CLIP" != "__NOT_READY__" ] && [ -n "$CLIP" ] && [ "$CLIP" != "undefined" ]; then
    # 尝试保存并验证 JSON
    pbpaste > "$OUTPUT_FILE" 2>/dev/null
    if python3 -c "
import json, sys
d = json.load(open('$OUTPUT_FILE'))
print(f'✅ {d[\"total_rows\"]} 条, {d[\"total_pages\"]} 页')
" 2>/dev/null; then
      break
    fi
  fi

  if [ $((i % 6)) -eq 0 ]; then
    log "⏳ [4/6] 已等待 $((i*5)) 秒..."
  fi

  if [ "$i" -eq "$MAX_POLL" ]; then
    fail "超时：抓取未在 5 分钟内完成。请检查 Web Inspector 控制台是否有报错。"
  fi

  sleep 3.5
done

SUMMARY=$(python3 -c "
import json
d = json.load(open('$OUTPUT_FILE'))
print(f'{d[\"total_rows\"]} 条记录, {d[\"total_pages\"]} 页')
" 2>/dev/null)
log "✅ [4/6] 抓取完成: $SUMMARY"

# ============================================================
# 步骤 5：数据入库（可选）
# ============================================================
if [ "$NO_DB" = true ]; then
  log "⏭️  [5/6] 跳过入库（--no-db）"
else
  log "💾 [5/6] 数据入库..."
  if python3 "$SCRIPT_DIR/process-data.py" "$OUTPUT_FILE" 2>&1; then
    log "✅ [5/6] 入库完成"
  else
    log "⚠️  [5/6] 入库失败，JSON 文件仍可用"
  fi
fi

# ============================================================
# 步骤 6：完成
# ============================================================
log "✅ [6/6] 全部完成"
log "📁 JSON: $OUTPUT_FILE"
log "📊 数据: $SUMMARY"

# 最后一行输出文件路径（供 Agent 程序化读取）
echo "$OUTPUT_FILE"
