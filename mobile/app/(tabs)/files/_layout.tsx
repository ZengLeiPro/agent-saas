import React, { useEffect } from "react";
import { Stack, useRouter } from "expo-router";
import { DEFAULT_TENANT_SETTINGS } from "@agent/shared";
import { useAuth } from "../../../src/contexts/AuthContext";
import { useColors } from "../../../src/theme";

export default function FilesLayout() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const filesEnabled = (
    user?.tenantFeatures ?? DEFAULT_TENANT_SETTINGS.features
  ).filesEnabled;

  useEffect(() => {
    if (!filesEnabled) router.replace("/(tabs)/chat");
  }, [filesEnabled, router]);

  if (!filesEnabled) return null;

  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.foreground,
        headerTitleAlign: "center",
        headerBackButtonDisplayMode: "minimal" as const,
        freezeOnBlur: true,
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" options={{ title: "文件" }} />
      <Stack.Screen
        name="browse"
        options={{ fullScreenSwipeEnabled: true } as any}
      />
    </Stack>
  );
}
