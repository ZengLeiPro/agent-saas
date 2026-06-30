#!/bin/bash
# 钉钉 WebView isInspectable 注入脚本
# 使用 Frida 将所有 WKWebView 设置为可检查，使 Safari Web Inspector 可以连接
# 前置条件：DingTalk.app 已去除 Hardened Runtime (codesign -s - --deep --force /Applications/DingTalk.app)

set -e

PID=$(pgrep -x DingTalk 2>/dev/null | head -1)
if [ -z "$PID" ]; then
  echo "❌ 钉钉未运行"
  exit 1
fi

echo "🔧 注入 DingTalk PID: $PID"

cat > /tmp/_dingtalk_inject.js << 'FRIDAJS'
send("attached");
ObjC.choose(ObjC.classes.WKWebView, {
  onMatch: function(w) {
    w.setInspectable_(true);
    send("OK: " + w.handle);
  },
  onComplete: function() {
    send("done");
  }
});
FRIDAJS

frida -p $PID -l /tmp/_dingtalk_inject.js -q 2>&1 &
FPID=$!
sleep 6
kill $FPID 2>/dev/null
wait $FPID 2>/dev/null
echo "✅ 注入完成。打开 Safari → 开发 菜单查看钉钉 WebView"
