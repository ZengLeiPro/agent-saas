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
      <Stack.Screen name="my-permissions" options={{ title: "我的权限" }} />
      <Stack.Screen name="user-detail" options={{ title: "用户详情" }} />
      <Stack.Screen name="agent-profile" options={{ headerShown: false }} />
    </Stack>
  );
}
