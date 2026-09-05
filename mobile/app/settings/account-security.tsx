/**
 * 账户与安全（`settings/account-security`）—— 对齐 Web `SettingsModal` 的
 * `AccountSection`：账号资料（头像 / 全名 / 用户 ID）、修改密码、退出登录。
 *
 * 与 Web 的刻意差异：
 * - Web 的「更改手机号」走短信验证码弹窗，移动端本轮不做（手机号只读展示）；
 * - 移动端额外有两项本地安全设置：生物识别应用锁（M30-02）与可信服务地址切换，
 *   它们没有 Web 对应项，归入本分区的「安全」组。
 */
import React, { useCallback, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { authFetch } from '@agent/shared';
import { useAuth } from '../../src/contexts/AuthContext';
import { useLocalAppLock } from '../../src/contexts/LocalAppLockContext';
import { launchPhotoLibraryForUserAction } from '../../src/platform/jitMediaPermissions';
import { mobileConfig } from '../../src/platform/mobileConfig';
import { Button, ListRow } from '../../src/components/ui';
import { SettingsGroup, SettingsScrollView } from '../../src/components/settings/SettingsSections';
import { showTextPrompt } from '../../src/lib/prompt';
import { fontScale, fontWeight, radius, useThemedStyles } from '../../src/theme';

const AVATAR_SIZE = 40;

export default function AccountSecurityScreen() {
  const router = useRouter();
  const { user, logout, updateAvatar, refreshUser, serviceConfig, changeServiceOrigin } = useAuth();
  const localLock = useLocalAppLock();
  const [lockBusy, setLockBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  const styles = useThemedStyles((colors) => ({
    avatar: {
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      borderRadius: radius.full,
      backgroundColor: colors.primary,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    avatarImage: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: radius.full },
    avatarText: {
      ...fontScale.base,
      fontWeight: fontWeight.semibold,
      color: colors.primaryForeground,
    },
  }));

  const avatarUri = user?.avatar ? `${mobileConfig.getBaseUrl()}${user.avatar}` : null;
  const displayName = user?.realName || user?.username || '未登录';
  const userId = user?.id || user?.username || '未知';

  const handleAvatarUpload = useCallback(async () => {
    const result = await launchPhotoLibraryForUserAction({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const formData = new FormData();
    // 仅本人自助改头像：POST /api/auth/avatar（与 Web SettingsModal 同一端点）。
    formData.append('avatar', {
      uri: asset.uri,
      name: 'avatar.jpg',
      type: asset.mimeType || 'image/jpeg',
    } as unknown as Blob);
    setUploading(true);
    try {
      const res = await authFetch('/api/auth/avatar', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        Alert.alert('上传失败', body.error || '请稍后重试');
        return;
      }
      const data = (await res.json()) as { avatar: string; avatarVersion?: number };
      updateAvatar(data.avatar, data.avatarVersion);
      void refreshUser();
    } catch {
      Alert.alert('上传失败', '请检查网络后重试');
    } finally {
      setUploading(false);
    }
  }, [refreshUser, updateAvatar]);

  const copyUserId = useCallback(async () => {
    await Clipboard.setStringAsync(userId);
    Alert.alert('已复制', '用户 ID 已复制到剪贴板');
  }, [userId]);

  const handleLocalLockChange = useCallback(
    async (enabled: boolean) => {
      setLockBusy(true);
      try {
        const result = enabled ? await localLock.enable() : await localLock.disable();
        if (!result.ok) Alert.alert(enabled ? '无法开启应用锁' : '无法关闭应用锁', result.error);
      } finally {
        setLockBusy(false);
      }
    },
    [localLock],
  );

  const handleEditServer = useCallback(() => {
    if (!serviceConfig.editable) return;
    showTextPrompt({
      title: '切换可信服务',
      message: `仅可使用此构建允许的地址：\n${serviceConfig.apiAllowlist.join('\n')}`,
      defaultValue: serviceConfig.apiOrigin ?? '',
      placeholder: 'https://...',
      confirmText: '切换并退出登录',
      keyboardType: 'url',
      onConfirm: async (url) => {
        const result = await changeServiceOrigin(url.trim());
        if (!result.ok) {
          Alert.alert('无法切换服务', result.error ?? '服务地址不可用');
        } else if (result.changed) {
          Alert.alert('服务已切换', '原登录状态已清除，请重新登录');
        }
      },
    });
  }, [changeServiceOrigin, serviceConfig]);

  const handleLogout = useCallback(() => {
    Alert.alert('退出登录', '确定要退出吗？', [
      { text: '取消', style: 'cancel' },
      { text: '退出', style: 'destructive', onPress: () => void logout() },
    ]);
  }, [logout]);

  return (
    <SettingsScrollView testID="account-security-screen" accessibilityLabel="账户与安全">
      <SettingsGroup title="资料">
        <ListRow
          title={displayName}
          subtitle={uploading ? '头像上传中…' : `@${user?.username ?? 'anonymous'} · 点按更换头像`}
          disabled={uploading}
          leading={
            avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.avatarImage} cachePolicy="disk" />
            ) : (
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{displayName.charAt(0).toUpperCase()}</Text>
              </View>
            )
          }
          onPress={() => {
            void handleAvatarUpload();
          }}
        />
        <ListRow title="用户名" value={user?.username ?? '-'} />
        <ListRow
          title="手机号"
          value={
            user?.phone
              ? `${user.phone}${user.phoneVerifiedAt ? ' · 已验证' : ' · 未验证'}`
              : '暂无'
          }
        />
        <ListRow title="所属组织" value={user?.tenantName ?? user?.tenantId ?? '-'} />
        <ListRow
          title="用户 ID"
          value={userId}
          onPress={() => {
            void copyUserId();
          }}
        />
        <ListRow
          title="账号详情"
          subtitle="角色、创建时间与用量限额"
          onPress={() =>
            router.push({
              pathname: '/settings/user-detail/[userId]',
              params: { userId: user?.id || '' },
            })
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="安全"
        footnote="手机号变更与登录设备管理仍在桌面控制台完成；移动端只保留本机自助项。"
      >
        <ListRow
          title="修改密码"
          subtitle="定期更新密码，提升账号安全性"
          onPress={() => router.push('/change-password')}
        />
        <ListRow
          title="生物识别应用锁"
          subtitle="离开后台 30 秒后锁定；不替代服务端登录"
          switchValue={localLock.enabled}
          switchDisabled={
            lockBusy || !localLock.availability?.supported || !localLock.availability?.enrolled
          }
          onSwitchChange={(value) => {
            void handleLocalLockChange(value);
          }}
        />
        {serviceConfig.editable ? (
          <ListRow
            title="服务地址"
            value={serviceConfig.apiOrigin ?? '未配置'}
            onPress={handleEditServer}
          />
        ) : (
          <ListRow title="服务地址" value={serviceConfig.apiOrigin ?? '构建配置缺失'} />
        )}
      </SettingsGroup>

      <Button
        testID="account-logout-button"
        accessibilityLabel="退出登录"
        label="退出登录"
        variant="destructive"
        size="lg"
        fullWidth
        onPress={handleLogout}
      />
    </SettingsScrollView>
  );
}
