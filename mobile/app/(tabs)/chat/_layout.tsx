import React from 'react';
import { Stack } from 'expo-router';
import { useColors } from '../../../src/theme';

export default function ChatLayout() {
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
      <Stack.Screen name="index" options={{ animation: 'none' }} />
      {/* @ts-expect-error fullScreenSwipeEnabled is supported at runtime but missing from type defs */}
      <Stack.Screen name="group/[groupKey]" options={{ fullScreenSwipeEnabled: true }} />
    </Stack>
  );
}
