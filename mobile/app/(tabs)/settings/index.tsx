import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Switch,
  Alert,
} from "react-native";
import { Image } from "expo-image";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../../src/contexts/AuthContext";
import { useTtsPlayer } from "../../../src/hooks/useTtsPlayer";
import {
  getServerUrl,
  setServerUrl,
  getLanUrl,
  setLanUrl,
  isLanActive,
  startLanProbe,
  mobileConfig,
} from "../../../src/platform/mobileConfig";
import Constants from "expo-constants";
import {
  useColors,
  spacing,
  typography,
  radius,
  useFontSize,
  type FontSizeLevel,
} from "../../../src/theme";
import { AgentAvatar } from "../../../src/components/AgentAvatar";
import {
  DEFAULT_TENANT_SETTINGS,
  fetchAgentProfile,
  reportActivity,
} from "@agent/shared";
import type { AgentProfile } from "@agent/shared";
import { showTextPrompt } from "../../../src/lib/prompt";

const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";

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
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const tts = useTtsPlayer();
  const router = useRouter();
  const isAdmin = user?.role === "admin";
  const tenantFeatures =
    user?.tenantFeatures ?? DEFAULT_TENANT_SETTINGS.features;
  const { level: fontSizeLevel, setLevel: setFontSizeLevel } = useFontSize();
  const [lanActive, setLanActiveState] = useState(isLanActive());

  // Refresh LAN status indicator while settings page is visible
  useFocusEffect(
    useCallback(() => {
      setLanActiveState(isLanActive());
      const timer = setInterval(() => setLanActiveState(isLanActive()), 5000);
      return () => clearInterval(timer);
    }, []),
  );

  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  useEffect(() => {
    if (!user?.username) return;
    fetchAgentProfile(user.username)
      .then(setAgentProfile)
      .catch(() => {});
  }, [user?.username]);

  const initial = (user?.username || "U").charAt(0).toUpperCase();
  const avatarUri = user?.avatar
    ? `${mobileConfig.getBaseUrl()}${user.avatar}`
    : null;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: colors.background,
        },
        scrollContent: {
          paddingTop: spacing.lg,
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.lg + insets.bottom,
        },
        section: {
          marginBottom: spacing.xl,
        },
        sectionTitle: {
          ...typography.caption,
          color: colors.mutedForeground,
          textTransform: "uppercase",
          marginBottom: spacing.sm,
          marginLeft: spacing.xs,
        },
        card: {
          backgroundColor: colors.card,
          borderRadius: radius.lg,
          overflow: "hidden",
        },
        avatarRow: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
        },
        avatar: {
          width: 40,
          height: 40,
          borderRadius: 20,
          backgroundColor: colors.primary,
          alignItems: "center",
          justifyContent: "center",
        },
        avatarImage: {
          width: 40,
          height: 40,
          borderRadius: 20,
        },
        avatarText: {
          color: colors.primaryForeground,
          fontSize: 16,
          fontWeight: "600",
        },
        avatarUsername: {
          ...typography.body,
          color: colors.foreground,
          fontWeight: "500",
          flex: 1,
          marginLeft: spacing.md,
        },
        row: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
        },
        rowBorder: {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        rowLabel: {
          ...typography.body,
          color: colors.foreground,
        },
        rowRight: {
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.xs,
          flexShrink: 1,
        },
        rowValue: {
          ...typography.body,
          color: colors.mutedForeground,
          flexShrink: 1,
          maxWidth: 180,
        },
        switchRow: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
        },
        fontSizeRow: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
        },
        fontSizeOptions: {
          flexDirection: "row",
          backgroundColor: colors.secondary,
          borderRadius: radius.md,
          padding: 2,
          gap: 2,
        },
        fontSizeOption: {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: radius.sm,
        },
        fontSizeOptionActive: {
          backgroundColor: colors.primary,
        },
        fontSizeOptionText: {
          ...typography.caption,
          color: colors.mutedForeground,
        },
        fontSizeOptionTextActive: {
          color: colors.primaryForeground,
          fontWeight: "600",
        },
        logoutBtn: {
          backgroundColor: colors.card,
          borderRadius: radius.lg,
          paddingVertical: 14,
          alignItems: "center",
        },
        logoutText: {
          ...typography.body,
          color: colors.destructive,
          fontWeight: "600",
        },
        versionText: {
          ...typography.body,
          color: colors.mutedForeground,
          textAlign: "center",
          marginTop: spacing.lg,
        },
      }),
    [colors, insets.top, insets.bottom],
  );

  const handleEditServer = () => {
    showTextPrompt({
      title: "服务器地址",
      message: "输入服务器 URL",
      defaultValue: getServerUrl(),
      placeholder: "https://...",
      confirmText: "保存",
      keyboardType: "url",
      onConfirm: async (url) => {
        if (url) {
          await setServerUrl(url.replace(/\/$/, ""));
          Alert.alert("已保存", "重启应用后生效");
        }
      },
    });
  };

  const handleEditLanUrl = () => {
    showTextPrompt({
      title: "内网地址",
      message: "局域网直连地址，留空禁用\n例：http://agent.local:3000",
      defaultValue: getLanUrl(),
      placeholder: "http://agent.local:3000",
      confirmText: "保存",
      keyboardType: "url",
      onConfirm: async (url) => {
        const trimmed = url.trim();
        await setLanUrl(trimmed);
        if (trimmed) {
          startLanProbe();
          Alert.alert(
            "已保存",
            isLanActive() ? "内网连接正常" : "暂时无法连接，将自动重试",
          );
        }
        setLanActiveState(isLanActive());
      },
    });
  };

  const handleLogout = () => {
    Alert.alert("退出登录", "确定要退出吗？", [
      { text: "取消", style: "cancel" },
      { text: "退出", style: "destructive", onPress: () => void logout() },
    ]);
  };

  return (
    <View style={styles.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Account Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>账户</Text>
          <View style={styles.card}>
            <TouchableOpacity
              style={styles.avatarRow}
              onPress={() =>
                router.push({
                  pathname: "/settings/user-detail/[userId]",
                  params: { userId: user?.id || "" },
                })
              }
              activeOpacity={0.7}
            >
              {avatarUri ? (
                <Image
                  source={{ uri: avatarUri }}
                  style={styles.avatarImage}
                  cachePolicy="disk"
                />
              ) : (
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initial}</Text>
                </View>
              )}
              <Text style={styles.avatarUsername}>
                {agentProfile?.realName || user?.username || "-"}
              </Text>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={colors.mutedForeground}
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* Agent Profile Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Agent</Text>
          <View style={styles.card}>
            <TouchableOpacity
              style={[styles.avatarRow, styles.rowBorder]}
              onPress={() => router.push("/settings/agent-profile")}
              activeOpacity={0.7}
            >
              <AgentAvatar
                avatar={agentProfile?.avatar}
                username={user?.username}
                size={40}
                version={agentProfile?.avatarVersion}
              />
              <Text style={styles.avatarUsername}>
                {agentProfile?.name || "AI 助手"}
              </Text>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={colors.mutedForeground}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.row, styles.rowBorder]}
              onPress={() => router.push("/settings/all-agents")}
              activeOpacity={0.7}
            >
              <Text style={styles.rowLabel}>所有 Agent</Text>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={colors.mutedForeground}
              />
            </TouchableOpacity>
            {tenantFeatures.cronEnabled && (
              <TouchableOpacity
                style={styles.row}
                onPress={() => router.push("/cron")}
                activeOpacity={0.7}
              >
                <Text style={styles.rowLabel}>定时任务</Text>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={colors.mutedForeground}
                />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* General Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>通用</Text>
          <View style={styles.card}>
            <View style={[styles.fontSizeRow, styles.rowBorder]}>
              <Text style={styles.rowLabel}>字体大小</Text>
              <View style={styles.fontSizeOptions}>
                {FONT_SIZE_OPTIONS.map((opt) => (
                  <TouchableOpacity
                    key={opt.value}
                    style={[
                      styles.fontSizeOption,
                      fontSizeLevel === opt.value &&
                        styles.fontSizeOptionActive,
                    ]}
                    onPress={() => setFontSizeLevel(opt.value)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.fontSizeOptionText,
                        fontSizeLevel === opt.value &&
                          styles.fontSizeOptionTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            {tts.available && (
              <View style={[styles.switchRow, styles.rowBorder]}>
                <Text style={styles.rowLabel}>自动播放 TTS</Text>
                <Switch
                  value={tts.autoPlay}
                  onValueChange={tts.toggleAutoPlay}
                  trackColor={{ false: colors.muted, true: colors.success }}
                  thumbColor={colors.card}
                  ios_backgroundColor={colors.muted}
                />
              </View>
            )}
            <TouchableOpacity
              style={[styles.row, styles.rowBorder]}
              onPress={handleEditServer}
              activeOpacity={0.7}
            >
              <Text style={styles.rowLabel}>外网地址</Text>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue} numberOfLines={1}>
                  {getServerUrl()}
                </Text>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={colors.mutedForeground}
                />
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.row}
              onPress={handleEditLanUrl}
              activeOpacity={0.7}
            >
              <Text style={styles.rowLabel}>内网地址</Text>
              <View style={styles.rowRight}>
                {!!getLanUrl() && (
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: lanActive
                        ? colors.statusIcon.success
                        : colors.muted,
                      marginRight: 6,
                    }}
                  />
                )}
                <Text style={styles.rowValue} numberOfLines={1}>
                  {getLanUrl() || "未设置"}
                </Text>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={colors.mutedForeground}
                />
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Admin Section */}
        {isAdmin && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>管理</Text>
            <View style={styles.card}>
              <TouchableOpacity
                style={[styles.row, styles.rowBorder]}
                onPress={() => router.push("/settings/users")}
                activeOpacity={0.7}
              >
                <Text style={styles.rowLabel}>用户管理</Text>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={colors.mutedForeground}
                />
              </TouchableOpacity>
              {tenantFeatures.customSkillsEnabled && (
                <TouchableOpacity
                  style={[styles.row, styles.rowBorder]}
                  onPress={() => router.push("/settings/skills-admin")}
                  activeOpacity={0.7}
                >
                  <Text style={styles.rowLabel}>Skill 管理</Text>
                  <Ionicons
                    name="chevron-forward"
                    size={16}
                    color={colors.mutedForeground}
                  />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.row, styles.rowBorder]}
                onPress={() => router.push("/settings/audit-log")}
                activeOpacity={0.7}
              >
                <Text style={styles.rowLabel}>操作日志</Text>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={colors.mutedForeground}
                />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Logout */}
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.logoutBtn}
            onPress={handleLogout}
            activeOpacity={0.7}
          >
            <Text style={styles.logoutText}>退出登录</Text>
          </TouchableOpacity>
          <Text style={styles.versionText}>v{APP_VERSION}</Text>
        </View>
      </ScrollView>
    </View>
  );
}
