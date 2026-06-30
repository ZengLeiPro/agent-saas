#!/bin/bash
# Safari Web Inspector 自动化：连接钉钉 WebView 并执行 JS 脚本
# 用法: safari-run-js.sh <js_file> [webview_keyword]
# 参数:
#   js_file        - 要执行的 JS 文件路径
#   webview_keyword - WebView 匹配关键词（默认 h5.dingtalk.com），用于在多个 WebView 中定位目标

set -euo pipefail

JS_FILE="${1:-}"
WEBVIEW_KEYWORD="${2:-h5.dingtalk.com}"
MAX_RETRIES=3

if [ -z "$JS_FILE" ] || [ ! -f "$JS_FILE" ]; then
  echo "❌ 用法: $0 <js_file> [webview_keyword]"
  exit 1
fi

log() { echo "$(date +%H:%M:%S) $1"; }

# ============ 步骤 1: 启动 Safari ============
log "📱 启动 Safari..."
peekaboo app launch "Safari" > /dev/null 2>&1
sleep 1

# ============ 步骤 2: 动态查找"开发"菜单 ============
log "🔍 查找「开发」菜单..."
DEV_MENU_ID=$(peekaboo see --app "Safari浏览器" --json 2>/dev/null | python3 -c "
import sys,json
data=json.load(sys.stdin)
for e in data.get('data',{}).get('ui_elements',[]):
    if e.get('label','') == '开发' and 'menu' in e.get('id',''):
        print(e['id']); break
" 2>/dev/null)

if [ -z "$DEV_MENU_ID" ]; then
  log "❌ 找不到「开发」菜单。请确认 Safari → 设置 → 高级 → 已勾选「显示开发菜单」"
  exit 1
fi
log "✅ 找到开发菜单: $DEV_MENU_ID"

# ============ 步骤 3: 打开开发菜单并导航到钉钉 WebView ============
open_dingtalk_webview() {
  log "📂 打开「开发」菜单..."
  peekaboo click --on "$DEV_MENU_ID" --app "Safari浏览器" > /dev/null 2>&1
  sleep 0.8

  # 键盘导航到 LeoMBA（本机设备）子菜单
  # 开发菜单结构: 页面打开方式 → 用户代理 → [本机名称] → ...
  # 按 ↓ 到第3项（本机），按 → 展开
  log "⌨️  导航到本机设备..."
  peekaboo press down --count 3 --app "Safari浏览器" > /dev/null 2>&1
  sleep 0.3
  peekaboo press right --app "Safari浏览器" > /dev/null 2>&1
  sleep 1

  # 截屏确认子菜单内容
  peekaboo image --mode screen --screen-index 0 --retina --path /tmp/_safari_submenu.png > /dev/null 2>&1

  # 在子菜单中查找目标 WebView
  # 遍历子菜单项（最多10个），逐个按 ↓ 并截屏匹配
  log "🔍 查找 $WEBVIEW_KEYWORD WebView..."

  # 先用 see 获取当前可见的菜单项，查找目标
  TARGET_ITEM=$(peekaboo see --app "Safari浏览器" --json 2>/dev/null | python3 -c "
import sys,json
data=json.load(sys.stdin)
for e in data.get('data',{}).get('ui_elements',[]):
    label = e.get('label','') or e.get('title','') or ''
    if '$WEBVIEW_KEYWORD' in label and e.get('id','').startswith('menuitem'):
        print(e['id']); break
" 2>/dev/null)

  if [ -n "$TARGET_ITEM" ]; then
    log "✅ 找到目标: $TARGET_ITEM"
    peekaboo click --on "$TARGET_ITEM" --app "Safari浏览器" > /dev/null 2>&1
    return 0
  fi

  # 如果 see 找不到（子菜单可能未被 accessibility 识别），用逐项导航方式
  log "⚠️  精确匹配失败，尝试逐项导航..."
  for i in $(seq 1 8); do
    peekaboo press down --app "Safari浏览器" > /dev/null 2>&1
    sleep 0.2
  done
  # 通常 h5.dingtalk.com 排在 about:blank、alidocs、desktop×2 之后，第5项左右
  # 上面已经按了8次，基本覆盖所有项。回退到大约第5项位置
  peekaboo press up --count 3 --app "Safari浏览器" > /dev/null 2>&1
  sleep 0.2
  peekaboo press return --app "Safari浏览器" > /dev/null 2>&1
  return 0
}

# 尝试打开 WebView（带重试）
for attempt in $(seq 1 $MAX_RETRIES); do
  log "🔄 尝试连接 WebView (第${attempt}次)..."
  open_dingtalk_webview

  sleep 2

  # 验证 Web Inspector 是否打开（检查窗口标题）
  INSPECTOR_OPEN=$(peekaboo list windows --app "Safari浏览器" --json 2>/dev/null | python3 -c "
import sys,json
data=json.load(sys.stdin)
for w in data.get('data',{}).get('windows',[]):
    if '网页检查器' in w.get('title','') or 'Web Inspector' in w.get('title',''):
        print('yes'); break
" 2>/dev/null)

  if [ "$INSPECTOR_OPEN" = "yes" ]; then
    log "✅ Web Inspector 已打开"
    break
  fi

  if [ "$attempt" -eq "$MAX_RETRIES" ]; then
    log "❌ 无法打开 Web Inspector，请手动操作: Safari → 开发 → 钉钉 → 选择目标页面"
    exit 1
  fi

  log "⚠️  Web Inspector 未打开，重试..."
  peekaboo press escape --app "Safari浏览器" > /dev/null 2>&1
  sleep 1
done

# ============ 步骤 4: 在控制台中粘贴并执行 JS ============
log "📋 复制 JS 脚本到剪贴板..."
cat "$JS_FILE" | pbcopy

log "⌨️  清空控制台..."
peekaboo hotkey --keys "cmd,k" --app "Safari浏览器" > /dev/null 2>&1
sleep 0.5

log "📋 粘贴 JS 到控制台..."
# 点击控制台输入区域（Inspector 窗口底部区域）
# 用 see 找到 Web Inspector 窗口的精确位置
INSPECTOR_BOUNDS=$(peekaboo list windows --app "Safari浏览器" --json 2>/dev/null | python3 -c "
import sys,json
data=json.load(sys.stdin)
for w in data.get('data',{}).get('windows',[]):
    if '网页检查器' in w.get('title','') or 'Web Inspector' in w.get('title',''):
        b = w.get('bounds',[[0,0],[800,600]])
        # 控制台输入区在窗口底部，大约底边上方20px
        cx = b[0][0] + b[1][0] // 2
        cy = b[0][1] + b[1][1] - 20
        print(f'{cx},{cy}'); break
" 2>/dev/null)

if [ -n "$INSPECTOR_BOUNDS" ]; then
  IX=$(echo "$INSPECTOR_BOUNDS" | cut -d, -f1)
  IY=$(echo "$INSPECTOR_BOUNDS" | cut -d, -f2)
  peekaboo click --app "Safari浏览器" --coords "$IX,$IY" > /dev/null 2>&1
else
  # fallback: 屏幕中间偏下
  peekaboo click --app "Safari浏览器" --coords 700,618 > /dev/null 2>&1
fi
sleep 0.3

peekaboo hotkey --keys "cmd,v" --app "Safari浏览器" > /dev/null 2>&1
sleep 0.8

log "🚀 执行 JS 脚本..."
peekaboo hotkey --keys "cmd,return" --app "Safari浏览器" > /dev/null 2>&1

log "✅ JS 已提交执行。等待数据下载..."
