/**
 * Memory folder browser body.
 * - screen route: stack push on folder drill (phone / deep link)
 * - embedded md+: in-pane path updates (no stack push)
 */
import React, { useCallback, useMemo } from 'react';
import { Alert, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { X } from 'lucide-react-native';
import { getPreviewFileType } from '@agent/shared';
import type { FileEntry } from '@agent/shared';
import { useFileList } from '../../hooks/useFileList';
import { useFileOpen } from '../../hooks/useFileOpen';
import { FileList } from '../files/FileList';
import { useColors, spacing, fontScale } from '../../theme';
import { glassFree } from '../../lib/headerItems';
import { BackButton } from '../BackButton';

export type MemoryBrowserBodyProps = {
  path?: string;
  owner?: string;
  embedded?: boolean;
  onPathChange?: (path: string) => void;
  onRequestClose?: () => void;
};

export function MemoryBrowserBody({
  path,
  owner,
  embedded = false,
  onPathChange,
  onRequestClose,
}: MemoryBrowserBodyProps) {
  const colors = useColors();
  const router = useRouter();
  const { open: openFile } = useFileOpen();
  const folderPath = path || 'memory';
  const { entries, loading, refresh } = useFileList(folderPath, undefined, owner ?? undefined);

  const sorted = useMemo(() => {
    const list = [...entries];
    list.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [entries]);

  const folderName = folderPath === 'memory' ? '日常记忆' : folderPath.split('/').pop() || '记忆';

  const handleEntryPress = useCallback(
    async (entry: FileEntry) => {
      if (entry.isDirectory) {
        if (embedded && onPathChange) {
          onPathChange(entry.path);
          return;
        }
        router.push({
          pathname: '/memory-browser',
          params: { path: entry.path, ...(owner ? { owner } : {}) },
        });
        return;
      }

      const previewType = getPreviewFileType(entry.name);
      if (previewType === 'html') {
        Alert.alert(
          '旧预览已停用',
          'Mobile V1 不打开 workspace HTML。正式交付请使用 Artifact viewer。',
        );
        return;
      }
      if (previewType === 'md') {
        router.push({
          pathname: '/chat/markdown-preview',
          params: { filePath: entry.path, ...(owner ? { owner } : {}) },
        });
        return;
      }

      await openFile({
        path: entry.path,
        modifiedAt: entry.modifiedAt,
        size: entry.size,
        owner: owner ?? undefined,
      });
    },
    [router, owner, openFile, embedded, onPathChange],
  );

  return (
    <View
      style={{ flex: 1, backgroundColor: colors.background }}
      testID={embedded ? 'memory-browser-pane' : 'memory-browser-screen'}
    >
      {embedded ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            minHeight: 48,
            paddingHorizontal: spacing.sm,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border,
            gap: spacing.sm,
          }}
          testID="memory-browser-embedded-chrome"
        >
          <TouchableOpacity
            onPress={() => onRequestClose?.()}
            hitSlop={8}
            accessibilityLabel="返回"
          >
            <X size={22} color={colors.foreground} strokeWidth={2} />
          </TouchableOpacity>
          <Text
            style={{ flex: 1, ...fontScale.base, color: colors.foreground, fontWeight: '600' }}
            numberOfLines={1}
          >
            {folderName}
          </Text>
        </View>
      ) : (
        <Stack.Screen
          options={{
            title: folderName,
            headerBackTitle: ' ',
            unstable_headerLeftItems: () => [glassFree(<BackButton />)],
          }}
        />
      )}
      <FileList
        entries={sorted}
        loading={loading}
        onRefresh={refresh}
        onPress={(entry) => {
          void handleEntryPress(entry);
        }}
        enableBackGesture
      />
    </View>
  );
}
