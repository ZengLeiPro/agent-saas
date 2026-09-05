import React from 'react';
import { Stack } from 'expo-router';
import { useColors } from '../../src/theme';
import { glassFree } from '../../src/lib/headerItems';
import { BackButton } from '../../src/components/BackButton';

export default function CronLayout() {
  const colors = useColors();

  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.foreground,
        headerTitleAlign: 'center',
        headerBackButtonDisplayMode: 'minimal' as const,
        freezeOnBlur: true,
        headerLeft: () => <BackButton />,
        unstable_headerLeftItems: ({ canGoBack }) => canGoBack ? [glassFree(
          <BackButton />
        )] : [],
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
      }}
    >
      {/* 标题与会话列表 pill、Web 侧边栏保持同一个词：任务中心 */}
      <Stack.Screen name="index" options={{ title: '任务中心' }} />
      <Stack.Screen name="[jobId]" options={{ title: '任务详情' }} />
    </Stack>
  );
}
