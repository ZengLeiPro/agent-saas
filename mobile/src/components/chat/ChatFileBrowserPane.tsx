/**
 * Compact workspace file browser for chat md+ right slot (web FileBrowser pane).
 * Reuses FileBrowserBody / FileBreadcrumb / useFileList — no second file stack.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FileBreadcrumb } from '../files/FileBreadcrumb';
import { FileBrowserBody } from '../files/FileBrowserBody';
import { useFileBrowserPrefs } from '../../hooks/useFileBrowserPrefs';
import { useFileEntryPress } from '../../hooks/useFileEntryPress';
import { useFileList } from '../../hooks/useFileList';
import { FILES_USER_ROOT } from '../../lib/fileEntryPress';
import { sortFileEntries } from '../../lib/fileSort';
import type { ChatRightFilePreviewRequest } from './blocks/ChatRightSlotContext';
import { useColors, spacing } from '../../theme';

export type ChatFileBrowserPaneProps = {
  onOpenPreview: (request: ChatRightFilePreviewRequest) => void;
  owner?: string;
  testID?: string;
};

export function ChatFileBrowserPane({
  onOpenPreview,
  owner,
  testID = 'chat-file-browser',
}: ChatFileBrowserPaneProps) {
  const colors = useColors();
  const [browsePath, setBrowsePath] = useState(FILES_USER_ROOT);
  const { layoutMode, sortPrefs } = useFileBrowserPrefs();
  const sort = sortPrefs.folder;
  const list = useFileList(browsePath, false, owner);
  const entries = useMemo(
    () => sortFileEntries(list.entries, sort.key, sort.order),
    [list.entries, sort.key, sort.order],
  );

  const { press } = useFileEntryPress({
    owner,
    onOpenFolder: (path) => {
      setBrowsePath(path);
      return true;
    },
    onOpenPreview: (target) => {
      onOpenPreview({
        route: target.route,
        filePath: target.filePath,
        name: target.name,
        size: target.size,
        modifiedAt: target.modifiedAt,
      });
      return true;
    },
  });

  const handleRefresh = useCallback(async () => {
    await list.refresh();
  }, [list]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: colors.card },
        crumb: { paddingHorizontal: spacing.sm },
      }),
    [colors],
  );

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.crumb}>
        <FileBreadcrumb currentPath={browsePath} onNavigate={setBrowsePath} />
      </View>
      <FileBrowserBody
        entries={entries}
        loading={list.loading}
        loadingMore={list.loadingMore}
        error={list.error}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        layoutMode={layoutMode === 'grid' ? 'list' : layoutMode}
        onRefresh={handleRefresh}
        onPress={(entry) => {
          void press(entry);
        }}
        emptyVariant="folder"
      />
    </View>
  );
}
