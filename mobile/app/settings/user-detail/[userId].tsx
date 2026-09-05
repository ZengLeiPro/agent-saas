import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
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
import { Camera, ChevronRight, Lock, X, type LucideIcon } from 'lucide-react-native';
import { launchPhotoLibraryForUserAction } from '../../../src/platform/jitMediaPermissions';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { authFetch } from '@agent/shared';
import type { UserInfo } from '@agent/shared';
import { useAuth } from '../../../src/contexts/AuthContext';
import { useUsers } from '../../../src/hooks/useUsers';
import { getServerUrl } from '../../../src/platform/mobileConfig';
import { isProductionProfile } from '../../../src/v1/v1Capabilities';
import { getV1BuildProfile } from '../../../src/v1/v1Runtime';
import { canCommitSelfProfileResponse, selectUserDetailProfile } from '../../../src/v1/userDetailAccess';
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
  // V1 范围裁剪（M00-01）：生产构建只允许当前账号自助资料，
  // 不请求、读取或回退到可能属于旧身份的管理员用户列表。
  // 09-04 拍板：用户管理（编辑资料 / 启禁用 / 删除 / 操作日志）整体移交 Web 管理后台，
  // 本页只保留当前账号的头像与密码自助入口。
  const v1Profile = getV1BuildProfile();
  const { users } = useUsers(!isProductionProfile(v1Profile));

  const isSelf = userId === currentUser?.id;

  // For non-admin viewing self, fetch from /api/auth/me
  const [selfProfile, setSelfProfile] = useState<UserInfo | null>(null);
  const selfProfileRequestId = useRef(0);
  const [avatarModalVisible, setAvatarModalVisible] = useState(false);

  const fetchSelfProfile = useCallback(async () => {
    const expectedUserId = currentUser?.id;
    if (!expectedUserId || userId !== expectedUserId) return;
    const requestId = ++selfProfileRequestId.current;
    try {
      const res = await authFetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json() as UserInfo;
        if (canCommitSelfProfileResponse(
          requestId,
          selfProfileRequestId.current,
          expectedUserId,
          userId,
          data,
        )) setSelfProfile(data);
      }
    } catch { /* ignore */ }
  }, [currentUser?.id, userId]);

  useEffect(() => {
    selfProfileRequestId.current += 1;
    setSelfProfile(null);
    if (isSelf) void fetchSelfProfile();
    return () => { selfProfileRequestId.current += 1; };
  }, [isSelf, fetchSelfProfile]);

  const user = useMemo(() => selectUserDetailProfile({
    profile: v1Profile,
    currentUserId: currentUser?.id,
    requestedUserId: userId,
    selfProfile,
    users,
  }), [currentUser?.id, selfProfile, userId, users, v1Profile]);

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
    const result = await launchPhotoLibraryForUserAction({
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
      // 仅本人自助改头像：POST /api/auth/avatar（未被 legacy write gate 封死）。
      const res = await authFetch('/api/auth/avatar', { method: 'POST', body: formData });
      if (res.ok) {
        const data = await res.json() as { avatar: string; avatarVersion?: number };
        updateAvatar(data.avatar, data.avatarVersion);
        void fetchSelfProfile();
      } else {
        Alert.alert('上传失败');
      }
    } catch {
      Alert.alert('上传失败');
    }
  };

  // 操作行：仅当前账号自助（修改头像 / 修改密码）。
  // 管理类操作（编辑资料、启禁用、删除、操作日志）已移交 Web 管理后台。
  const actionRows: { key: string; Icon: LucideIcon; label: string; onPress: () => void }[] = [];

  if (isSelf) {
    actionRows.push({ key: 'avatar', Icon: Camera, label: '修改头像', onPress: () => void handleAvatarUpload() });
    actionRows.push({ key: 'password', Icon: Lock, label: '修改密码', onPress: () => router.push('/change-password') });
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
