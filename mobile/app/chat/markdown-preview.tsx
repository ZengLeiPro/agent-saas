import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Pressable, Alert } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { MoreHorizontal } from 'lucide-react-native';
import { DropdownMenu, type DropdownSection } from '../../src/components/overlays/DropdownMenu';
import { BackButton } from '../../src/components/BackButton';
import * as Clipboard from 'expo-clipboard';
import { fileCacheService } from '../../src/services/fileCacheService';
import {
  MarkdownPreviewBody,
  markdownPreviewTitle,
} from '../../src/components/chat/MarkdownPreviewBody';
import { useColors } from '../../src/theme';
import { glassFree } from '../../src/lib/headerItems';

export default function MarkdownPreviewScreen() {
  const colors = useColors();
  const { filePath, owner, root } = useLocalSearchParams<{
    filePath: string;
    owner?: string;
    root?: string;
  }>();
  const isRootMode = root === 'true';
  const router = useRouter();
  const path = filePath ?? '';

  const handleDownload = useCallback(async () => {
    if (!path) return;
    try {
      const { openOrShareFile } = await import('../../src/utils/openOrShareFile');
      const uri = await fileCacheService.getOrDownload(path, 0, 0, owner, isRootMode || undefined);
      await openOrShareFile(uri);
    } catch (err: any) {
      Alert.alert('下载失败', err?.message || String(err));
    }
  }, [path, owner, isRootMode]);

  const [headerMenuVisible, setHeaderMenuVisible] = useState(false);
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState(0);
  const headerMenuTriggerRef = useRef<View>(null);

  const handleOpenHeaderMenu = useCallback(() => {
    headerMenuTriggerRef.current?.measureInWindow((_x, y, _w, h) => {
      setHeaderMenuAnchor(y + h);
      setHeaderMenuVisible(true);
    });
  }, []);

  const menuSections = useMemo<DropdownSection[]>(
    () => [
      {
        id: 'actions',
        actions: [
          { id: 'copy-path', label: '复制路径' },
          { id: 'download', label: '下载' },
        ],
      },
    ],
    [],
  );

  const handleMenuSelect = useCallback(
    async (actionId: string) => {
      switch (actionId) {
        case 'copy-path':
          await Clipboard.setStringAsync(path || '');
          break;
        case 'download':
          await handleDownload();
          break;
      }
    },
    [path, handleDownload],
  );

  const fileName = markdownPreviewTitle(path);

  return (
    <View style={{ flex: 1, backgroundColor: colors.card }}>
      <Stack.Screen
        options={{
          title: fileName,
          headerLeft: () => <BackButton />,
          unstable_headerLeftItems: () => [glassFree(<BackButton />)],
          headerRight: () => (
            <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu} hitSlop={8}>
              <MoreHorizontal size={22} color={colors.foreground} strokeWidth={2} />
            </Pressable>
          ),
          unstable_headerRightItems: () => [
            glassFree(
              <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu} hitSlop={8}>
                <MoreHorizontal size={22} color={colors.foreground} strokeWidth={2} />
              </Pressable>,
            ),
          ],
        }}
      />

      <MarkdownPreviewBody
        filePath={path}
        {...(owner ? { owner } : {})}
        {...(isRootMode ? { root: true } : {})}
        onNavigatePreview={(next) => {
          router.push({
            pathname: '/chat/markdown-preview',
            params: {
              filePath: next,
              ...(owner ? { owner } : {}),
              ...(isRootMode ? { root: 'true' } : {}),
            },
          });
        }}
      />

      <DropdownMenu
        visible={headerMenuVisible}
        onClose={() => setHeaderMenuVisible(false)}
        sections={menuSections}
        onSelect={handleMenuSelect}
        anchorTop={headerMenuAnchor}
        align="right"
      />
    </View>
  );
}
