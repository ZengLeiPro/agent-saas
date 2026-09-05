/**
 * 文件中心子目录页 —— 与 `/files` 共用呈现层（`FileBrowserBody`）与选择/删除逻辑，
 * 差别只在：面包屑可回跳任意上级、没有「所有文件」切换、没有 owner 过滤。
 * 管理员的根目录浏览（`root=true`）走同一页，只读不删。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, type View as RNView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FileEntry } from '@agent/shared';
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
import { useFileBrowserPrefs } from '../../src/hooks/useFileBrowserPrefs';
import { useFileEntryPress } from '../../src/hooks/useFileEntryPress';
import { useFileSelection } from '../../src/hooks/useFileSelection';
import { useAuth } from '../../src/contexts/AuthContext';
import { sortFileEntries } from '../../src/lib/fileSort';
import { hapticLight } from '../../src/lib/haptics';
import { glassFree } from '../../src/lib/headerItems';
import { BackButton } from '../../src/components/BackButton';
import { useColors, spacing } from '../../src/theme';

export default function BrowseFolderScreen() {
  const { path, owner, root } = useLocalSearchParams<{
    path: string;
    owner?: string;
    root?: string;
  }>();
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user: authUser } = useAuth();

  // 非 admin 用户即使通过 deep link 传入 root=true 也退化为普通模式
  const isRootMode = root === 'true' && authUser?.role === 'admin';
  const folderPath = path || 'assets';
  const ownerFilter = owner ?? undefined;

  const { sortPrefs, layoutMode, updateSort, updateLayoutMode } = useFileBrowserPrefs();
  const sort = sortPrefs.folder;

  const { entries: rawEntries, loading, refresh } = useFileList(
    folderPath,
    undefined,
    ownerFilter,
    isRootMode ? true : undefined,
  );
  const entries = useMemo(
    () => sortFileEntries(rawEntries, sort.key, sort.order),
    [rawEntries, sort.key, sort.order],
  );

  const selection = useFileSelection({
    owner: ownerFilter,
    root: isRootMode,
    onDeleted: refresh,
  });
  const { press } = useFileEntryPress({ owner: ownerFilter, root: isRootMode });

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

  const folderName =
    isRootMode && folderPath === '.' ? '根目录' : folderPath.split('/').pop() || '文件';

  /** 面包屑回跳：目标是当前路径的祖先就 pop，否则 push 一层新的浏览页 */
  const handleBreadcrumbNavigate = useCallback(
    (target: string) => {
      if (target === folderPath) return;
      if (folderPath.startsWith(`${target}/`) && router.canGoBack()) {
        router.back();
        return;
      }
      router.push({
        pathname: '/files/browse',
        params: {
          path: target,
          ...(ownerFilter ? { owner: ownerFilter } : {}),
          ...(isRootMode ? { root: 'true' } : {}),
        },
      });
    },
    [folderPath, ownerFilter, isRootMode, router],
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
      }),
    [sort.key, sort.order, layoutMode],
  );

  const handleMenuSelect = useCallback(
    (actionId: string) => {
      const action = parseFileMenuAction(actionId);
      if (!action) return;
      if (action.type === 'layout') updateLayoutMode(action.mode);
      else if (action.type === 'sort') updateSort('folder', nextSortState(sort, action.key));
      else if (action.type === 'refresh') void refresh();
    },
    [updateLayoutMode, updateSort, sort, refresh],
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
        <HeaderMenuButton onPress={openMenu} triggerRef={menuTriggerRef} />
      ),
    [selection, entries, openMenu],
  );

  // 根目录只读：不提供选择/删除
  const leftButton = useCallback(() => {
    if (isRootMode) return null;
    return selection.selectMode ? (
      <HeaderTextButton label="完成" onPress={selection.exitSelectMode} />
    ) : (
      <HeaderTextButton label="选择" onPress={selection.enterSelectMode} />
    );
  }, [isRootMode, selection.selectMode, selection.exitSelectMode, selection.enterSelectMode]);

  return (
    <View style={[styles.container, { backgroundColor: colors.card }]}>
      <Stack.Screen
        options={{
          title: folderName,
          headerRight: rightButton,
          unstable_headerRightItems: () => [glassFree(rightButton())],
          headerLeft: () => {
            const extra = leftButton();
            return (
              <View style={styles.headerLeft}>
                <BackButton />
                {extra}
              </View>
            );
          },
          unstable_headerLeftItems: () => {
            const extra = leftButton();
            return extra
              ? [glassFree(<BackButton />), glassFree(extra)]
              : [glassFree(<BackButton />)];
          },
        }}
      />

      <FileBreadcrumb
        currentPath={folderPath}
        rootLabel={isRootMode ? '根目录' : '文件'}
        onNavigate={handleBreadcrumbNavigate}
      />

      <FileBrowserBody
        entries={entries}
        loading={loading}
        layoutMode={layoutMode}
        onRefresh={refresh}
        onPress={handlePress}
        onDelete={isRootMode ? undefined : handleDeleteOne}
        contentPaddingBottom={selection.selectMode ? insets.bottom + 70 : insets.bottom}
        enableBackGesture
        selectMode={selection.selectMode}
        selectedPaths={selection.selectedPaths}
        onSelectToggle={selection.toggleSelect}
      />

      {selection.selectMode ? (
        <FileSelectionBar
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
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
});
