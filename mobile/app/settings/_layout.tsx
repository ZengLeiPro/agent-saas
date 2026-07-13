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
      <Stack.Screen name="users" options={{ title: "用户管理" }} />
      <Stack.Screen name="user-detail" options={{ title: "用户详情" }} />
      <Stack.Screen name="audit-log" />
      <Stack.Screen name="all-agents" options={{ title: "所有 Agent" }} />
      <Stack.Screen name="agent-profile" options={{ headerShown: false }} />
      <Stack.Screen name="skills" options={{ title: "技能" }} />
      <Stack.Screen name="skills-admin" options={{ title: "技能管理" }} />
    </Stack>
  );
}
