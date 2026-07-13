import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  Image,
  Modal,
  Dimensions,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors, spacing, typography, radius } from "../../theme";
import { useAuth } from "../../contexts/AuthContext";
import { AgentAvatar } from "../AgentAvatar";
import { BackButton } from "../BackButton";
import { glassFree } from "../../lib/headerItems";
import {
  fetchAgentProfile,
  updateAgentProfile,
  uploadAgentAvatar,
  isEmojiAvatar,
  getAgentAvatarUrl,
  reportActivity,
  DEFAULT_TENANT_SETTINGS,
} from "@agent/shared";
import { getServerUrl } from "../../platform/mobileConfig";

interface AgentProfileEditorProps {
  username?: string;
  title: string;
  activityDetail: string;
  requireAdmin?: boolean;
  backToAllAgents?: boolean;
}

export function AgentProfileEditor({
  username: targetUsername,
  title,
  activityDetail,
  requireAdmin = false,
  backToAllAgents = false,
}: AgentProfileEditorProps) {
  useEffect(() => {
    reportActivity("agent_profile_viewed", { detail: activityDetail });
  }, [activityDetail]);
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const customSkillsEnabled = (
    user?.tenantFeatures ?? DEFAULT_TENANT_SETTINGS.features
  ).customSkillsEnabled;
  const username = targetUsername || user?.username;

  const [name, setName] = useState("");
  const [signature, setSignature] = useState("");
  const [realName, setRealName] = useState("");
  const [avatar, setAvatar] = useState<string | undefined>();
  const [avatarVer, setAvatarVer] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState(false);
  const initialName = useRef("");
  const initialSignature = useRef("");

  const loadProfile = useCallback(async (target: string) => {
    setLoading(true);
    try {
      const profileData = await fetchAgentProfile(target);
      setName(profileData.name || "");
      setSignature(profileData.signature || "");
      setRealName(profileData.realName || "");
      setAvatar(profileData.avatar);
      setAvatarVer(profileData.avatarVersion);
      initialName.current = profileData.name || "";
      initialSignature.current = profileData.signature || "";
    } catch {
      setName("");
      setSignature("");
      setRealName("");
      setAvatar(undefined);
      initialName.current = "";
      initialSignature.current = "";
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!username) return;
    loadProfile(username);
  }, [username, loadProfile]);

  useEffect(() => {
    setDirty(
      name !== initialName.current || signature !== initialSignature.current,
    );
  }, [name, signature]);

  const handleSave = useCallback(async () => {
    if (!username) return;
    setSaving(true);
    try {
      await updateAgentProfile(username, { name, signature });
      initialName.current = name;
      initialSignature.current = signature;
      setDirty(false);
      Alert.alert("已保存", "Agent 设置已更新，新会话生效");
    } catch (err) {
      Alert.alert("保存失败", err instanceof Error ? err.message : "未知错误");
    } finally {
      setSaving(false);
    }
  }, [username, name, signature]);

  const handlePickAvatar = useCallback(async () => {
    if (!username) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;
    try {
      const asset = result.assets[0];
      await uploadAgentAvatar(username, {
        uri: asset.uri,
        type: asset.mimeType || "image/jpeg",
        name:
          asset.fileName || `avatar.${asset.mimeType?.split("/")[1] || "jpg"}`,
      });
      const profile = await fetchAgentProfile(username);
      setAvatar(profile.avatar);
      setAvatarVer(profile.avatarVersion);
    } catch (err) {
      Alert.alert("上传失败", err instanceof Error ? err.message : "请重试");
    }
  }, [username]);

  const handleResetAvatar = useCallback(async () => {
    if (!username) return;
    try {
      await updateAgentProfile(username, { avatar: "🤖" });
      setAvatar("🤖");
      setAvatarVer(undefined);
    } catch {
      Alert.alert("重置失败");
    }
  }, [username]);

  const hasCustomAvatar = !!avatar && avatar.startsWith("agent-avatars/");
  const actionRows: {
    key: string;
    icon: string;
    label: string;
    onPress: () => void;
  }[] = [
    {
      key: "avatar",
      icon: "camera-outline",
      label: "修改头像",
      onPress: () => void handlePickAvatar(),
    },
  ];
  if (hasCustomAvatar) {
    actionRows.push({
      key: "reset",
      icon: "refresh-outline",
      label: "重置头像",
      onPress: () => void handleResetAvatar(),
    });
  }
  actionRows.push({
    key: "persona",
    icon: "color-palette-outline",
    label: "人格定义",
    onPress: () =>
      router.push({
        pathname: "/persona-editor",
        params: { username: username!, mode: "persona" },
      }),
  });
  actionRows.push({
    key: "memory",
    icon: "layers-outline",
    label: "Agent 记忆",
    onPress: () =>
      router.push({
        pathname: "/persona-editor",
        params: { username: username!, mode: "memory" },
      }),
  });
  if (customSkillsEnabled) {
    actionRows.push({
      key: "skills",
      icon: "extension-puzzle-outline",
      label: "技能",
      onPress: () => router.push("/settings/skills"),
    });
  }
  // Hidden for now — may re-enable later
  // actionRows.push({
  //   key: 'memory-files',
  //   icon: 'folder-open-outline',
  //   label: '日常记忆',
  //   onPress: () => router.push({ pathname: '/memory-browser', params: { path: 'memory' } }),
  // });

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.background },
        scrollContent: {
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
          paddingBottom: spacing.lg + insets.bottom,
        },
        hero: {
          alignItems: "center",
          paddingVertical: spacing.xl,
          gap: spacing.xs,
        },
        displayName: {
          ...typography.subtitle,
          color: colors.foreground,
          fontWeight: "600",
          fontSize: 20,
          marginTop: spacing.sm,
        },
        signatureText: {
          ...typography.caption,
          color: colors.mutedForeground,
          marginTop: 2,
        },
        section: { marginBottom: spacing.xl },
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
        rowLeft: {
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
        },
        rowLabel: { ...typography.body, color: colors.foreground },
        input: {
          ...typography.body,
          color: colors.foreground,
          paddingHorizontal: spacing.lg,
          height: 44,
          lineHeight: undefined,
        },
        saveBtn: {
          backgroundColor: dirty ? colors.primary : colors.muted,
          borderRadius: radius.lg,
          paddingVertical: 14,
          alignItems: "center",
          flexDirection: "row",
          justifyContent: "center",
          gap: spacing.sm,
        },
        saveBtnText: {
          ...typography.body,
          color: dirty ? colors.primaryForeground : colors.mutedForeground,
          fontWeight: "600",
        },
        loadingCenter: {
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          paddingTop: 100,
        },
        modalOverlay: {
          flex: 1,
          backgroundColor: colors.overlayHeavy,
          justifyContent: "center" as const,
          alignItems: "center" as const,
        },
        modalClose: {
          position: "absolute" as const,
          top: insets.top + 12,
          right: 16,
          zIndex: 10,
          padding: 8,
        },
        modalImage: {
          width: Dimensions.get("window").width - 40,
          height: Dimensions.get("window").width - 40,
          borderRadius: 12,
        },
      }),
    [colors, insets.top, insets.bottom, dirty],
  );

  if (!user) return null;
  if (requireAdmin && user.role !== "admin") {
    router.replace("/settings/agent-profile");
    return null;
  }

  const headerTitle =
    realName && targetUsername ? `${realName} 的 Agent` : title;

  return (
    <>
      <Stack.Screen
        options={{
          title: headerTitle,
          ...(backToAllAgents
            ? {
                headerLeft: () => (
                  <BackButton
                    label="返回"
                    onPress={() => router.replace("/settings/all-agents")}
                  />
                ),
                unstable_headerLeftItems: () => [
                  glassFree(
                    <BackButton
                      label="返回"
                      onPress={() => router.replace("/settings/all-agents")}
                    />,
                  ),
                ],
              }
            : {}),
        }}
      />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {loading ? (
          <View style={styles.loadingCenter}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.hero}>
              {!isEmojiAvatar(avatar) ? (
                <TouchableOpacity
                  onPress={() => setAvatarPreview(true)}
                  activeOpacity={0.8}
                >
                  <AgentAvatar
                    avatar={avatar}
                    username={username}
                    size={72}
                    version={avatarVer}
                  />
                </TouchableOpacity>
              ) : (
                <AgentAvatar
                  avatar={avatar}
                  username={username}
                  size={72}
                  version={avatarVer}
                />
              )}
              <Text style={styles.displayName}>{name || "AI 助手"}</Text>
              {signature ? (
                <Text style={styles.signatureText}>{signature}</Text>
              ) : null}
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>名称</Text>
              <View style={styles.card}>
                <TextInput
                  style={styles.input}
                  value={name}
                  onChangeText={setName}
                  placeholder="给你的 Agent 取个名字"
                  placeholderTextColor={colors.mutedForeground}
                  maxLength={50}
                />
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                签名（仅用于向其他用户展示，不注入提示语）
              </Text>
              <View style={styles.card}>
                <TextInput
                  style={styles.input}
                  value={signature}
                  onChangeText={setSignature}
                  placeholder="写一句签名..."
                  placeholderTextColor={colors.mutedForeground}
                  maxLength={100}
                />
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>操作</Text>
              <View style={styles.card}>
                {actionRows.map((item, idx) => (
                  <TouchableOpacity
                    key={item.key}
                    style={[
                      styles.row,
                      idx < actionRows.length - 1 && styles.rowBorder,
                    ]}
                    onPress={item.onPress}
                    activeOpacity={0.7}
                  >
                    <View style={styles.rowLeft}>
                      <Ionicons
                        name={item.icon as any}
                        size={20}
                        color={colors.primary}
                      />
                      <Text style={styles.rowLabel}>{item.label}</Text>
                    </View>
                    <Ionicons
                      name="chevron-forward"
                      size={16}
                      color={colors.mutedForeground}
                    />
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.section}>
              <TouchableOpacity
                style={styles.saveBtn}
                onPress={handleSave}
                disabled={saving || !dirty}
                activeOpacity={0.7}
              >
                {saving && (
                  <ActivityIndicator
                    size="small"
                    color={colors.primaryForeground}
                  />
                )}
                <Text style={styles.saveBtnText}>保存</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        )}
      </KeyboardAvoidingView>
      <Modal visible={avatarPreview} transparent animationType="fade">
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setAvatarPreview(false)}
        >
          <TouchableOpacity
            style={styles.modalClose}
            onPress={() => setAvatarPreview(false)}
            activeOpacity={0.7}
          >
            <Ionicons name="close" size={28} color={colors.onOverlay} />
          </TouchableOpacity>
          {!isEmojiAvatar(avatar) && (
            <Image
              source={{
                uri: getAgentAvatarUrl(
                  username || "",
                  avatar,
                  getServerUrl(),
                  avatarVer,
                )!,
              }}
              style={styles.modalImage}
              resizeMode="contain"
            />
          )}
        </Pressable>
      </Modal>
    </>
  );
}
