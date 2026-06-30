import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, Pressable, Alert } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DropdownMenu, type DropdownSection } from '../../../src/components/overlays/DropdownMenu';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FILE_SORT_LABELS, authFetch, getPreviewFileType, reportActivity } from '@agent/shared';
import type { FileEntry, FileSortKey, FileSortOrder } from '@agent/shared';
import { useFileList } from '../../../src/hooks/useFileList';
import { useFileOpen } from '../../../src/hooks/useFileOpen';
import { FileList } from '../../../src/components/files/FileList';
import { useColors, useTheme, spacing } from '../../../src/theme';
import { useTabBar } from '../../../src/contexts/TabBarContext';
import { useAuth } from '../../../src/contexts/AuthContext';
import { useUsers } from '../../../src/hooks/useUsers';
import { hapticLight } from '../../../src/lib/haptics';
import { glassFree } from '../../../src/lib/headerItems';

type ViewMode = 'folder' | 'all';
const VIEW_MODES: ViewMode[] = ['all', 'folder'];
const VIEW_LABELS = ['全部', '文件夹'];

const SORT_STORAGE_KEY = 'files.sort';

interface SortPrefs {
  folder: { key: FileSortKey; order: FileSortOrder };
  all: { key: FileSortKey; order: FileSortOrder };
}

const DEFAULT_SORT: SortPrefs = {
  folder: { key: 'modifiedAt', order: 'desc' },
  all: { key: 'modifiedAt', order: 'desc' },
};

function sortEntries(entries: FileEntry[], sortKey: FileSortKey, sortOrder: FileSortOrder): FileEntry[] {
  const sorted = [...entries];
  sorted.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let cmp = 0;
    switch (sortKey) {
      case 'name': cmp = a.name.localeCompare(b.name); break;
      case 'modifiedAt': cmp = a.modifiedAt - b.modifiedAt; break;
      case 'size': cmp = a.size - b.size; break;
      case 'extension': cmp = a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name); break;
    }
    return sortOrder === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

