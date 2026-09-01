import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronRight, CircleAlert, CirclePlus, File, RefreshCw } from 'lucide-react-native';
import { DEFAULT_TENANT_SETTINGS, formatShortDate, type ApiSessionListItem, type UploadedFile } from '@agent/shared';
import { useChatAppState } from '../src/contexts/ChatAppStateContext';
import { usePendingSharedFiles } from '../src/contexts/PendingSharedFilesContext';
import { useAuth } from '../src/contexts/AuthContext';
import { incomingShareCoordinator, takeIncomingShare } from '../src/platform/incomingShareInbox';
import { useColors, spacing, typography, radius, type ThemeColors } from '../src/theme';
import { hapticLight } from '../src/lib/haptics';

const MAX_LIST_SESSIONS = 20;

export default function ShareTargetScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const chat = useChatAppState();
  const pending = usePendingSharedFiles();
  const { user } = useAuth();
  const [share, setShare] = useState(() => takeIncomingShare());
  const [retrying, setRetrying] = useState(false);
  const styles = screenStyles(colors);
  const filesEnabled = (user?.tenantFeatures ?? DEFAULT_TENANT_SETTINGS.features).filesEnabled;

  const uploaded = useMemo(() => share?.attachments.filter((draft) => draft.status === 'uploaded' && draft.attachmentId) ?? [], [share]);
  const failed = useMemo(() => share?.attachments.filter((draft) => draft.status === 'failed') ?? [], [share]);
  const uploading = share?.attachments.some((draft) => ['received', 'validating', 'staging', 'uploading'].includes(draft.status)) ?? false;
  const canProceed = !!share && !uploading && failed.length === 0 && (uploaded.length > 0 || !!share.text.trim());

  const handleRetry = useCallback(async () => {
    if (!share || !user) return;
    setRetrying(true);
    try {
      setShare(await incomingShareCoordinator.resume({ userId: user.id, tenantId: user.tenantId }, share));
    } finally {
      setRetrying(false);
    }
  }, [share, user]);

  const handleCancel = useCallback(() => {
    if (share && user) void incomingShareCoordinator.cancel({ userId: user.id, tenantId: user.tenantId }, share);
    router.back();
  }, [router, share, user]);

  const proceed = useCallback((target: 'new' | string) => {
    if (!share || !canProceed) {
      Alert.alert('分享尚未就绪', failed.some((draft) => draft.error?.requiresRepick) ? '分享读取权限已失效，请返回原应用重新分享。' : '请重试失败项目。');
      return;
    }
    if (!filesEnabled && uploaded.length) {
      Alert.alert('文件能力已禁用', '当前组织已禁用文件上传。');
      return;
    }
    const files = uploaded.map((draft) => ({
      attachmentId: draft.attachmentId!, originalName: draft.name,
      size: draft.size, mimeType: draft.mimeType, isImage: draft.kind === 'image',
    })) as UploadedFile[]; // Deliberately no relativePath/savedPath runtime properties.
    hapticLight();
    pending.setPending({ files, text: share.text });
    if (target === 'new') {
      chat.newSession();
      router.replace('/chat/new');
    } else {
      chat.selectSession(target);
      router.replace(`/chat/${target}`);
    }
  }, [canProceed, chat, failed, filesEnabled, pending, router, share, uploaded]);

  const sessions = useMemo(() => [...chat.sessions]
    .filter((session) => !session.deletedAt)
    .sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0))
    .slice(0, MAX_LIST_SESSIONS), [chat.sessions]);

  if (!share) return <View style={styles.container}><Stack.Screen options={{ headerShown: false }} /></View>;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="share-target-screen" accessibilityLabel="分享至草稿">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={handleCancel} hitSlop={12}><Text style={styles.cancel}>取消</Text></Pressable>
        <Text style={styles.title}>分享至草稿</Text><View style={{ width: 48 }} />
      </View>
      {!!share.text.trim() && <View style={styles.sharedText}><Text numberOfLines={3} style={styles.sharedTextValue}>{share.text}</Text></View>}
      <ScrollView horizontal contentContainerStyle={styles.attachments}>
        {share.attachments.map((draft) => (
          <View key={draft.draftId} style={styles.attachmentCard}>
            <View style={styles.attachmentIcon}>
              <File size={28} color={colors.mutedForeground} />
              {draft.status === 'failed' && <CircleAlert style={StyleSheet.absoluteFillObject} size={20} color={colors.destructive} />}
              {draft.status === 'uploading' && <ActivityIndicator style={StyleSheet.absoluteFillObject} />}
            </View>
            <Text numberOfLines={1} style={styles.fileName}>{draft.name}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={styles.status}>
        <Text style={[styles.statusText, failed.length > 0 && { color: colors.destructive }]}>
          {uploading ? '正在安全复制或上传…' : failed.length ? `${failed.length} 项失败，原草稿已保留` : `${uploaded.length} 个附件已就绪`}
        </Text>
        {failed.some((draft) => draft.error?.retryable && !draft.error.requiresRepick) && (
          <Pressable onPress={handleRetry} disabled={retrying} style={styles.retry}>
            <RefreshCw size={16} color={colors.primary} /><Text style={{ color: colors.primary }}>{retrying ? '重试中' : '重试'}</Text>
          </Pressable>
        )}
      </View>
      <Pressable testID="share-target-send" accessibilityLabel="新建会话并保留为草稿" onPress={() => proceed('new')} disabled={!canProceed} style={[styles.newSession, !canProceed && { opacity: 0.4 }]}>
        <CirclePlus size={22} color={colors.primaryForeground} /><Text style={styles.newSessionText}>新建会话并保留为草稿</Text>
      </Pressable>
      <Text style={styles.sectionTitle}>最近会话</Text>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}>
        {sessions.map((session) => <SessionRow key={session.sessionId} session={session} disabled={!canProceed} onPress={() => proceed(session.sessionId)} colors={colors} />)}
      </ScrollView>
    </View>
  );
}

function SessionRow({ session, disabled, onPress, colors }: { session: ApiSessionListItem; disabled: boolean; onPress: () => void; colors: ThemeColors }) {
  return <Pressable onPress={onPress} disabled={disabled} style={[rowStyles(colors).row, disabled && { opacity: 0.45 }]}>
    <View style={{ flex: 1 }}><Text numberOfLines={1} style={rowStyles(colors).name}>{session.title || '新会话'}</Text><Text style={rowStyles(colors).time}>{formatShortDate(session.updatedAtMs)}</Text></View>
    <ChevronRight size={18} color={colors.mutedForeground} />
  </Pressable>;
}

function screenStyles(colors: ThemeColors) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  cancel: { ...typography.body, color: colors.primary }, title: { ...typography.body, color: colors.foreground, fontWeight: '600' },
  sharedText: { margin: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.card },
  sharedTextValue: { ...typography.body, color: colors.foreground }, attachments: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  attachmentCard: { width: 76, alignItems: 'center', gap: 4 }, attachmentIcon: { width: 64, height: 64, borderRadius: radius.md, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  fileName: { ...typography.caption, color: colors.mutedForeground, width: 72, textAlign: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  statusText: { ...typography.caption, color: colors.mutedForeground }, retry: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  newSession: { margin: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.primary, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm },
  newSessionText: { ...typography.body, color: colors.primaryForeground, fontWeight: '600' }, sectionTitle: { ...typography.caption, color: colors.mutedForeground, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
}); }
function rowStyles(colors: ThemeColors) { return StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, name: { ...typography.body, color: colors.foreground }, time: { ...typography.caption, color: colors.mutedForeground } }); }
