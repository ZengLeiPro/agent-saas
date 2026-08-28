import React, { useEffect } from "react";
import { View } from "react-native";
import { useRouter, useSegments } from "expo-router";
import { useAuth } from "../contexts/AuthContext";
import { useColors } from "../theme";
import { resolveV1GateDecision } from "./v1Capabilities";
import { getV1BuildProfile } from "./v1Runtime";

/**
 * V1 路由门禁（M00-01）：生产构建中，路由未确认允许前不挂载任何子路由。
 *
 * fail closed 语义（Review 返工要求）：
 * - 延期/未分类路由在渲染阶段即被阻断——children（含目标 Screen 及其
 *   全部副作用：OAuth handoff 消费、preview token 申请、治理/MCP 请求等）
 *   完全不挂载，而不是先挂载再由 useEffect 事后重定向；
 * - 鉴权仍在 loading 时同样阻断（此时无法确认去向，先渲染安全空壳）；
 * - 被拒绝时渲染安全空壳并重定向到对话 Tab / 登录页。
 *
 * 决策逻辑 100% 来自纯函数 resolveV1GateDecision（见 v1Capabilities.ts），
 * 本组件只做平台绑定，运行时行为由 v1RouteGate.runtime.test.tsx 守卫。
 */
export function V1RouteGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const colors = useColors();
  const profile = getV1BuildProfile();

  const decision = resolveV1GateDecision({
    profile,
    segments,
    authLoading: loading,
    hasUser: !!user,
  });

  useEffect(() => {
    if (decision.redirectTo) {
      router.replace(decision.redirectTo);
    }
  }, [decision.redirectTo, router]);

  if (!decision.mountRoute) {
    return (
      <View
        testID="v1-route-denied-shell"
        style={{ flex: 1, backgroundColor: colors.background }}
      />
    );
  }
  return <>{children}</>;
}
