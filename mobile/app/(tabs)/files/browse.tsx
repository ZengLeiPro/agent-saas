import React, { useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, Pressable, Alert } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DropdownMenu, type DropdownSection } from '../../../src/components/overlays/DropdownMenu';
import { FILE_SORT_LABELS, authFetch, getPreviewFileType } from '@agent/shared';
import type { FileEntry, FileSortKey, FileSortOrder } from '@agent/shared';
import { useFileList } from '../../../src/hooks/useFileList';
import { useFileOpen } from '../../../src/hooks/useFileOpen';
import { FileList } from '../../../src/components/files/FileList';
import { useColors, useTheme, spacing } from '../../../src/theme';
import { useTabBar } from '../../../src/contexts/TabBarContext';
import { useAuth } from '../../../src/contexts/AuthContext';
import { hapticLight } from '../../../src/lib/haptics';
import { glassFree } from '../../../src/lib/headerItems';

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

export default function BrowseFolderScreen() {
  const { path, owner, root } = useLocalSearchParams<{ path: string; owner?: string; root?: string }>();
  const colors = useColors();
  const { isDark } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { setTabBarHidden } = useTabBar();
  const { user: authUser } = useAuth();
  const ownerFilter = owner ?? null;
  const [sortKey, setSortKey] = useState<FileSortKey>('name');
  const [sortOrder, setSortOrder] = useState<FileSortOrder>('asc');

  // Multi-select state
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const selectedCount = selectedPaths.size;
  const hasSelection = selectedCount > 0;

  const { open: openFile } = useFileOpen();

  // 非 admin 用户即使通过 deep link 传入 root=true 也退化为普通模式
  const isRootMode = root === 'true' && authUser?.role === 'admin';
  const folderPath = path || 'assets';
  const { entries: rawEntries, loading, refresh } = useFileList(
    folderPath,
    undefined,
    ownerFilter ?? undefined,
    isRootMode ? true : undefined,
  );

  const entries = useMemo(
    () => sortEntries(rawEntries, sortKey, sortOrder),
    [rawEntries, sortKey, sortOrder],
  );

  const folderName = (isRootMode && folderPath === '.') ? '根目录' : (folderPath.split('/').pop() || '文件');

  const toggleSelect = useCallback((p: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
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
      router.push({ pathname: '/(tabs)/files/browse', params: { path: entry.path, ...(ownerFilter ? { owner: ownerFilter } : {}), ...(isRootMode ? { root: 'true' } : {}) } });
      return;
    }

    const previewType = getPreviewFileType(entry.name);
    if (previewType) {
      const screen = previewType === 'html' ? '/chat/html-preview' : '/chat/markdown-preview';
      router.push({ pathname: screen, params: { filePath: entry.path, ...(ownerFilter ? { owner: ownerFilter } : {}), ...(isRootMode ? { root: 'true' } : {}) } });
      return;
    }

    await openFile({
      path: entry.path,
      modifiedAt: entry.modifiedAt,
      size: entry.size,
      owner: ownerFilter ?? undefined,
      root: isRootMode || undefined,
    });
  }, [router, ownerFilter, openFile, isRootMode]);

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
    return [{
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
    }];
  }, [sortKey, sortOrder]);

  const handleMenuSelect = useCallback((actionId: string) => {
    const key = actionId as FileSortKey;
    if (key === sortKey) {
      setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortOrder(key === 'modifiedAt' ? 'desc' : 'asc');
    }
  }, [sortKey]);

  const headerTextStyle = { fontSize: 17, color: colors.foreground };

  return (
    <View style={containerStyle}>
      <Stack.Screen
        options={{
          title: folderName,
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
          headerBackVisible: false,
          headerLeft: isRootMode
            ? () => (
                <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7} style={{ padding: 4 }}>
                  <Feather name="chevron-left" size={22} color={colors.foreground} />
                </TouchableOpacity>
              )
            : () => isSelectMode ? (
                <TouchableOpacity onPress={exitSelectMode} activeOpacity={0.7}>
                  <Text style={headerTextStyle}>完成</Text>
                </TouchableOpacity>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7} style={{ padding: 4 }}>
                    <Feather name="chevron-left" size={22} color={colors.foreground} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={enterSelectMode} activeOpacity={0.7}>
                    <Text style={headerTextStyle}>选择</Text>
                  </TouchableOpacity>
                </View>
              ),
          unstable_headerLeftItems: isRootMode
            ? () => [glassFree(
                <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7} style={{ padding: 4 }}>
                  <Feather name="chevron-left" size={22} color={colors.foreground} />
                </TouchableOpacity>
              )]
            : () => isSelectMode
              ? [glassFree(
                  <TouchableOpacity onPress={exitSelectMode} activeOpacity={0.7}>
                    <Text style={headerTextStyle}>完成</Text>
                  </TouchableOpacity>
                )]
              : [
                  glassFree(
                    <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7} style={{ padding: 4 }}>
                      <Feather name="chevron-left" size={22} color={colors.foreground} />
                    </TouchableOpacity>
                  ),
                  glassFree(
                    <TouchableOpacity onPress={enterSelectMode} activeOpacity={0.7}>
                      <Text style={headerTextStyle}>选择</Text>
                    </TouchableOpacity>
                  ),
                ],
        }}
      />
      <FileList
        key={`${sortKey}-${sortOrder}${isSelectMode ? '-select' : ''}`}
        entries={entries}
        loading={loading}
        onRefresh={refresh}
        onPress={(entry) => { void handleEntryPress(entry); }}
        onDelete={isRootMode ? undefined : handleDelete}
        contentPaddingBottom={isSelectMode ? insets.bottom + 70 : insets.bottom}
        enableBackGesture
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
