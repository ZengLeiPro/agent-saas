/**
 * 文件中心首页 —— 对齐 Web `FileBrowser`：
 * 文件夹视图 / 所有文件（recursive）切换、列表 / 网格布局切换（偏好持久化）、
 * 面包屑、下拉刷新、多选删除（ActionSheet 二次确认）、空态与骨架。
 * 管理员额外有根目录入口与 owner 过滤（`useUsers` 只读列表）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, type View as RNView } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { reportActivity, type FileEntry } from '@agent/shared';
import { DropdownMenu } from '../../src/components/overlays/DropdownMenu';
import { FileBreadcrumb } from '../../src/components/files/FileBreadcrumb';
import { FileBrowserBody } from '../../src/components/files/FileBrowserBody';
import { FileSelectionBar } from '../../src/components/files/FileSelectionBar';
import {
  HeaderMenuButton,
  HeaderTextButton,
} from '../../src/components/files/fileHeaderItems';
import {
  buildFileMenuSections,
  nextSortState,
  parseFileMenuAction,
} from '../../src/components/files/fileMenuSections';
import { useFileList } from '../../src/hooks/useFileList';
import { useFileBrowserPrefs, type FileViewMode } from '../../src/hooks/useFileBrowserPrefs';
import { useFileEntryPress } from '../../src/hooks/useFileEntryPress';
import { useFileSelection } from '../../src/hooks/useFileSelection';
import { useUsers } from '../../src/hooks/useUsers';
import { useAuth } from '../../src/contexts/AuthContext';
import { sortFileEntries } from '../../src/lib/fileSort';
import { hapticLight } from '../../src/lib/haptics';
import { glassFree } from '../../src/lib/headerItems';
import { useColors } from '../../src/theme';

const ROOT_PATH = 'assets';
const VIEW_MODES: FileViewMode[] = ['all', 'folder'];
const VIEW_LABELS = ['全部', '文件夹'];
/** 与 Web 的分段控件宽度观感对齐 */
const SEGMENT_STYLE = { width: 160, height: 40, marginTop: -8 } as const;