export default function FilesScreen() {
  useFocusEffect(useCallback(() => { reportActivity('page_viewed', { detail: '文件管理' }); }, []));
  const colors = useColors();
  const { isDark } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { setTabBarHidden } = useTabBar();
  const { user: authUser } = useAuth();
  const isAdmin = authUser?.role === 'admin';
  const { users } = useUsers();
  const [ownerFilter, setOwnerFilter] = useState<string | null>(authUser?.username ?? null);
  // authUser 异步加载完成后同步默认值
  useEffect(() => {
    if (authUser?.username && ownerFilter === null) {
      setOwnerFilter(authUser.username);
    }
  }, [authUser?.username]);
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [sortPrefs, setSortPrefs] = useState<SortPrefs>(DEFAULT_SORT);

  // Multi-select state
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const selectedCount = selectedPaths.size;
  const hasSelection = selectedCount > 0;

  // 启动时从 AsyncStorage 恢复排序偏好
  useEffect(() => {
    AsyncStorage.getItem(SORT_STORAGE_KEY).then(raw => {
      if (raw) {
        try {
          const saved = JSON.parse(raw) as Partial<SortPrefs>;
          setSortPrefs(prev => ({
            folder: { ...prev.folder, ...saved.folder },
            all: { ...prev.all, ...saved.all },
          }));
        } catch { /* ignore */ }
      }
    }).catch(() => {});
  }, []);

  const sortKey = sortPrefs[viewMode].key;
  const sortOrder = sortPrefs[viewMode].order;

  const updateSort = useCallback((mode: ViewMode, key: FileSortKey, order: FileSortOrder) => {
    setSortPrefs(prev => {
      const next = { ...prev, [mode]: { key, order } };
      AsyncStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const { open: openFile } = useFileOpen();

  const { entries: rawEntries, loading, refresh } = useFileList(
    'assets',
    viewMode === 'all',
    isAdmin ? (ownerFilter ?? undefined) : undefined,
  );

  const entries = useMemo(
    () => sortEntries(rawEntries, sortKey, sortOrder),
    [rawEntries, sortKey, sortOrder],
  );

  const toggleSelect = useCallback((path: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const enterSelectMode = useCallback(() => {
    hapticLight();
    setIsSelectMode(true);
    setSelectedPaths(new Set());
    requestAnimationFrame(() => setTabBarHidden(true));
  }, [setTabBarHidden]);

  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedPaths(new Set());
    requestAnimationFrame(() => setTabBarHidden(false));
  }, [setTabBarHidden]);

  const handleToggleAll = useCallback(() => {
    hapticLight();
    if (selectedPaths.size === entries.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(entries.map(e => e.path)));
    }
  }, [selectedPaths.size, entries]);

  const handleBatchMove = useCallback(() => {
    Alert.alert('正在开发中', '移动功能即将上线');
  }, []);

  const handleBatchDelete = useCallback(() => {
    if (!hasSelection) return;
    Alert.alert('正在开发中', '批量删除功能即将上线');
  }, [hasSelection]);

  const handleDelete = useCallback((entry: FileEntry) => {
    const typeLabel = entry.isDirectory ? '文件夹' : '文件';
    Alert.alert(
      `删除${typeLabel}`,
      `确定要删除 ${entry.name} 吗？${entry.isDirectory ? '文件夹内的所有内容都将被删除。' : ''}此操作不可撤销。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            try {
              const params = new URLSearchParams({ path: entry.path });
              if (ownerFilter) params.set('owner', ownerFilter);
              const res = await authFetch(`/api/file/delete?${params}`, { method: 'DELETE' });
              if (res.ok) {
                await refresh();
              } else {
                Alert.alert('错误', '删除失败');
              }
            } catch {
              Alert.alert('错误', '删除失败');
            }
          },
        },
      ],
    );
  }, [refresh]);

  const handleEntryPress = useCallback(async (entry: FileEntry) => {
    if (entry.isDirectory) {
      router.push({ pathname: '/(tabs)/files/browse', params: { path: entry.path, ...(ownerFilter ? { owner: ownerFilter } : {}) } });
      return;
    }

    const previewType = getPreviewFileType(entry.name);
    if (previewType) {
      const screen = previewType === 'html' ? '/chat/html-preview' : '/chat/markdown-preview';
      router.push({ pathname: screen, params: { filePath: entry.path, ...(ownerFilter ? { owner: ownerFilter } : {}) } });
      return;
    }

    await openFile({
      path: entry.path,
      modifiedAt: entry.modifiedAt,
      size: entry.size,
      owner: ownerFilter ?? undefined,
    });
  }, [router, ownerFilter, openFile]);

  const containerStyle = useMemo(() => ({
    flex: 1,
    backgroundColor: colors.card,
  }), [colors.card]);

  const [headerMenuVisible, setHeaderMenuVisible] = useState(false);
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState(0);
  const headerMenuTriggerRef = useRef<View>(null);

  const handleOpenHeaderMenu = useCallback(() => {
    hapticLight();
    headerMenuTriggerRef.current?.measureInWindow((_x, y, _w, h) => {
      setHeaderMenuAnchor(y + h);
      setHeaderMenuVisible(true);
    });
  }, []);

  const menuSections = useMemo<DropdownSection[]>(() => {
    const keys: FileSortKey[] = ['name', 'modifiedAt', 'size', 'extension'];
    const sortSection: DropdownSection = {
      id: '_sort_section',
      label: `排序 (${sortOrder === 'asc' ? '升序' : '降序'})`,
      actions: keys.map(k => {
        const isActive = sortKey === k;
        const arrow = isActive ? (sortOrder === 'asc' ? ' ↑' : ' ↓') : '';
        return {
          id: k,
          label: `${FILE_SORT_LABELS[k]}${arrow}`,
          checked: isActive,
        };
      }),
    };

    const sections: DropdownSection[] = [sortSection];

    if (isAdmin) {
      sections.push({
        id: '_nav_section',
        actions: [{ id: '_root', label: '根目录' }],
      });
    }

    if (isAdmin && users.length > 0) {
      sections.push({
        id: '_owner_section',
        actions: users.map(u => ({
          id: `_owner:${u.username}`,
          label: u.realName || u.username,
          checked: ownerFilter === u.username,
        })),
      });
    }

    return sections;
  }, [sortKey, sortOrder, isAdmin, users, ownerFilter]);

  const handleMenuSelect = useCallback((actionId: string) => {
    if (actionId === '_root') {
      router.push({ pathname: '/(tabs)/files/browse', params: { path: '.', root: 'true' } });
      return;
    }

    if (actionId.startsWith('_owner:')) {
      const username = actionId.slice('_owner:'.length);
      setOwnerFilter(username || null);
      return;
    }

    const key = actionId as FileSortKey;
    if (key === sortKey) {
      updateSort(viewMode, key, sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      updateSort(viewMode, key, key === 'modifiedAt' ? 'desc' : 'asc');
    }
  }, [sortKey, sortOrder, viewMode, updateSort, router]);

  const headerTextStyle = { fontSize: 17, color: colors.foreground };

  return (
    <View style={containerStyle}>
      <Stack.Screen
        options={{
          title: '',
          headerLeft: () => (
            <TouchableOpacity
              onPress={isSelectMode ? exitSelectMode : enterSelectMode}
              activeOpacity={0.7}
            >
              <Text style={headerTextStyle}>
                {isSelectMode ? '完成' : '选择'}
              </Text>
            </TouchableOpacity>
          ),
          unstable_headerLeftItems: () => [glassFree(
            <TouchableOpacity
              onPress={isSelectMode ? exitSelectMode : enterSelectMode}
              activeOpacity={0.7}
            >
              <Text style={headerTextStyle}>
                {isSelectMode ? '完成' : '选择'}
              </Text>
            </TouchableOpacity>
          )],
          headerTitle: () =>
            isSelectMode ? (
              <Text style={{ fontSize: 17, fontWeight: '600', color: colors.foreground }}>
                {hasSelection ? `已选择 ${selectedCount} 项` : '选择项目'}
              </Text>
            ) : (
              <SegmentedControl
                values={VIEW_LABELS}
                selectedIndex={VIEW_MODES.indexOf(viewMode)}
                onChange={(e) => setViewMode(VIEW_MODES[e.nativeEvent.selectedSegmentIndex])}
                style={{ width: 160, height: 40, marginTop: -8}}
              />
            ),
          headerRight: () =>
            isSelectMode ? (
              <TouchableOpacity onPress={handleToggleAll} activeOpacity={0.7}>
                <Text style={headerTextStyle}>
                  {selectedPaths.size === entries.length && entries.length > 0 ? '取消全选' : '全选'}
                </Text>
              </TouchableOpacity>
            ) : (
              <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu}>
                <Ionicons name="ellipsis-horizontal" size={22} color={colors.foreground} />
              </Pressable>
            ),
          unstable_headerRightItems: () => isSelectMode
            ? [glassFree(
                <TouchableOpacity onPress={handleToggleAll} activeOpacity={0.7}>
                  <Text style={headerTextStyle}>
                    {selectedPaths.size === entries.length && entries.length > 0 ? '取消全选' : '全选'}
                  </Text>
                </TouchableOpacity>
              )]
            : [glassFree(
                <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu}>
                  <Ionicons name="ellipsis-horizontal" size={22} color={colors.foreground} />
                </Pressable>
              )],
        }}
      />
      <FileList
        key={`${viewMode}-${sortKey}-${sortOrder}${isSelectMode ? '-select' : ''}`}
        entries={entries}
        loading={loading}
        onRefresh={refresh}
        onPress={(entry) => { void handleEntryPress(entry); }}
        onDelete={handleDelete}
        contentPaddingBottom={isSelectMode ? insets.bottom + 70 : insets.bottom}
        showPath={viewMode === 'all'}
        selectMode={isSelectMode}
        selectedPaths={selectedPaths}
        onSelectToggle={toggleSelect}
      />

      {isSelectMode && (
        <View style={{
          position: 'absolute',
          bottom: insets.bottom + 8,
          left: spacing.lg,
          right: spacing.lg,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          zIndex: 100,
        }}>
          <TouchableOpacity onPress={handleBatchMove} disabled={!hasSelection} activeOpacity={0.7}>
            {renderGlass(
              { alignItems: 'center', justifyContent: 'center', height: 50, paddingHorizontal: 22, borderRadius: 25 },
              <Text style={{ fontSize: 17, fontWeight: '600', color: colors.foreground }}>
                移动{hasSelection ? ` (${selectedCount})` : ''}
              </Text>,
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={handleBatchDelete} disabled={!hasSelection} activeOpacity={0.7}>
            {renderGlass(
              { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
              <Ionicons name="trash" size={24} color={hasSelection ? colors.destructive : colors.foreground} />,
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Header dropdown menu */}
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

  function renderGlass(style: any, children: React.ReactNode) {
    return <View style={[style, { backgroundColor: colors.muted }]}>{children}</View>;
  }
}
