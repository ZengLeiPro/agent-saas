#!/bin/bash
# 统一构建脚本：iOS + Android 本地构建 + 自动清理
# 解决 EAS local build 吃掉 ~60GB 磁盘空间的问题
#
# iOS: 构建 IPA → 提交 TestFlight → 清理
# Android: 构建 APK → 清理（内部分发，不走应用商店）
#
# 用法:
#   ./scripts/build.sh                  # 构建双平台（iOS 含提交），清理
#   ./scripts/build.sh ios              # 仅 iOS（构建 + 提交 + 清理）
#   ./scripts/build.sh android          # 仅 Android（构建 + 清理）
#   ./scripts/build.sh ios android      # 同上，显式指定双平台
#   ./scripts/build.sh ios --build      # iOS 仅构建，不提交
#   ./scripts/build.sh --no-clean       # 构建但不清理缓存

set -uo pipefail

# 确保 Java 和 Android SDK 可用（EAS 子进程可能不加载 .zshrc）
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILDS_DIR="$MOBILE_DIR/builds"
IPA_PATH="$BUILDS_DIR/AgentSaaS.ipa"
APK_PATH="$BUILDS_DIR/AgentSaaS.apk"
EXIT_CODE=0
BUILD_ATTEMPTED=false

# 默认：双平台，构建+清理（iOS 含提交）
PLATFORM_IOS=false
PLATFORM_ANDROID=false
DO_BUILD=true
DO_SUBMIT=true
DO_CLEAN=true

for arg in "$@"; do
  case $arg in
    ios)        PLATFORM_IOS=true ;;
    android)    PLATFORM_ANDROID=true ;;
    --build)    DO_SUBMIT=false ;;
    --no-clean) DO_CLEAN=false ;;
  esac
done

# 未指定平台 = 双平台
if ! $PLATFORM_IOS && ! $PLATFORM_ANDROID; then
  PLATFORM_IOS=true
  PLATFORM_ANDROID=true
fi

# ─── 清理函数 ───

cleanup_build_cache() {
  echo ""
  echo "========================================"
  echo "  清理构建缓存..."
  echo "========================================"

  local freed=0

  # 只清理本次构建平台的缓存，避免并行构建时互相干扰
  if $PLATFORM_IOS; then
    # DerivedData（iOS 构建产物，通常 30-40GB）
    if [ -d "$HOME/Library/Developer/Xcode/DerivedData" ]; then
      local size
      size=$(du -sm "$HOME/Library/Developer/Xcode/DerivedData" 2>/dev/null | cut -f1)
      rm -rf "$HOME/Library/Developer/Xcode/DerivedData"/*
      mkdir -p "$HOME/Library/Developer/Xcode/DerivedData"
      freed=$((freed + size))
      echo "  ✓ DerivedData: 释放 ${size}MB"
    fi

    # CocoaPods 缓存（通常 15-20GB）
    if [ -d "$HOME/Library/Caches/CocoaPods" ]; then
      local size
      size=$(du -sm "$HOME/Library/Caches/CocoaPods" 2>/dev/null | cut -f1)
      rm -rf "$HOME/Library/Caches/CocoaPods"
      freed=$((freed + size))
      echo "  ✓ CocoaPods cache: 释放 ${size}MB"
    fi
  fi

  if $PLATFORM_ANDROID; then
    # 停止 Gradle daemon（防止 daemon 持有已删除缓存的文件引用）
    for gw in "$HOME"/.gradle/wrapper/dists/gradle-*/*/gradle-*/bin/gradle; do
      [ -x "$gw" ] && "$gw" --stop 2>/dev/null && echo "  ✓ Gradle daemon 已停止" && break
    done 2>/dev/null

    # Gradle 缓存（Android 构建产物，通常 3-5GB）
    if [ -d "$HOME/.gradle/caches" ]; then
      local size
      size=$(du -sm "$HOME/.gradle/caches" 2>/dev/null | cut -f1)
      rm -rf "$HOME/.gradle/caches"
      freed=$((freed + size))
      echo "  ✓ Gradle caches: 释放 ${size}MB"
    fi
  fi

  # EAS 本地构建临时目录（公共，总是清理）
  local eas_tmp
  for eas_tmp in /var/folders/*/*/eas-build-local-nodejs /tmp/eas-build-*; do
    if [ -d "$eas_tmp" ]; then
      local size
      size=$(du -sm "$eas_tmp" 2>/dev/null | cut -f1)
      rm -rf "$eas_tmp"
      freed=$((freed + size))
      echo "  ✓ EAS temp ($eas_tmp): 释放 ${size}MB"
    fi
  done

  echo ""
  echo "  总计释放: $((freed / 1024))GB (${freed}MB)"
  echo "========================================"
}

# ─── 退出钩子：无论成功失败，保证清理 ───

