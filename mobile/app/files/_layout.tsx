/**
 * 文件中心路由壳（P3-3c）—— 对齐 Web `FileBrowser` 的信息架构。
 *
 * 09-05 拍板：移动端不恢复第三个 Tab，文件中心改为从会话列表「文件」pill
 * 进入的 Stack 路由（`/files`），与能力中心 / 任务中心同一形态。
 * 租户开关 `tenantFeatures.filesEnabled` 关闭时整条路由不挂载并回退对话页。
 */
import React, { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { DEFAULT_TENANT_SETTINGS } from '@agent/shared';
import { useAuth } from '../../src/contexts/AuthContext';
import { useColors } from '../../src/theme';
import { glassFree } from '../../src/lib/headerItems';
import { BackButton } from '../../src/components/BackButton';

export default function FilesLayout() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const filesEnabled = (user?.tenantFeatures ?? DEFAULT_TENANT_SETTINGS.features).filesEnabled;

  useEffect(() => {
    if (!filesEnabled) router.replace('/(tabs)/chat');
  }, [filesEnabled, router]);

  if (!filesEnabled) return null;

  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.foreground,
        headerTitleAlign: 'center',
        headerBackButtonDisplayMode: 'minimal' as const,
        freezeOnBlur: true,
        headerLeft: () => <BackButton />,
        unstable_headerLeftItems: ({ canGoBack }) => (canGoBack ? [glassFree(<BackButton />)] : []),
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
      }}
    >
      {/* 标题与会话列表 pill、Web 侧边栏保持同一个词：文件 */}
      <Stack.Screen name="index" options={{ title: '文件' }} />
      <Stack.Screen name="browse" options={{ fullScreenSwipeEnabled: true } as any} />
    </Stack>
  );
}
