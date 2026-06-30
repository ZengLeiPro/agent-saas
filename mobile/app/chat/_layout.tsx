import React from 'react';
import { Stack } from 'expo-router';
import { useColors } from '../../src/theme';

export default function ChatDetailLayout() {
  const colors = useColors();

  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.foreground,
        headerTitleAlign: 'center',
        headerBackButtonDisplayMode: 'minimal' as const,
        freezeOnBlur: true,
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="[sessionId]" />
      <Stack.Screen
        name="markdown-preview"
        // @ts-expect-error fullScreenSwipeEnabled is supported at runtime but missing from type defs
        options={{ gestureEnabled: true, fullScreenSwipeEnabled: true }}
      />
      <Stack.Screen
        name="html-preview"
        // @ts-expect-error fullScreenSwipeEnabled is supported at runtime but missing from type defs
        options={{ gestureEnabled: true, fullScreenSwipeEnabled: true }}
      />
    </Stack>
  );
}
