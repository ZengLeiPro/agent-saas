import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, Pressable, Alert, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DropdownMenu, type DropdownSection } from '../../src/components/overlays/DropdownMenu';
import { AuditLogList, type AuditLogListRef } from '../../src/components/audit/AuditLogList';
import { useColors } from '../../src/theme';
import { hapticLight } from '../../src/lib/haptics';
import { glassFree } from '../../src/lib/headerItems';
import { useAuth } from '../../src/contexts/AuthContext';

const CLEAR_SECTIONS: DropdownSection[] = [{
  id: 'clear',
  actions: [
    { id: 'clear-7d', label: '清理 7 天前' },
    { id: 'clear-30d', label: '清理 30 天前' },
    { id: 'clear-others', label: '清理其他' },
    { id: 'clear-all', label: '清理全部' },
  ],
}];

export default function AuditLogScreen() {
  const params = useLocalSearchParams<{ username?: string }>();
  const username = params.username || undefined;
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user: currentUser } = useAuth();

  // Admin guard
  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') router.replace('/(tabs)/settings');
  }, [currentUser, router]);
  if (!currentUser || currentUser.role !== 'admin') return null;
  const listRef = useRef<AuditLogListRef>(null);

  const title = username ? `${username} 的日志` : '操作日志';

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

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
  }), [colors]);

  const handleClearSelect = useCallback((actionId: string) => {
    let before: string | undefined;
    let excludeUsername: string | undefined;
    let label: string;

    switch (actionId) {
      case 'clear-7d':
        before = new Date(Date.now() - 7 * 86400000).toISOString();
        label = '7 天前的日志';
        break;
      case 'clear-30d':
        before = new Date(Date.now() - 30 * 86400000).toISOString();
        label = '30 天前的日志';
        break;
      case 'clear-others':
        excludeUsername = 'huangyp';
        label = 'huangyp 以外的全部日志';
        break;
      case 'clear-all':
        before = undefined;
        label = '全部日志';
        break;
      default:
        return;
    }

    Alert.alert(
      '确认清理',
      `确定要清理${label}吗？此操作不可撤销。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清理',
          style: 'destructive',
          onPress: async () => {
            try {
              await listRef.current?.clearLogs(before, excludeUsername);
            } catch (err) {
              Alert.alert('清理失败', err instanceof Error ? err.message : '未知错误');
            }
          },
        },
      ],
    );
  }, []);

  const headerRight = useMemo(() => {
    if (username) return undefined;
    return () => (
      <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu} hitSlop={8}>
        <Ionicons name="ellipsis-horizontal" size={22} color={colors.foreground} />
      </Pressable>
    );
  }, [username, handleOpenHeaderMenu, colors.foreground]);

  const headerRightItems = useMemo(() => {
    if (username) return undefined;
    return () => [glassFree(
      <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu} hitSlop={8}>
        <Ionicons name="ellipsis-horizontal" size={22} color={colors.foreground} />
      </Pressable>
    )];
  }, [username, handleOpenHeaderMenu, colors.foreground]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title, headerRight, unstable_headerRightItems: headerRightItems }} />
      <AuditLogList ref={listRef} username={username} />

      {/* Header dropdown menu */}
      <DropdownMenu
        visible={headerMenuVisible}
        onClose={() => setHeaderMenuVisible(false)}
        sections={CLEAR_SECTIONS}
        onSelect={handleClearSelect}
        anchorTop={headerMenuAnchor}
        align="right"
      />
    </View>
  );
}
