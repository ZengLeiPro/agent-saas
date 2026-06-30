import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  Pressable,
  RefreshControl,
  StyleSheet,
} from 'react-native';
import { Image } from 'expo-image';
import { FlashList } from '@shopify/flash-list';
import type { UserInfo } from '@agent/shared';
import { formatShortDate } from '@agent/shared';
import { getServerUrl } from '../../platform/mobileConfig';
import { useColors, spacing, typography, radius } from '../../theme';

interface Props {
  users: UserInfo[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onSelect: (user: UserInfo) => void;
}

export function UserList({ users, loading, onRefresh, onSelect }: Props) {
  const colors = useColors();

  const styles = useMemo(() => StyleSheet.create({
    rowContainer: {
      borderRadius: radius.md,
      overflow: 'hidden',
      marginBottom: spacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      backgroundColor: colors.background,
      gap: spacing.md,
    },
    rowPressed: {
      backgroundColor: colors.accent,
    },
    avatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
    },
    avatarPlaceholder: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: {
      color: colors.primaryForeground,
      fontSize: 13,
      fontWeight: '600',
    },
    info: {
      flex: 1,
    },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    username: {
      ...typography.body,
      color: colors.foreground,
      fontWeight: '500',
    },
    realName: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: 2,
    },
    roleBadge: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: radius.sm,
    },
    adminBadge: {
      backgroundColor: colors.secondary,
    },
    userBadge: {
      backgroundColor: colors.muted,
    },
    roleText: {
      fontSize: 11,
      fontWeight: '500',
    },
    adminText: {
      color: colors.primary,
    },
    userText: {
      color: colors.mutedForeground,
    },
    date: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    empty: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 80,
    },
    emptyText: {
      ...typography.body,
      color: colors.mutedForeground,
    },
    disabledBadge: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: radius.sm,
      backgroundColor: colors.errorBg,
    },
    disabledText: {
      fontSize: 11,
      fontWeight: '500',
      color: colors.destructive,
    },
  }), [colors]);

  const renderItem = useCallback(({ item }: { item: UserInfo }) => {
    const avatarUri = item.avatar ? `${getServerUrl()}${item.avatar}` : null;
    const initial = (item.username || 'U').charAt(0).toUpperCase();

    return (
      <View style={styles.rowContainer}>
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed, item.disabled && { opacity: 0.5 }]}
          onPress={() => onSelect(item)}
        >
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={styles.avatar} cachePolicy="disk" />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarText}>{initial}</Text>
            </View>
          )}
          <View style={styles.info}>
            <View style={styles.nameRow}>
              <Text style={styles.username} numberOfLines={1}>{item.username}</Text>
              {item.realName ? (
                <Text style={styles.realName} numberOfLines={1}>{item.realName}</Text>
              ) : null}
            </View>
            <View style={styles.metaRow}>
              <View style={[styles.roleBadge, item.role === 'admin' ? styles.adminBadge : styles.userBadge]}>
                <Text style={[styles.roleText, item.role === 'admin' ? styles.adminText : styles.userText]}>
                  {item.role === 'admin' ? '管理员' : '用户'}
                </Text>
              </View>
              {item.disabled && (
                <View style={styles.disabledBadge}>
                  <Text style={styles.disabledText}>已禁用</Text>
                </View>
              )}
              <Text style={styles.date}>{formatShortDate(new Date(item.createdAt).getTime())}</Text>
            </View>
          </View>
        </Pressable>
      </View>
    );
  }, [colors, styles, onSelect]);

  return (
    <FlashList
      data={users}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ paddingHorizontal: spacing.sm }}
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={() => void onRefresh()}
          tintColor={colors.primary}
        />
      }
      ListEmptyComponent={
        !loading ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>暂无用户</Text>
          </View>
        ) : null
      }
    />
  );
}
