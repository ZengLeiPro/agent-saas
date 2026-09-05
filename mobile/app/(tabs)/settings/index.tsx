/**
 * 设置主页（P3-3d）：按 Web `unifiedSettingsRegistry` 的 8 个个人分区重排。
 *
 * 与 Web 的对齐口径：
 * - 分组标题（个人 / 偏好 / 访问 / 数据）、分区顺序、分区 ID 完全一致，
 *   ID 即将来的深链段（Web `/settings/<id>`，移动端 Stack 路由 `settings/<id>`）；
 * - 「连接与授权」落能力中心连接器 Tab（与 Web 一样，连接管理已并入能力中心）；
 * - 「回收站」在移动端是页内底部面板 `TrashSheet`，没有独立路由。
 *
 * 刻意保留的移动端专属元素：顶部账号卡（E2E `account-username`）、
 * 底部退出登录按钮（E2E `logout-button`）与版本号。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter, useFocusEffect } from "expo-router";
import Constants from "expo-constants";
import { useAuth } from "../../../src/contexts/AuthContext";
import { mobileConfig } from "../../../src/platform/mobileConfig";
import {
  radius,
  spacing,
  fontScale,
  fontWeight,
  useThemedStyles,
} from "../../../src/theme";
import { Button, ListRow } from "../../../src/components/ui";
import { TrashSheet } from "../../../src/components/sessions";
import {
  PERSONAL_SETTINGS_ICONS,
  SettingsGroup,
  SettingsScrollView,
} from "../../../src/components/settings/SettingsSections";
import {
  groupPersonalSettingsSections,
  type PersonalSettingsSection,
  type PersonalSettingsSectionId,
} from "../../../src/lib/settings/personalSettingsSections";
import { DEFAULT_TENANT_SETTINGS, fetchAgentProfile, reportActivity } from "@agent/shared";
import type { AgentProfile, TenantFeatureFlags } from "@agent/shared";
import { isFilesEntryVisible } from "../../../src/lib/filesEntry";
import { isV1RouteAllowed } from "../../../src/v1/v1Capabilities";
import { getV1BuildProfile } from "../../../src/v1/v1Runtime";

const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
const AVATAR_SIZE = 40;

export default function SettingsScreen() {
  useFocusEffect(
    useCallback(() => {
      reportActivity("page_viewed", { detail: "设置" });
    }, []),
  );
  const { user, logout } = useAuth();
  const router = useRouter();
  const tenantFeatures: TenantFeatureFlags =
    user?.tenantFeatures ?? DEFAULT_TENANT_SETTINGS.features;
  const [trashVisible, setTrashVisible] = useState(false);

  // V1 范围裁剪（M00-01）：生产构建按 allowlist 决定分区可见性。
  const v1Profile = getV1BuildProfile();
  const hiddenSectionIds = useMemo<PersonalSettingsSectionId[]>(() => {
    const visibility: Record<PersonalSettingsSectionId, boolean> = {
      "account-security": true,
      // 与 Web `SettingsModal` 一致：关闭个人 Agent 的租户不显示「我的 Agent」；
      // 服务端未下发该开关时按开启处理（与 shared 默认口径一致）。
      "my-agent": tenantFeatures.personalAgentEnabled !== false,
      "chat-model": true,
      "appearance-layout": true,
      "my-permissions": isV1RouteAllowed("settings/my-permissions", v1Profile),
      connections: isV1RouteAllowed("capabilities/connectors", v1Profile),
      // 文件与存储：与会话列表「文件」pill 共用口径（租户开关 ∩ V1 allowlist）
      "files-storage": isFilesEntryVisible({
        filesEnabled: tenantFeatures.filesEnabled,
        routeAllowed: isV1RouteAllowed("files", v1Profile),
      }),
      trash: true,
    };
    return (Object.keys(visibility) as PersonalSettingsSectionId[]).filter(
      (id) => !visibility[id],
    );
  }, [tenantFeatures.filesEnabled, tenantFeatures.personalAgentEnabled, v1Profile]);

  const groups = useMemo(
    () => groupPersonalSettingsSections(hiddenSectionIds),
    [hiddenSectionIds],
  );

  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  useEffect(() => {
    if (!user?.username) return;
    fetchAgentProfile(user.username)
      .then(setAgentProfile)
      .catch(() => {});
  }, [user?.username]);

  const initial = (user?.username || "U").charAt(0).toUpperCase();
  const avatarUri = user?.avatar ? `${mobileConfig.getBaseUrl()}${user.avatar}` : null;

  const styles = useThemedStyles((colors) => ({
    avatar: {
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      borderRadius: radius.full,
      backgroundColor: colors.primary,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    avatarImage: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: radius.full },
    avatarText: {
      ...fontScale.base,
      fontWeight: fontWeight.semibold,
      color: colors.primaryForeground,
    },
    versionText: {
      ...fontScale.xs,
      color: colors.mutedForeground,
      textAlign: "center" as const,
      marginTop: spacing.lg,
    },
  }));

  const handleLogout = useCallback(() => {
    Alert.alert("退出登录", "确定要退出吗？", [
      { text: "取消", style: "cancel" },
      { text: "退出", style: "destructive", onPress: () => void logout() },
    ]);
  }, [logout]);

  const openSection = useCallback(
    (section: PersonalSettingsSection) => {
      if (section.target.kind === "sheet") {
        setTrashVisible(true);
        return;
      }
      // 落点来自注册表（`src/lib/settings/personalSettingsSections.ts`），
      // 其 V1 分类由该模块的单测断言，这里不再重复静态字符串。
      const pathname = `/${section.target.route}`;
      router.push(pathname);
    },
    [router],
  );

  return (
    <>
      <SettingsScrollView testID="settings-screen" accessibilityLabel="设置">
        <SettingsGroup>
          <ListRow
            title={agentProfile?.realName || user?.realName || user?.username || "-"}
            titleTestID="account-username"
            subtitle={user?.tenantName ? `${user.username} · ${user.tenantName}` : user?.username}
            accessibilityLabel="当前账户"
            leading={
              avatarUri ? (
                <Image source={{ uri: avatarUri }} style={styles.avatarImage} cachePolicy="disk" />
              ) : (
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initial}</Text>
                </View>
              )
            }
            onPress={() => router.push("/settings/account-security")}
          />
        </SettingsGroup>

        {groups.map((group) => (
          <SettingsGroup key={group.group} title={group.label}>
            {group.sections.map((section) => (
              <ListRow
                key={section.id}
                testID={`settings-section-${section.id}`}
                title={section.label}
                subtitle={section.description}
                icon={PERSONAL_SETTINGS_ICONS[section.iconKey]}
                onPress={() => openSection(section)}
              />
            ))}
          </SettingsGroup>
        ))}

        <View>
          <Button
            testID="logout-button"
            accessibilityLabel="退出登录"
            label="退出登录"
            variant="destructive"
            size="lg"
            fullWidth
            onPress={handleLogout}
          />
          <Text style={styles.versionText}>v{APP_VERSION}</Text>
        </View>
      </SettingsScrollView>

      <TrashSheet visible={trashVisible} onClose={() => setTrashVisible(false)} />
    </>
  );
}
