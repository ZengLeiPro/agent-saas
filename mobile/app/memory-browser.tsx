import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { getPreviewFileType } from '@agent/shared';
import type { FileEntry } from '@agent/shared';
import { useFileList } from '../src/hooks/useFileList';
import { useFileOpen } from '../src/hooks/useFileOpen';
import { FileList } from '../src/components/files/FileList';
import { useColors } from '../src/theme';
import { glassFree } from '../src/lib/headerItems';
import { BackButton } from '../src/components/BackButton';

export default function MemoryBrowserScreen() {
  const { path, owner } = useLocalSearchParams<{ path: string; owner?: string }>();
  const colors = useColors();
  const router = useRouter();

  const { open: openFile } = useFileOpen();

  const folderPath = path || 'memory';
  const { entries, loading, refresh } = useFileList(folderPath, undefined, owner ?? undefined);

  // Sort: directories first, then by name
  const sorted = useMemo(() => {
    const list = [...entries];
    list.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [entries]);

  const folderName = folderPath === 'memory' ? '日常记忆' : folderPath.split('/').pop() || '记忆';

  const handleEntryPress = useCallback(async (entry: FileEntry) => {
    if (entry.isDirectory) {
      router.push({ pathname: '/memory-browser', params: { path: entry.path, ...(owner ? { owner } : {}) } });
      return;
    }

    const previewType = getPreviewFileType(entry.name);
    if (previewType) {
      const screen = previewType === 'html' ? '/chat/html-preview' : '/chat/markdown-preview';
      router.push({ pathname: screen, params: { filePath: entry.path, ...(owner ? { owner } : {}) } });
      return;
    }

    await openFile({
      path: entry.path,
      modifiedAt: entry.modifiedAt,
      size: entry.size,
      owner: owner ?? undefined,
    });
  }, [router, owner, openFile]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{
        title: folderName,
        headerBackTitle: ' ',
        unstable_headerLeftItems: () => [glassFree(
          <BackButton />
        )],
      }} />
      <FileList
        entries={sorted}
        loading={loading}
        onRefresh={refresh}
        onPress={(entry) => { void handleEntryPress(entry); }}
        enableBackGesture
      />
    </View>
  );
}
