/**
 * 自定义 not-found：iOS Share Extension 唤起主 app 时使用的特殊 URL
 *   agent-saas:///dataUrl=agent-saasShareKey
 * expo-router 当作普通 deep link 去匹配路由会失败，落到这个页面。
 * useShareIntentBridge 同时也在跑、会 push /share-target，但 not-found 已经被
 * 推到栈顶，挡住了 share-target。
 *
 * 策略：检测到当前 URL 是 share intent 特征时立刻 back，让 share-target 露出来。
 * 真实的输错路径走默认提示。
 */
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import {
  Stack,
  useGlobalSearchParams,
  usePathname,
  useRouter,
} from "expo-router";
import { useColors, spacing, typography } from "../src/theme";

function isShareIntentUrl(
  pathname: string | undefined,
  params: Record<string, unknown>,
): boolean {
  if (params && typeof params === "object" && "dataUrl" in params) return true;
  if (pathname && pathname.includes("dataUrl")) return true;
  return false;
}

export default function NotFound() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const colors = useColors();
  // 第一次 render 锁住判断结果，避免 router.back() 之后 hooks 重新返回不同值导致再触发
  const [shouldDismiss] = useState(() => isShareIntentUrl(pathname, params));

  useEffect(() => {
    if (!shouldDismiss) return;
    // useShareIntentBridge 已经 push 了 /share-target，back 一下让它露出来
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  }, [shouldDismiss, router]);

  // share intent 触发的不渲染任何内容（避免闪烁）
  if (shouldDismiss) {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: "页面不存在" }} />
      <Text style={[styles.title, { color: colors.foreground }]}>
        页面不存在
      </Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        {pathname ? `路径：${pathname}` : "未知路径"}
      </Text>
      <Pressable style={styles.btn} onPress={() => router.replace("/")}>
        <Text style={[styles.btnText, { color: colors.primary }]}>
          回到首页
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: { ...typography.body, fontSize: 20, fontWeight: "600" as const },
  subtitle: { ...typography.caption },
  btn: { marginTop: spacing.md, padding: spacing.sm },
  btnText: { ...typography.body },
});
