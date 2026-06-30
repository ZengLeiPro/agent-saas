import React from 'react';
import { Stack } from 'expo-router';
import { useColors } from '../../../src/theme';
import { glassFree } from '../../../src/lib/headerItems';
import { BackButton } from '../../../src/components/BackButton';

export default function SettingsLayout() {
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
      <Stack.Screen name="index" options={{ title: '设置' }} />
    </Stack>
  );
}
