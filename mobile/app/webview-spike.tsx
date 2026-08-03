// ⚠️ SPIKE：验证「原生壳 + WebView 加载生产 Web 端」的可行性，验证完可整体删除。
// 验证点：① 聊天输入框键盘体验 ② 长列表滚动性能 ③ WebView 挂起后的 WS 断线恢复
import React, { useRef, useState } from "react";
import { View, ActivityIndicator, StyleSheet, Text, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useRouter } from "expo-router";
import { useColors } from "../src/theme";

const SPIKE_URL = "https://agent.kaiyan.net";

export default function WebViewSpikeScreen() {
  const colors = useColors();
  const router = useRouter();
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      {/* 极简顶栏：返回 + 刷新，其余空间全部给 WebView */}
      <View style={[styles.bar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Text style={[styles.barText, { color: colors.foreground }]}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={[styles.barTitle, { color: colors.mutedForeground }]}>WebView Spike</Text>
        <TouchableOpacity onPress={() => webRef.current?.reload()} hitSlop={12}>
          <Text style={[styles.barText, { color: colors.foreground }]}>刷新</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.webWrap}>
        <WebView
          ref={webRef}
          source={{ uri: SPIKE_URL }}
          style={styles.web}
          // 观察真实键盘行为：不加任何原生键盘补偿，先看 WKWebView 默认表现
          onLoadEnd={() => setLoading(false)}
          onError={(e) => setFailed(e.nativeEvent.description ?? "load error")}
          // 会话依赖 localStorage token + WS，域内持久化默认开启
          domStorageEnabled
          javaScriptEnabled
          allowsInlineMediaPlayback
          allowsBackForwardNavigationGestures
          // iOS 输入框聚焦不需要用户手势也可弹键盘（web 端可能有自动聚焦）
          keyboardDisplayRequiresUserAction={false}
          // 避免 WebView 内容顶到刘海后面，交给页面 viewport 处理
          contentInsetAdjustmentBehavior="never"
        />
        {loading && !failed && (
          <View style={styles.overlay} pointerEvents="none">
            <ActivityIndicator size="large" color={colors.foreground} />
          </View>
        )}
        {failed && (
          <View style={styles.overlay}>
            <Text style={{ color: colors.foreground, marginBottom: 12 }}>加载失败：{failed}</Text>
            <TouchableOpacity
              onPress={() => {
                setFailed(null);
                setLoading(true);
                webRef.current?.reload();
              }}
            >
              <Text style={{ color: colors.foreground, textDecorationLine: "underline" }}>重试</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  barText: { fontSize: 16 },
  barTitle: { fontSize: 13 },
  webWrap: { flex: 1 },
  web: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
});
