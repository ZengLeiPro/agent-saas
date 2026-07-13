/**
 * 系统级分享落点页：用户从微信/系统图库/Files 等点「分享 → Agent SaaS」后，
 * useShareIntentBridge 把文件存到 incomingFilesStore 并 router.push 到这里。
 *
 * 页面流程：
 *   1. mount 时立刻并行上传所有分享文件到 /api/upload
 *   2. 顶部预览条显示上传进度
 *   3. 用户从「+ 新建会话」按钮 或 最近会话列表中选目标
 *   4. 上传未完成则禁用选择，等待完成
 *   5. 选定后：把 UploadedFile[] 写入 PendingSharedFilesContext
 *      → router.replace('/chat/{id}')
 *      → chat/[sessionId].tsx mount 时 consume 并灌入输入框附件区
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Alert,
  Image,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CirclePlus, File, CircleAlert, ChevronRight } from "lucide-react-native";
import type { ShareIntentFile } from "expo-share-intent";
import type { UploadedFile, ApiSessionListItem } from "@agent/shared";
import { DEFAULT_TENANT_SETTINGS, formatShortDate } from "@agent/shared";
import { useChatAppState } from "../src/contexts/ChatAppStateContext";
import { usePendingSharedFiles } from "../src/contexts/PendingSharedFilesContext";
import { useAuth } from "../src/contexts/AuthContext";
import { takeIncomingShareFiles } from "../src/hooks/useShareIntentBridge";
import { uploadSharedFile } from "../src/utils/uploadSharedFile";
import {
  useColors,
  spacing,
  typography,
  radius,
  type ThemeColors,
} from "../src/theme";
import { hapticLight } from "../src/lib/haptics";

interface UploadSlot {
  source: ShareIntentFile;
  status: "uploading" | "done" | "error";
  uploaded?: UploadedFile;
  error?: string;
}

const MAX_LIST_SESSIONS = 20;

export default function ShareTargetScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const chat = useChatAppState();
  const pending = usePendingSharedFiles();
  const { user } = useAuth();
  const filesEnabled = (
    user?.tenantFeatures ?? DEFAULT_TENANT_SETTINGS.features
  ).filesEnabled;
  const styles = useScreenStyles(colors);

  // mount 时一次性截走原始文件；之后 takeIncomingShareFiles 会清空，所以用 useState 锁住
  const [sources] = useState<ShareIntentFile[]>(() => takeIncomingShareFiles());
  const [slots, setSlots] = useState<UploadSlot[]>(() =>
    sources.map((s) => ({ source: s, status: "uploading" as const })),
  );

  // 触发上传
  useEffect(() => {
    if (sources.length === 0) return;
    if (!filesEnabled) {
      setSlots((prev) =>
        prev.map((slot) => ({
          ...slot,
          status: "error" as const,
          error: "当前组织已禁用文件能力",
        })),
      );
      Alert.alert(
        "文件能力已禁用",
        "当前组织已禁用文件上传，请联系管理员开启。",
        [{ text: "知道了", onPress: () => router.back() }],
      );
      return;
    }
    sources.forEach((source, idx) => {
      uploadSharedFile(source)
        .then((uploaded) => {
          setSlots((prev) => {
            const next = [...prev];
            next[idx] = { source, status: "done", uploaded };
            return next;
          });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : "上传失败";
          setSlots((prev) => {
            const next = [...prev];
            next[idx] = { source, status: "error", error: message };
            return next;
          });
        });
    });
  }, [sources, filesEnabled, router]);

  const allDone =
    slots.length > 0 && slots.every((s) => s.status !== "uploading");
  const successFiles = useMemo(
    () =>
      slots
        .filter((s) => s.status === "done" && s.uploaded)
        .map((s) => s.uploaded!),
    [slots],
  );
  const failedCount = slots.filter((s) => s.status === "error").length;
  const uploadingCount = slots.filter((s) => s.status === "uploading").length;

  // 没有可分享文件（异常进入）：直接 pop
  useEffect(() => {
    if (sources.length === 0) {
      router.back();
    }
  }, [sources.length, router]);

  const handleCancel = useCallback(() => {
    router.back();
  }, [router]);

  const proceedToSession = useCallback(
    (target: "new" | string) => {
      if (!allDone) {
        Alert.alert("请稍候", "文件还在上传中");
        return;
      }
      if (successFiles.length === 0) {
        Alert.alert("上传失败", "没有可发送的文件");
        return;
      }
      hapticLight();
      pending.setPending(successFiles);
      if (target === "new") {
        chat.newSession();
        router.replace("/chat/new");
      } else {
        chat.selectSession(target);
        router.replace(`/chat/${target}`);
      }
    },
    [allDone, successFiles, pending, chat, router],
  );

  const recentSessions = useMemo(() => {
    return [...chat.sessions]
      .filter((s) => !s.deletedAt) // 不显示回收站里的
      .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
      .slice(0, MAX_LIST_SESSIONS);
  }, [chat.sessions]);

  const statusText = useMemo(() => {
    if (uploadingCount > 0) return `${uploadingCount} 个文件上传中…`;
    if (failedCount > 0)
      return `${slots.length - failedCount} 个就绪 / ${failedCount} 个失败`;
    return `${slots.length} 个文件就绪`;
  }, [uploadingCount, failedCount, slots.length]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={handleCancel} hitSlop={12} style={styles.cancelBtn}>
          <Text style={styles.cancelText}>取消</Text>
        </Pressable>
        <Text style={styles.headerTitle}>选择目标会话</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* 文件预览条 */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.previewScroll}
        style={styles.previewBar}
      >
        {slots.map((slot, idx) => (
          <FilePreviewCard key={idx} slot={slot} colors={colors} />
        ))}
      </ScrollView>

      {/* 状态条 */}
      <View style={styles.statusBar}>
        {uploadingCount > 0 && (
          <ActivityIndicator size="small" color={colors.foreground} />
        )}
        <Text
          style={[
            styles.statusText,
            failedCount > 0 &&
              uploadingCount === 0 && { color: colors.destructive },
          ]}
        >
          {statusText}
        </Text>
      </View>

      {/* 新建会话按钮 */}
      <Pressable
        onPress={() => proceedToSession("new")}
        style={({ pressed }) => [
          styles.newSessionBtn,
          pressed && styles.btnPressed,
          !allDone && styles.btnDisabled,
        ]}
        disabled={!allDone}
      >
        <CirclePlus
          size={22}
          color={colors.primaryForeground}
          strokeWidth={2}
        />
        <Text style={styles.newSessionText}>新建会话上传</Text>
      </Pressable>

      {/* 分割线 */}
      <View style={styles.dividerWrap}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>或选择最近会话</Text>
        <View style={styles.dividerLine} />
      </View>

      {/* 会话列表 */}
      <ScrollView
        style={styles.sessionList}
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        keyboardShouldPersistTaps="handled"
      >
        {recentSessions.length === 0 ? (
          <View style={styles.emptyHint}>
            <Text style={styles.emptyText}>暂无最近会话</Text>
          </View>
        ) : (
          recentSessions.map((session) => (
            <SessionListItem
              key={session.sessionId}
              session={session}
              disabled={!allDone}
              onPress={() => proceedToSession(session.sessionId)}
              colors={colors}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function FilePreviewCard({
  slot,
  colors,
}: {
  slot: UploadSlot;
  colors: ThemeColors;
}) {
  const isImage = slot.source.mimeType?.startsWith("image/");
  const fileName = slot.source.fileName || "文件";

  return (
    <View style={[cardStyles(colors).card]}>
      <View style={cardStyles(colors).thumb}>
        {isImage ? (
          <Image
            source={{ uri: slot.source.path }}
            style={cardStyles(colors).thumbImage}
          />
        ) : (
          <File
            size={28}
            color={colors.mutedForeground}
            strokeWidth={2}
          />
        )}
        {slot.status === "uploading" && (
          <View style={cardStyles(colors).overlay}>
            <ActivityIndicator size="small" color="#fff" />
          </View>
        )}
        {slot.status === "error" && (
          <View
            style={[
              cardStyles(colors).overlay,
              { backgroundColor: "rgba(220,50,50,0.5)" },
            ]}
          >
            <CircleAlert size={20} color="#fff" strokeWidth={2} />
          </View>
        )}
      </View>
      <Text numberOfLines={1} style={cardStyles(colors).name}>
        {fileName}
      </Text>
    </View>
  );
}

function SessionListItem({
  session,
  disabled,
  onPress,
  colors,
}: {
  session: ApiSessionListItem;
  disabled: boolean;
  onPress: () => void;
  colors: ThemeColors;
}) {
  const styles = sessionItemStyles(colors);
  const title = session.title || "新会话";
  const preview = session.preview || "";
  const timeText = formatShortDate(session.updatedAtMs);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.row,
        pressed && !disabled && styles.rowPressed,
        disabled && styles.rowDisabled,
      ]}
    >
      <View style={styles.content}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.time}>{timeText}</Text>
        </View>
        {preview ? (
          <Text style={styles.preview} numberOfLines={1}>
            {preview}
          </Text>
        ) : null}
      </View>
      <ChevronRight
        size={18}
        color={colors.mutedForeground}
        strokeWidth={2}
      />
    </Pressable>
  );
}