on_exit() {
  if $DO_CLEAN && $BUILD_ATTEMPTED; then
    cleanup_build_cache
  fi
  if [ $EXIT_CODE -ne 0 ]; then
    echo ""
    echo "========================================"
    echo "  构建流程失败 (exit $EXIT_CODE)"
    echo "========================================"
  fi
  exit $EXIT_CODE
}
trap on_exit EXIT

# ─── 构建 + 提交（各平台独立，互不阻塞） ───

cd "$MOBILE_DIR"

IOS_OK=false
ANDROID_OK=false

# iOS: 构建 → 提交
if $PLATFORM_IOS; then
  if $DO_BUILD; then
    BUILD_ATTEMPTED=true
    mkdir -p "$BUILDS_DIR"
    echo "========================================"
    echo "  开始 iOS 本地构建..."
    echo "========================================"
    if EAS_SKIP_AUTO_FINGERPRINT=1 eas build -p ios -e production --local --output "$IPA_PATH" --non-interactive && [ -f "$IPA_PATH" ]; then
      echo "  ✓ iOS 构建成功: $IPA_PATH"
      IOS_OK=true
    else
      echo "  ✗ iOS 构建失败"
      EXIT_CODE=1
    fi
  else
    # --submit 模式，检查已有产物
    [ -f "$IPA_PATH" ] && IOS_OK=true
  fi

  if $DO_SUBMIT && $IOS_OK; then
    echo ""
    echo "========================================"
    echo "  提交 iOS 到 TestFlight..."
    echo "========================================"
    if eas submit -p ios --path "$IPA_PATH" --non-interactive --no-wait; then
      echo "  ✓ iOS 提交完成"
    else
      echo "  ✗ TestFlight 提交失败"
      EXIT_CODE=1
    fi
  elif $DO_SUBMIT && ! $IOS_OK; then
    echo "  ✗ 跳过 iOS 提交（无可用 IPA）"
    EXIT_CODE=1
  fi
fi

# Android: 构建 → 上传 OSS
if $PLATFORM_ANDROID; then
  if $DO_BUILD; then
    BUILD_ATTEMPTED=true
    mkdir -p "$BUILDS_DIR"
    echo ""
    echo "========================================"
    echo "  开始 Android 本地构建..."
    echo "========================================"
    if EAS_SKIP_AUTO_FINGERPRINT=1 eas build -p android -e production --local --output "$APK_PATH" --non-interactive && [ -f "$APK_PATH" ]; then
      echo "  ✓ Android 构建成功: $APK_PATH"
      ANDROID_OK=true
    else
      echo "  ✗ Android 构建失败"
      EXIT_CODE=1
    fi
  fi

  # 上传 APK 到阿里云 OSS
  if $ANDROID_OK; then
    echo ""
    echo "========================================"
    echo "  上传 Android APK 到 OSS..."
    echo "========================================"
    OSS_BUCKET="oss://agent-saas-releases"
    VERSION=$(python3 -c "import json; print(json.load(open('$MOBILE_DIR/app.json'))['expo']['version'])")
    APK_SIZE=$(stat -f%z "$APK_PATH")
    OSS_APK_KEY="android/AgentSaaS-${VERSION}.apk"
    OSS_ENDPOINT="oss-cn-shenzhen.aliyuncs.com"
    OSS_DOWNLOAD_URL="https://agent-saas-releases.${OSS_ENDPOINT}/${OSS_APK_KEY}"

    # 上传 APK（覆盖同版本）
    if aliyun oss cp "$APK_PATH" "${OSS_BUCKET}/${OSS_APK_KEY}" --force; then
      echo "  ✓ APK 已上传: ${OSS_DOWNLOAD_URL}"

      # 生成并上传 latest.json
      LATEST_JSON=$(python3 -c "
import json, datetime
print(json.dumps({
    'version': '${VERSION}',
    'size': ${APK_SIZE},
    'url': '${OSS_DOWNLOAD_URL}',
    'buildTime': datetime.datetime.now().astimezone().isoformat()
}, ensure_ascii=False))
")
      echo "$LATEST_JSON" > /tmp/agent-saas-latest.json
      if aliyun oss cp /tmp/agent-saas-latest.json "${OSS_BUCKET}/android/latest.json" --force \
           --meta "Content-Type:application/json"; then
        echo "  ✓ latest.json 已更新"
      else
        echo "  ✗ latest.json 上传失败"
        EXIT_CODE=1
      fi
      rm -f /tmp/agent-saas-latest.json
    else
      echo "  ✗ APK 上传失败"
      EXIT_CODE=1
    fi
  fi
fi

# ─── 汇总 ───

echo ""
echo "========================================"
if [ $EXIT_CODE -eq 0 ]; then
  echo "  全部完成!"
else
  echo "  部分完成（有失败项）:"
  $PLATFORM_IOS && echo "    iOS:     $($IOS_OK && echo '✓ 成功' || echo '✗ 失败')"
  $PLATFORM_ANDROID && echo "    Android: $($ANDROID_OK && echo '✓ 成功' || echo '✗ 失败')"
fi
echo "========================================"