export default function FilesScreen() {
  useFocusEffect(
    useCallback(() => {
      reportActivity('page_viewed', { detail: '文件中心' });
    }, []),
  );

  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user: authUser } = useAuth();
  const isAdmin = authUser?.role === 'admin';
  const { users } = useUsers(isAdmin);

  const [ownerFilter, setOwnerFilter] = useState<string | null>(authUser?.username ?? null);
  // authUser 异步加载完成后同步默认值
  useEffect(() => {
    if (authUser?.username && ownerFilter === null) setOwnerFilter(authUser.username);
  }, [authUser?.username, ownerFilter]);

  const [viewMode, setViewMode] = useState<FileViewMode>('folder');
  const { sortPrefs, layoutMode, updateSort, updateLayoutMode } = useFileBrowserPrefs();
  const sort = sortPrefs[viewMode];

  const effectiveOwner = isAdmin ? (ownerFilter ?? undefined) : undefined;
  const { entries: rawEntries, loading, refresh } = useFileList(
    ROOT_PATH,
    viewMode === 'all',
    effectiveOwner,
  );
  const entries = useMemo(
    () => sortFileEntries(rawEntries, sort.key, sort.order),
    [rawEntries, sort.key, sort.order],
  );

  const selection = useFileSelection({ owner: effectiveOwner, onDeleted: refresh });
  const { press } = useFileEntryPress({ owner: effectiveOwner });

  const handlePress = useCallback(
    (entry: FileEntry) => {
      void press(entry);
    },
    [press],
  );

  const handleDeleteOne = useCallback(
    (entry: FileEntry) => selection.confirmDelete([entry]),
    [selection],
  );

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selection.selectedPaths.has(entry.path)),
    [entries, selection.selectedPaths],
  );

  // ── 头部下拉菜单 ────────────────────────────────────────────────
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState(0);
  const menuTriggerRef = useRef<RNView>(null);

  const openMenu = useCallback(() => {
    hapticLight();
    menuTriggerRef.current?.measureInWindow((_x, y, _w, h) => {
      setMenuAnchor(y + h);
      setMenuVisible(true);
    });
  }, []);

  const menuSections = useMemo(
    () =>
      buildFileMenuSections({
        sortKey: sort.key,
        sortOrder: sort.order,
        layoutMode,
        isAdmin,
        users,
        ownerFilter,
        includeRootEntry: true,
      }),
    [sort.key, sort.order, layoutMode, isAdmin, users, ownerFilter],
  );

  const handleMenuSelect = useCallback(
    (actionId: string) => {
      const action = parseFileMenuAction(actionId);
      if (!action) return;
      switch (action.type) {
        case 'layout':
          updateLayoutMode(action.mode);
          return;
        case 'sort':
          updateSort(viewMode, nextSortState(sort, action.key));
          return;
        case 'refresh':
          void refresh();
          return;
        case 'root':
          router.push({ pathname: '/files/browse', params: { path: '.', root: 'true' } });
          return;
        case 'owner':
          setOwnerFilter(action.username);
      }
    },
    [updateLayoutMode, updateSort, viewMode, sort, refresh, router],
  );

  const headerTitle = useCallback(
    () => (
      <SegmentedControl
        values={VIEW_LABELS}
        selectedIndex={VIEW_MODES.indexOf(viewMode)}
        onChange={(event) =>
          setViewMode(VIEW_MODES[event.nativeEvent.selectedSegmentIndex])
        }
        style={SEGMENT_STYLE}
      />
    ),
    [viewMode],
  );

  const leftButton = useCallback(
    () =>
      selection.selectMode ? (
        <HeaderTextButton label="完成" onPress={selection.exitSelectMode} />
      ) : (
        <HeaderTextButton
          label="选择"
          onPress={selection.enterSelectMode}
          testID="files-select-button"
        />
      ),
    [selection.selectMode, selection.exitSelectMode, selection.enterSelectMode],
  );

  const rightButton = useCallback(
    () =>
      selection.selectMode ? (
        <HeaderTextButton
          label={
            selection.selectedCount === entries.length && entries.length > 0
              ? '取消全选'
              : '全选'
          }
          onPress={() => selection.toggleSelectAll(entries)}
        />
      ) : (
        <HeaderMenuButton
          onPress={openMenu}
          triggerRef={menuTriggerRef}
          testID="files-menu-button"
        />
      ),
    [selection, entries, openMenu],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.card }]} testID="files-screen">
      <Stack.Screen
        options={{
          title: '',
          headerTitle,
          headerLeft: leftButton,
          unstable_headerLeftItems: () => [glassFree(leftButton())],
          headerRight: rightButton,
          unstable_headerRightItems: () => [glassFree(rightButton())],
        }}
      />

      {viewMode === 'folder' ? (
        <FileBreadcrumb currentPath={ROOT_PATH} onNavigate={() => {}} />
      ) : null}

      <FileBrowserBody
        entries={entries}
        loading={loading}
        layoutMode={layoutMode}
        onRefresh={refresh}
        onPress={handlePress}
        onDelete={handleDeleteOne}
        contentPaddingBottom={selection.selectMode ? insets.bottom + 70 : insets.bottom}
        showPath={viewMode === 'all'}
        emptyVariant={viewMode}
        selectMode={selection.selectMode}
        selectedPaths={selection.selectedPaths}
        onSelectToggle={selection.toggleSelect}
      />

      {selection.selectMode ? (
        <FileSelectionBar
          testID="files-delete-selected"
          selectedCount={selection.selectedCount}
          onDelete={() => selection.confirmDelete(selectedEntries)}
          bottomInset={insets.bottom}
        />
      ) : null}

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
  container: {
    flex: 1,
  },
});