function useScreenStyles(colors: ThemeColors) {
  return useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        cancelBtn: {
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs,
        },
        cancelText: { ...typography.body, color: colors.primary },
        headerTitle: {
          ...typography.body,
          fontWeight: "600" as const,
          color: colors.foreground,
          flex: 1,
          textAlign: "center",
        },
        headerSpacer: { width: 60 },
        previewBar: {
          maxHeight: 100,
          flexGrow: 0,
          backgroundColor: colors.card,
        },
        previewScroll: {
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          gap: spacing.sm,
        },
        statusBar: {
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          backgroundColor: colors.card,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        statusText: { ...typography.caption, color: colors.mutedForeground },
        newSessionBtn: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.sm,
          margin: spacing.md,
          paddingVertical: spacing.md,
          backgroundColor: colors.primary,
          borderRadius: radius.md,
        },
        newSessionText: {
          ...typography.body,
          color: colors.primaryForeground,
          fontWeight: "600" as const,
        },
        btnPressed: { opacity: 0.7 },
        btnDisabled: { opacity: 0.4 },
        dividerWrap: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: spacing.md,
          gap: spacing.sm,
          marginBottom: spacing.sm,
        },
        dividerLine: {
          flex: 1,
          height: StyleSheet.hairlineWidth,
          backgroundColor: colors.border,
        },
        dividerText: { ...typography.caption, color: colors.mutedForeground },
        sessionList: { flex: 1 },
        emptyHint: { padding: spacing.lg, alignItems: "center" },
        emptyText: { ...typography.caption, color: colors.mutedForeground },
      }),
    [colors],
  );
}

function cardStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: { width: 72, alignItems: "center", gap: 4 },
    thumb: {
      width: 64,
      height: 64,
      borderRadius: radius.md,
      backgroundColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    thumbImage: { width: 64, height: 64, resizeMode: "cover" },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0,0,0,0.4)",
      alignItems: "center",
      justifyContent: "center",
    },
    name: {
      ...typography.caption,
      color: colors.mutedForeground,
      width: 70,
      textAlign: "center",
    },
  });
}

function sessionItemStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      backgroundColor: colors.card,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border + "40",
    },
    rowPressed: { backgroundColor: colors.accent },
    rowDisabled: { opacity: 0.5 },
    content: { flex: 1, gap: 2 },
    titleRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
    title: {
      ...typography.body,
      color: colors.foreground,
      fontWeight: "500" as const,
      flex: 1,
    },
    time: { ...typography.caption, color: colors.mutedForeground },
    preview: { ...typography.caption, color: colors.mutedForeground },
  });
}
