import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, Alert, Linking } from "react-native";
import { Image } from "expo-image";
import { useRouter, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { useAuth } from "../../../src/contexts/AuthContext";
import { useLocalAppLock } from "../../../src/contexts/LocalAppLockContext";
import { useTtsPlayer } from "../../../src/hooks/useTtsPlayer";
import { mobileConfig } from "../../../src/platform/mobileConfig";
import {
  spacing,
  radius,
  fontScale,
  fontWeight,
  useThemedStyles,
  useFontSize,
  type FontSizeLevel,
} from "../../../src/theme";
import { AgentAvatar } from "../../../src/components/AgentAvatar";
import { Button, Chip, ListRow, ListRowGroup } from "../../../src/components/ui";
import {
  DEFAULT_TENANT_SETTINGS,
  fetchAgentProfile,
  reportActivity,
} from "@agent/shared";
import type { AgentProfile } from "@agent/shared";
import { fetchMyGovernanceSummary, type MyGovernanceSummary } from "@agent/shared/lib/governanceApi";
import { showTextPrompt } from "../../../src/lib/prompt";
import { isFilesEntryVisible } from "../../../src/lib/filesEntry";
import { isV1RouteAllowed } from "../../../src/v1/v1Capabilities";
import { getV1BuildProfile } from "../../../src/v1/v1Runtime";

const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
const AVATAR_SIZE = 40;

const FONT_SIZE_OPTIONS: { value: FontSizeLevel; label: string }[] = [
  { value: "small", label: "小" },
  { value: "default", label: "默认" },
  { value: "medium", label: "中" },
  { value: "large", label: "大" },
];

export default function SettingsScreen() {
  useFocusEffect(
    useCallback(() => {
      reportActivity("page_viewed", { detail: "设置" });
    }, []),
  );
  const insets = useSafeAreaInsets();
  const { user, logout, serviceConfig, changeServiceOrigin } = useAuth();
  const tts = useTtsPlayer();
  const localLock = useLocalAppLock();
  const [localLockBusy, setLocalLockBusy] = useState(false);
  const router = useRouter();
  const tenantFeatures = user?.tenantFeatures ?? DEFAULT_TENANT_SETTINGS.features;
  const { level: fontSizeLevel, setLevel: setFontSizeLevel } = useFontSize();

  // V1 范围裁剪（M00-01）：生产构建隐藏延期菜单项。
  const v1Profile = getV1BuildProfile();
  const showCron = isV1RouteAllowed("cron", v1Profile);
  const showGovernance = isV1RouteAllowed("settings/my-permissions", v1Profile);
  const showConnections = isV1RouteAllowed("capabilities/connectors", v1Profile);
  // P3-3c：文件中心与会话列表 pill 共用同一入口口径（租户开关 ∩ V1 allowlist）。
  const showFiles = isFilesEntryVisible({
    filesEnabled: tenantFeatures.filesEnabled,
    routeAllowed: isV1RouteAllowed("files", v1Profile),
  });

  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  const [governanceSummary, setGovernanceSummary] = useState<MyGovernanceSummary | null>(null);
  useEffect(() => {
    if (!user?.username) return;
    fetchAgentProfile(user.username)
      .then(setAgentProfile)
      .catch(() => {});
  }, [user?.username]);
  useEffect(() => {
    if (!user || !showGovernance) return;
    fetchMyGovernanceSummary().then(setGovernanceSummary).catch(() => setGovernanceSummary(null));
  }, [user, showGovernance]);

  const initial = (user?.username || "U").charAt(0).toUpperCase();
  const avatarUri = user?.avatar ? `${mobileConfig.getBaseUrl()}${user.avatar}` : null;

  const styles = useThemedStyles((colors) => ({
    container: { flex: 1, backgroundColor: colors.background },
    scrollContent: {
      paddingTop: spacing.lg,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.lg + insets.bottom,
    },
    section: { marginBottom: spacing.xl },
    sectionTitle: {
      ...fontScale.xs,
      fontWeight: fontWeight.medium,
      color: colors.mutedForeground,
      textTransform: "uppercase" as const,
      marginBottom: spacing.sm,
      marginLeft: spacing.xs,
    },
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
    fontSizeOptions: { flexDirection: "row" as const, gap: spacing.xs },
    versionText: {
      ...fontScale.xs,
      color: colors.mutedForeground,
      textAlign: "center" as const,
      marginTop: spacing.lg,
    },
  }));

  const handleEditServer = () => {
    if (!serviceConfig.editable) return;
    showTextPrompt({
      title: "切换可信服务",
      message: `仅可使用此构建允许的地址：\n${serviceConfig.apiAllowlist.join("\n")}`,
      defaultValue: serviceConfig.apiOrigin ?? "",
      placeholder: "https://...",
      confirmText: "切换并退出登录",
      keyboardType: "url",
      onConfirm: async (url) => {
        const result = await changeServiceOrigin(url.trim());
        if (!result.ok) {
          Alert.alert("无法切换服务", result.error ?? "服务地址不可用");
        } else if (result.changed) {
          Alert.alert("服务已切换", "原登录状态已清除，请重新登录");
        }
      },
    });
  };

  const openGovernanceDesktop = async () => {
    if (!governanceSummary) return;
    const target = new URL(governanceSummary.desktopPath, mobileConfig.getBaseUrl()).toString();
    try { await Linking.openURL(target); }
    catch { Alert.alert("无法打开桌面控制台", target); }
  };

  const handleLogout = () => {
    Alert.alert("退出登录", "确定要退出吗？", [
      { text: "取消", style: "cancel" },
      { text: "退出", style: "destructive", onPress: () => void logout() },
    ]);
  };

  const handleLocalLockChange = async (enabled: boolean) => {
    setLocalLockBusy(true);
    try {
      const result = enabled ? await localLock.enable() : await localLock.disable();
      if (!result.ok) Alert.alert(enabled ? "无法开启应用锁" : "无法关闭应用锁", result.error);
    } finally {
      setLocalLockBusy(false);
    }
  };

  const fontSizeControl = (
    <View style={styles.fontSizeOptions}>
      {FONT_SIZE_OPTIONS.map((opt) => (
        <Chip
          key={opt.value}
          label={opt.label}
          selected={fontSizeLevel === opt.value}
          onPress={() => setFontSizeLevel(opt.value)}
        />
      ))}
    </View>
  );

  return (
    <View style={styles.container} testID="settings-screen" accessibilityLabel="设置">
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {/* 账户 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>账户</Text>
          <ListRowGroup>
            <ListRow
              title={agentProfile?.realName || user?.username || "-"}
              titleTestID="account-username"
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
              onPress={() =>
                router.push({
                  pathname: "/settings/user-detail/[userId]",
                  params: { userId: user?.id || "" },
                })
              }
            />
          </ListRowGroup>
        </View>

        {/* Agent */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Agent</Text>
          <ListRowGroup>
            <ListRow
              title={agentProfile?.name || "AI 助手"}
              leading={
                <AgentAvatar
                  avatar={agentProfile?.avatar}
                  username={user?.username}
                  size={AVATAR_SIZE}
                  version={agentProfile?.avatarVersion}
                />
              }
              onPress={() => router.push("/settings/agent-profile")}
            />
            {tenantFeatures.cronEnabled && showCron ? (
              <ListRow title="定时任务" onPress={() => router.push("/cron")} />
            ) : null}
          </ListRowGroup>
        </View>

        {/* M30-02 安全 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>安全</Text>
          <ListRowGroup>
            <ListRow
              title="生物识别应用锁"
              subtitle="离开后台 30 秒后锁定；不替代服务端登录"
              switchValue={localLock.enabled}
              switchDisabled={
                localLockBusy || !localLock.availability?.supported || !localLock.availability?.enrolled
              }
              onSwitchChange={(value) => { void handleLocalLockChange(value); }}
            />
          </ListRowGroup>
        </View>

        {/* 通用 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>通用</Text>
          <ListRowGroup>
            <ListRow title="字体大小" accessory={fontSizeControl} />
            {tts.available ? (
              <ListRow
                title="自动播放 TTS"
                switchValue={tts.autoPlay}
                onSwitchChange={tts.toggleAutoPlay}
              />
            ) : null}
            {serviceConfig.editable ? (
              <ListRow
                title="服务地址"
                value={serviceConfig.apiOrigin ?? "未配置"}
                onPress={handleEditServer}
              />
            ) : (
              <ListRow
                title="服务地址"
                value={serviceConfig.apiOrigin ?? "构建配置缺失"}
              />
            )}
          </ListRowGroup>
        </View>

        {/* V2 个人治理 */}
        {showGovernance ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>个人治理</Text>
            <ListRowGroup>
              <ListRow title="我的权限" onPress={() => router.push("/settings/my-permissions")} />
              {showConnections ? (
                <ListRow
                  title="连接与授权"
                  value="Google Workspace 与 MCP"
                  onPress={() => router.push("/capabilities/connectors")}
                />
              ) : null}
              {showFiles ? (
                <ListRow
                  title="文件与存储"
                  value="文件中心"
                  onPress={() => router.push("/files")}
                />
              ) : null}
              <ListRow title="治理身份" value={governanceSummary?.label ?? "权威摘要不可用"} />
              {governanceSummary && governanceSummary.persona !== "member" ? (
                <ListRow
                  title="管理待办与异常"
                  value="在桌面控制台继续"
                  onPress={() => { void openGovernanceDesktop(); }}
                />
              ) : null}
            </ListRowGroup>
          </View>
        ) : null}

        {/* 退出登录 */}
        <View style={styles.section}>
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
      </ScrollView>
    </View>
  );
}
