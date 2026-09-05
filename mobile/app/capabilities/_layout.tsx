/**
 * 能力中心路由壳 —— 对齐 Web `/capabilities/{templates|skills|connectors|experts}`
 * 的四 Tab 信息架构，原生端拆成四条平级路由，顶部由 `CapabilityTabBar` 切换。
 */
import React from 'react';
import { Stack } from 'expo-router';
import { useColors } from '../../src/theme';
import { glassFree } from '../../src/lib/headerItems';
import { BackButton } from '../../src/components/BackButton';

export default function CapabilitiesLayout() {
  const colors = useColors();

  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.foreground,
        headerTitleAlign: 'center',
        headerBackButtonDisplayMode: 'minimal' as const,
        freezeOnBlur: true,
        headerLeft: () => <BackButton />,
        unstable_headerLeftItems: () => [glassFree(<BackButton />)],
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="workflows" options={{ title: '能力中心' }} />
      <Stack.Screen name="skills" options={{ title: '能力中心' }} />
      <Stack.Screen name="connectors" options={{ title: '能力中心' }} />
      <Stack.Screen name="experts" options={{ title: '能力中心' }} />
    </Stack>
  );
}
