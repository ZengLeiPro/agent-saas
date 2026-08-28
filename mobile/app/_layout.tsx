// Platform init must be the very first import
import "../src/platform/init";

import React, { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View } from "react-native";
import { ShareIntentProvider } from "expo-share-intent";
import { AuthProvider, useAuth } from "../src/contexts/AuthContext";
import { ChatAppStateProvider } from "../src/contexts/ChatAppStateContext";
import { PendingSharedFilesProvider } from "../src/contexts/PendingSharedFilesContext";
import { useActivityReporter } from "../src/hooks/useActivityReporter";
import { useForegroundRefresh } from "../src/hooks/useForegroundRefresh";
import { useUpdateChecker } from "../src/hooks/useUpdateChecker";
import { useShareIntentBridge } from "../src/hooks/useShareIntentBridge";
import { AppErrorBoundary } from "../src/components/ErrorBoundary";
import { isV1SegmentsAllowed, isProductionProfile } from "../src/app/v1Capabilities";
import { getV1BuildProfile } from "../src/app/v1Runtime";

import { KeyboardProvider } from "react-native-keyboard-controller";
import {
  ThemeProvider,
  FontSizeProvider,
  useTheme,
  useColors,
} from "../src/theme";
import { PromptHost } from "../src/components/overlays/PromptHost";

function AuthGate() {
  const { user, loading } = useAuth();
  const colors = useColors();
  const segments = useSegments();
  const router = useRouter();
  const v1Profile = getV1BuildProfile();
  useActivityReporter();
  useForegroundRefresh();
  useUpdateChecker();
  useShareIntentBridge();

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === "login";

    // V1 范围裁剪（M00-01）：生产构建中，延期路由深链 fail closed，
    // 直接回到对话 Tab；未登录则回登录页。未分类路由同样拒绝。
    if (isProductionProfile(v1Profile) && !isV1SegmentsAllowed(segments, v1Profile)) {
      router.replace(user ? "/(tabs)/chat" : "/login");
      return;
    }

    if (!user && !inAuthGroup) {
      router.replace("/login");
    } else if (user && inAuthGroup) {
      router.replace("/(tabs)/chat");
    }
  }, [user, loading, segments, router, v1Profile]);

  return (
    <ChatAppStateProvider>
      <Stack
        screenOptions={
          {
            headerShown: false,
            headerTitleAlign: "center",
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.foreground,
            // Runtime-supported native-stack option that expo-router types may lag.
            fullScreenSwipeEnabled: false,
          } as any
        }
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="chat" />
        <Stack.Screen name="settings" />
        <Stack.Screen
          name="change-password"
          options={{
            headerShown: true,
          }}
        />
        <Stack.Screen
          name="user-form"
          options={{
            headerShown: true,
          }}
        />
        <Stack.Screen name="cron" />
        <Stack.Screen
          name="cron-form"
          options={{
            headerShown: true,
          }}
        />
        <Stack.Screen
          name="persona-editor"
          options={{
            headerShown: true,
          }}
        />
        <Stack.Screen
          name="text-editor"
          options={{
            headerShown: true,
          }}
        />
        <Stack.Screen
          name="memory-browser"
          options={{
            headerShown: true,
          }}
        />
        <Stack.Screen
          name="share-target"
          options={{
            presentation: "modal",
          }}
        />
        <Stack.Screen name="login" />
        <Stack.Screen name="index" />
      </Stack>
    </ChatAppStateProvider>
  );
}

function ThemedApp() {
  const { isDark, colors } = useTheme();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <AppErrorBoundary>
        {/* ShareIntentProvider 必须在所有其它 Provider 之前；PendingSharedFilesProvider
            在 ChatAppStateProvider 外侧，让 chat 页面可消费分享落地的文件 */}
        <ShareIntentProvider>
          <AuthProvider>
            <PendingSharedFilesProvider>
              <AuthGate />
            </PendingSharedFilesProvider>
          </AuthProvider>
        </ShareIntentProvider>
      </AppErrorBoundary>
      <PromptHost />
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <FontSizeProvider>
            <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
              <ThemedApp />
            </KeyboardProvider>
          </FontSizeProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
