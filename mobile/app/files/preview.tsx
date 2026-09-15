/**
 * 通用文件预览路由 —— body 逻辑在 `FilePreviewBody`，本文件只挂 Stack 顶栏。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type View as RNView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { DropdownMenu, type DropdownSection } from '../../src/components/overlays/DropdownMenu';
import { HeaderMenuButton } from '../../src/components/files/fileHeaderItems';
import {
  FilePreviewBody,
  filePreviewDisplayName,
} from '../../src/components/files/preview/FilePreviewBody';
import { resolveKbPreviewSource } from '../../src/lib/filePreviewTarget';
import { glassFree } from '../../src/lib/headerItems';
import { useColors } from '../../src/theme';

export default function FilePreviewScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{
    filePath: string;
    name?: string;
    size?: string;
    modifiedAt?: string;
    owner?: string;
    root?: string;
  }>();

  const filePath = params.filePath ?? '';
  const owner = params.owner;
  const isRootMode = params.root === 'true';
  const size = Number(params.size ?? '0') || 0;
  const modifiedAt = Number(params.modifiedAt ?? '0') || 0;
  const kb = useMemo(() => resolveKbPreviewSource(filePath), [filePath]);
  const fileName = filePreviewDisplayName(filePath, params.name);

  const downloadRef = useRef<(() => Promise<void>) | null>(null);
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState(0);
  const menuTriggerRef = useRef<RNView>(null);

  const openMenu = useCallback(() => {
    menuTriggerRef.current?.measureInWindow((_x, y, _w, h) => {
      setMenuAnchor(y + h);
      setMenuVisible(true);
    });
  }, []);

  const menuSections = useMemo<DropdownSection[]>(
    () => [
      {
        id: 'actions',
        actions: [
          { id: 'download', label: '下载 / 分享' },
          { id: 'copy-path', label: '复制路径' },
        ],
      },
    ],
    [],
  );

  const handleMenuSelect = useCallback(
    (actionId: string) => {
      if (actionId === 'download') void downloadRef.current?.();
      else if (actionId === 'copy-path') void Clipboard.setStringAsync(kb.doc || filePath);
    },
    [kb.doc, filePath],
  );

  const headerRight = useCallback(
    () => (
      <HeaderMenuButton onPress={openMenu} triggerRef={menuTriggerRef} testID="file-preview-menu" />
    ),
    [openMenu],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.card }]} testID="file-preview-screen">
      <Stack.Screen
        options={{
          title: fileName,
          headerRight,
          unstable_headerRightItems: () => [glassFree(headerRight())],
        }}
      />

      <FilePreviewBody
        filePath={filePath}
        {...(params.name ? { name: params.name } : {})}
        size={size}
        modifiedAt={modifiedAt}
        {...(owner ? { owner } : {})}
        {...(isRootMode ? { root: true } : {})}
        downloadRef={downloadRef}
      />

      <DropdownMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        sections={menuSections}
        onSelect={handleMenuSelect}
        anchorTop={menuAnchor}
        align="right"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
