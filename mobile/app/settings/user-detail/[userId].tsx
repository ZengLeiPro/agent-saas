import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  StyleSheet,
  Modal,
  Dimensions,
  Pressable,
} from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Camera, ChevronRight, FileText, Lock, SquarePen, X, type LucideIcon } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { authFetch } from '@agent/shared';
import type { UserInfo } from '@agent/shared';
import { useAuth } from '../../../src/contexts/AuthContext';
import { useUsers } from '../../../src/hooks/useUsers';
import { getServerUrl } from '../../../src/platform/mobileConfig';
import { useColors, spacing, typography, radius } from '../../../src/theme';

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function UserDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const { user: currentUser, updateAvatar } = useAuth();
  const { users, deleteUser, toggleUserDisabled, refresh: refreshUsers } = useUsers();

  const isAdmin = currentUser?.role === 'admin';
  const isSelf = userId === currentUser?.id;

  // For non-admin viewing self, fetch from /api/auth/me
  const [selfProfile, setSelfProfile] = useState<UserInfo | null>(null);
  const [avatarModalVisible, setAvatarModalVisible] = useState(false);

  const fetchSelfProfile = useCallback(async () => {
    try {
      const res = await authFetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json() as UserInfo;
        setSelfProfile(data);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (isSelf) {
      void fetchSelfProfile();
    }
  }, [isSelf, fetchSelfProfile]);

  const userFromList = useMemo(() => users.find(u => u.id === userId), [users, userId]);
  const user = userFromList || (isSelf ? selfProfile : null);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    scrollContent: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.lg,
    },
    center: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    emptyText: {
      ...typography.body,
      color: colors.mutedForeground,
    },
    // Hero
    hero: {
      alignItems: 'center',
      paddingVertical: spacing.xl,
      gap: spacing.xs,
    },
    avatar: {
      width: 72,
      height: 72,
      borderRadius: 36,
    },
    avatarPlaceholder: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: {
      color: colors.primaryForeground,
      fontSize: 30,
      fontWeight: '700',
    },
    displayName: {
      ...typography.subtitle,
      color: colors.foreground,
      fontWeight: '600',
      fontSize: 20,
      marginTop: spacing.sm,
    },
    subName: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    roleBadge: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: radius.sm,
      marginTop: spacing.xs,
    },
    adminBadge: {
      backgroundColor: colors.secondary,
    },
    userBadge: {
      backgroundColor: colors.muted,
    },
    roleText: {
      fontSize: 12,
      fontWeight: '500',
    },
    adminText: {
      color: colors.primary,
    },
    userText: {
      color: colors.mutedForeground,
    },
    // Sections
    section: {
      marginBottom: spacing.xl,
    },
    sectionTitle: {
      ...typography.caption,
      color: colors.mutedForeground,
      textTransform: 'uppercase',
      marginBottom: spacing.sm,
      marginLeft: spacing.xs,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    rowBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    rowLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    rowLabel: {
      ...typography.body,
      color: colors.foreground,
    },
    infoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    infoLabel: {
      ...typography.body,
      color: colors.mutedForeground,
    },
    infoValue: {
      ...typography.body,
      color: colors.foreground,
    },
    dangerRow: {
      paddingVertical: 14,
      alignItems: 'center',
    },
    dangerText: {
      ...typography.body,
      color: colors.destructive,
      fontWeight: '600',
    },
    // Avatar modal
    modalOverlay: {
      flex: 1,
      backgroundColor: colors.overlayHeavy,
      justifyContent: 'center',
      alignItems: 'center',
    },
    modalClose: {
      position: 'absolute',
      top: insets.top + 12,
      right: 16,
      zIndex: 10,
      padding: 8,
    },
    modalImage: {
      width: Dimensions.get('window').width - 40,
      height: Dimensions.get('window').width - 40,
      borderRadius: 12,
    },
  }), [colors, insets.top]);

  if (!user) {
    return (
      <View style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.emptyText}>用户不存在</Text>
        </View>
      </View>
    );
  }

  const avatarUri = user.avatar ? `${getServerUrl()}${user.avatar}` : null;
  const initial = ((user.realName || user.username) || 'U').charAt(0).toUpperCase();

  // Display name: realName is primary, username is secondary
  const primaryName = user.realName || user.username;
  const secondaryName = user.realName ? user.username : null;

  const handleAvatarUpload = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const formData = new FormData();
    formData.append('avatar', {
      uri: asset.uri,
      name: 'avatar.jpg',
      type: asset.mimeType || 'image/jpeg',
    } as any);
    try {
      // Self: POST /api/auth/avatar; Admin for others: POST /api/auth/users/:id/avatar
      const url = isSelf ? '/api/auth/avatar' : `/api/auth/users/${user.id}/avatar`;
      const res = await authFetch(url, { method: 'POST', body: formData });
      if (res.ok) {
        const data = await res.json() as { avatar: string; avatarVersion?: number };
        if (isSelf) {
          updateAvatar(data.avatar, data.avatarVersion);
          void fetchSelfProfile();
        } else {
          void refreshUsers();
        }
      } else {
        Alert.alert('上传失败');
      }
    } catch {
      Alert.alert('上传失败');
    }
  };

  const handleEdit = () => {
    router.push({
      pathname: '/user-form',
      params: {
        userId: user.id,
        username: user.username,
        realName: user.realName || '',
        role: user.role,
        maxTurns: user.permissions?.maxTurns?.toString() || '',
        maxRequests: user.permissions?.rateLimit?.maxRequests?.toString() || '',
        dingtalkStaffId: user.dingtalkStaffId || '',
      },
    });
  };

  const handleViewLogs = () => {
    router.push({
      pathname: '/settings/audit-log',
      params: { username: user.username },
    });
  };

  const handleToggleDisabled = () => {
    if (user.disabled) {
      void (async () => {
        try {
          await toggleUserDisabled(user.id, false);
        } catch (err) {
          Alert.alert('操作失败', err instanceof Error ? err.message : '未知错误');
        }
      })();
    } else {
      Alert.alert('禁用用户', `确定要禁用用户 "${user.username}" 吗？禁用后将无法登录和使用所有功能。`, [
        { text: '取消', style: 'cancel' },
        {
          text: '禁用',
          style: 'destructive',
          onPress: async () => {
            try {
              await toggleUserDisabled(user.id, true);
            } catch (err) {
              Alert.alert('操作失败', err instanceof Error ? err.message : '未知错误');
            }
          },
        },
      ]);
    }
  };

  const handleDelete = () => {
    Alert.alert('删除用户', `确定要删除用户 "${user.username}" 吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteUser(user.id);
            router.back();
          } catch (err) {
            Alert.alert('删除失败', err instanceof Error ? err.message : '未知错误');
          }
        },
      },
    ]);
  };

  // Build action rows dynamically
  // 修改头像: self + admin viewing others
  // 编辑资料: always (admin can edit anyone, user can edit self)
  // 修改密码: self only (admin resets password via edit form)
  // 操作日志: admin only
  const actionRows: { key: string; Icon: LucideIcon; label: string; onPress: () => void }[] = [];

  if (isSelf || isAdmin) {
    actionRows.push({ key: 'avatar', Icon: Camera, label: '修改头像', onPress: () => void handleAvatarUpload() });
  }
  if (isAdmin) {
    actionRows.push({ key: 'edit', Icon: SquarePen, label: '编辑资料', onPress: handleEdit });
  }
  if (isSelf) {
    actionRows.push({ key: 'password', Icon: Lock, label: '修改密码', onPress: () => router.push('/change-password') });
  }
  if (isAdmin) {
    actionRows.push({ key: 'logs', Icon: FileText, label: '操作日志', onPress: handleViewLogs });
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Hero Section */}
        <View style={styles.hero}>
          <TouchableOpacity
            activeOpacity={avatarUri ? 0.8 : 1}
            onPress={() => avatarUri && setAvatarModalVisible(true)}
          >
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.avatar} cachePolicy="disk" />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarText}>{initial}</Text>
              </View>
            )}
          </TouchableOpacity>
          <Text style={styles.displayName}>{primaryName}</Text>
          {secondaryName ? (
            <Text style={styles.subName}>{secondaryName}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: spacing.xs }}>
            <View style={[styles.roleBadge, user.role === 'admin' ? styles.adminBadge : styles.userBadge]}>
              <Text style={[styles.roleText, user.role === 'admin' ? styles.adminText : styles.userText]}>
                {user.role === 'admin' ? '管理员' : '用户'}
              </Text>
            </View>
            {user.disabled && (
              <View style={[styles.roleBadge, { backgroundColor: colors.errorBg }]}>
                <Text style={[styles.roleText, { color: colors.destructive }]}>已禁用</Text>
              </View>
            )}
          </View>
        </View>

        {/* 操作 Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>操作</Text>
          <View style={styles.card}>
            {actionRows.map((item, idx) => (
              <TouchableOpacity
                key={item.key}
                style={[styles.row, idx < actionRows.length - 1 && styles.rowBorder]}
                onPress={item.onPress}
                activeOpacity={0.7}
              >
                <View style={styles.rowLeft}>
                  <item.Icon size={20} color={colors.primary} strokeWidth={2} />
                  <Text style={styles.rowLabel}>{item.label}</Text>
                </View>
                <ChevronRight size={16} color={colors.mutedForeground} strokeWidth={2} />
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* 信息 Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>信息</Text>
          <View style={styles.card}>
            {user.createdAt ? (
              <View style={[styles.infoRow, styles.rowBorder]}>
                <Text style={styles.infoLabel}>创建时间</Text>
                <Text style={styles.infoValue}>{formatDate(user.createdAt)}</Text>
              </View>
            ) : null}
            {user.createdBy ? (
              <View style={[styles.infoRow, styles.rowBorder]}>
                <Text style={styles.infoLabel}>创建者</Text>
                <Text style={styles.infoValue}>{user.createdBy}</Text>
              </View>
            ) : null}
            {user.appVersion ? (
              <View style={[styles.infoRow, styles.rowBorder]}>
                <Text style={styles.infoLabel}>App 版本</Text>
                <Text style={styles.infoValue}>{user.appVersion}</Text>
              </View>
            ) : null}
            {user.permissions?.maxTurns != null && (
              <View style={[styles.infoRow, styles.rowBorder]}>
                <Text style={styles.infoLabel}>最大轮次</Text>
                <Text style={styles.infoValue}>{user.permissions.maxTurns}</Text>
              </View>
            )}
            {user.permissions?.rateLimit?.maxRequests != null && (
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>每分钟请求</Text>
                <Text style={styles.infoValue}>{user.permissions.rateLimit.maxRequests}</Text>
              </View>
            )}
          </View>
        </View>

        {/* 危险操作 — only admin and not self */}
        {isAdmin && !isSelf && (
          <View style={styles.section}>
            <View style={styles.card}>
              <TouchableOpacity
                style={[styles.dangerRow, styles.rowBorder]}
                onPress={handleToggleDisabled}
                activeOpacity={0.7}
              >
                <Text style={[styles.dangerText, user.disabled && { color: colors.success }]}>
                  {user.disabled ? '启用用户' : '禁用用户'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.dangerRow} onPress={handleDelete} activeOpacity={0.7}>
                <Text style={styles.dangerText}>删除用户</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Avatar full-screen modal */}
      <Modal visible={avatarModalVisible} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => setAvatarModalVisible(false)}>
          <TouchableOpacity style={styles.modalClose} onPress={() => setAvatarModalVisible(false)} activeOpacity={0.7}>
            <X size={28} color={colors.onOverlay} strokeWidth={2} />
          </TouchableOpacity>
          {avatarUri && (
            <Image source={{ uri: avatarUri }} style={styles.modalImage} contentFit="contain" cachePolicy="disk" />
          )}
        </Pressable>
      </Modal>
    </View>
  );
}
