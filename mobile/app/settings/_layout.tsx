import React from "react";
import { Stack } from "expo-router";
import { useColors } from "../../src/theme";
import { glassFree } from "../../src/lib/headerItems";
import { BackButton } from "../../src/components/BackButton";

export default function SettingsDetailLayout() {
  const colors = useColors();

  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.foreground,
        headerTitleAlign: "center",
        headerBackButtonDisplayMode: "minimal" as const,
        freezeOnBlur: true,
        headerLeft: () => <BackButton />,
        unstable_headerLeftItems: () => [glassFree(<BackButton />)],
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
      }}
    >
      {/* P3-3d：个人设置 8 分区的详情路由，路由名与 Web `/settings/<id>` 一致 */}
      <Stack.Screen name="account-security" options={{ title: "账户与安全" }} />
      <Stack.Screen name="my-agent" options={{ title: "我的 Agent" }} />
      <Stack.Screen name="chat-model" options={{ title: "对话与模型" }} />
      <Stack.Screen name="appearance-layout" options={{ title: "外观与布局" }} />
      <Stack.Screen name="files-storage" options={{ title: "文件与存储" }} />
      <Stack.Screen name="my-permissions" options={{ title: "我的权限" }} />
      <Stack.Screen name="user-detail" options={{ title: "用户详情" }} />
      <Stack.Screen name="agent-profile" options={{ headerShown: false }} />
    </Stack>
  );
}
