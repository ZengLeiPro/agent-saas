import React, { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Keyboard, Alert, Animated, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { showTextPrompt } from '../../src/lib/prompt';
import { Stack, useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { type RenderItem, type MessageItem, getPreviewFileType, useGroups, fetchAgentProfile, getSortedGroupItems } from '@agent/shared';
import { BackButton } from '../../src/components/BackButton';
import type { PickerExtraSection } from '../../src/components/chat/ModelPicker';
import type { DrillDownPage } from '../../src/components/overlays/DropdownMenu';
import { useChatAppState } from '../../src/contexts/ChatAppStateContext';
import { usePendingSharedFiles } from '../../src/contexts/PendingSharedFilesContext';
import { useAuth } from '../../src/contexts/AuthContext';
import { useVoiceRecorder } from '../../src/hooks/useVoiceRecorder';
import { useTtsPlayer } from '../../src/hooks/useTtsPlayer';
import { useOnlineStatus } from '../../src/hooks/useOnlineStatus';
import { useWsLifecycle } from '../../src/hooks/useWsLifecycle';
import { useAppLifecycle } from '../../src/hooks/useAppLifecycle';
import { useScrollToTop } from '../../src/hooks/useScrollToTop';
import { MessageList } from '../../src/components/chat/MessageList';
import { ChatInput } from '../../src/components/chat/ChatInput';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { TokenDetailTrigger, TokenDetailOverlay } from '../../src/components/chat/TokenDetail';
import { ModelPicker } from '../../src/components/chat/ModelPicker';
import { KeyboardStickyView, KeyboardAvoidingView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useHeaderHeight } from '@react-navigation/elements';
import ReAnimated, { useAnimatedStyle, interpolate } from 'react-native-reanimated';
import { hapticLight } from '../../src/lib/haptics';
import { glassFree } from '../../src/lib/headerItems';
import { useColors, typography, type ThemeColors } from '../../src/theme';

export default function ChatDetailScreen() {
  const colors = useColors();
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const chat = useChatAppState();
  const pendingShared = usePendingSharedFiles();
  const { user: authUser } = useAuth();
  const isAdminUser = authUser?.role === 'admin';
  const tts = useTtsPlayer();
  const isOnline = useOnlineStatus();
  useWsLifecycle();
  const router = useRouter();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { width: screenWidth } = useWindowDimensions();
  const styles = useScreenStyles(colors, screenWidth);

  const { listRef } = useScrollToTop<RenderItem>();
  const [tooShortTip, setTooShortTip] = useState(false);
  const [showTokenDetail, setShowTokenDetail] = useState(false);
  const defaultBottomPadding = 56 + insets.bottom;
  const [composerHeight, setComposerHeight] = useState(defaultBottomPadding);
  const lastComposerHeightRef = useRef(defaultBottomPadding);
  const pendingScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();

  // Smoothly animate safe area padding: insets.bottom → 0 as keyboard opens
  const safeAreaAnimStyle = useAnimatedStyle(() => ({
    height: interpolate(keyboardProgress.value, [0, 1], [insets.bottom, 0]),
    backgroundColor: colors.secondary,
  }));

  // Scroll-to-bottom button state (lifted from MessageList for input-tracking)
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const scrollBtnOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(scrollBtnOpacity, {
      toValue: showScrollBtn ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [showScrollBtn, scrollBtnOpacity]);

  const scrollToBottom = useCallback(() => {
    if (pendingScrollTimerRef.current) {
      clearTimeout(pendingScrollTimerRef.current);
      pendingScrollTimerRef.current = null;
    }
    listRef.current?.scrollToEnd({ animated: true });
    chat.isNearBottomRef.current = true;
    setShowScrollBtn(false);
  }, [listRef, chat.isNearBottomRef]);

  const scheduleScrollToBottom = useCallback((delay = 16) => {
    if (pendingScrollTimerRef.current) {
      clearTimeout(pendingScrollTimerRef.current);
    }
    pendingScrollTimerRef.current = setTimeout(() => {
      pendingScrollTimerRef.current = null;
      scrollToBottom();
    }, delay);
  }, [scrollToBottom]);

  const handleComposerLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.max(defaultBottomPadding, Math.round(event.nativeEvent.layout.height));
    if (Math.abs(nextHeight - lastComposerHeightRef.current) < 1) return;

    const wasNearBottom = chat.isNearBottomRef.current;
    lastComposerHeightRef.current = nextHeight;
    setComposerHeight(nextHeight);

    if (Platform.OS === 'ios' && wasNearBottom) {
      scheduleScrollToBottom();
    }
  }, [chat.isNearBottomRef, defaultBottomPadding, scheduleScrollToBottom]);

  // Refresh data when returning from background (5s threshold)
  useAppLifecycle(() => {
    void chat.refreshSessions();
    chat.refreshCurrentSession();
  }, 5_000);

  // Wire up TTS auto-play callback
  useEffect(() => {
    if (tts.available && tts.autoPlay) {
      chat.voiceCallbackRef.current = (key, text, voice, speed) => {
        tts.play(key, text, voice, speed);
      };
    } else {
      chat.voiceCallbackRef.current = undefined;
    }
  }, [tts.available, tts.autoPlay]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleVoiceSend = useCallback(async (fileUri: string, durationMs: number) => {
    await chat.sendVoiceMessage(fileUri, durationMs);
  }, [chat.sendVoiceMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  const recorder = useVoiceRecorder({
    onVoiceSend: handleVoiceSend,
    onTooShort: () => {
      setTooShortTip(true);
      setTimeout(() => setTooShortTip(false), 2000);
    },
  });

  const effectiveSessionId = useMemo(() => {
    if (sessionId && sessionId !== 'new') return sessionId;
    return chat.sessionId;
  }, [sessionId, chat.sessionId]);

  const currentSession = useMemo(() => {
    if (!effectiveSessionId) return undefined;
    return chat.sessions.find(s => s.sessionId === effectiveSessionId);
  }, [effectiveSessionId, chat.sessions]);

  const sessionOwner = currentSession?.owner?.username;

  // Fetch the correct agent profile for the session owner (not the global ownerFilter-based one)
  const [sessionAgentProfile, setSessionAgentProfile] = useState<Awaited<ReturnType<typeof fetchAgentProfile>> | null>(null);
  useEffect(() => {
    const target = sessionOwner || authUser?.username;
    if (!target) { setSessionAgentProfile(null); return; }
    fetchAgentProfile(target)
      .then(setSessionAgentProfile)
      .catch(() => setSessionAgentProfile(null));
  }, [sessionOwner, authUser?.username]);

  const isNewSession = !effectiveSessionId;

  // Groups — admin viewing all users = read-only (no group ops)
  const { groups, sorting, createGroup, addSessionsToGroup, removeSessionsFromGroup } = useGroups();
  const isReadOnlyGroups = isAdminUser && chat.ownerFilter === null;

  const currentGroupId = useMemo(() => {
    if (!sessionId || isNewSession) return null;
    return groups.find(g => g.sessionIds.includes(sessionId))?.id ?? null;
  }, [sessionId, isNewSession, groups]);

  const extraSections = useMemo<PickerExtraSection[] | undefined>(() => {
    if (isNewSession) return undefined;

    const sections: PickerExtraSection[] = [
      {
        id: '_naming',
        actions: [
          { id: '_rename', label: '重命名' },
          { id: '_auto_title', label: '自动命名' },
        ],
      },
    ];

    // Group action: skip for admin read-only mode
    if (!isReadOnlyGroups) {
      if (currentGroupId) {
        sections.push({
          id: '_group_section',
          actions: [{ id: '_ungroup', label: '移出分组' }],
        });
      } else {
        sections.push({
          id: '_group_section',
          actions: [{ id: '_group', label: '分组' }],
        });
      }
    }

    sections.push({
      id: '_compact_section',
      actions: [{ id: '_compact', label: '压缩上下文' }],
    });

    return sections;
  }, [isNewSession, isReadOnlyGroups, currentGroupId]);

  // Drill-down: group selection — 使用 getSortedGroupItems 统一排序，与其他入口一致
  const drillDowns = useMemo<Record<string, DrillDownPage> | undefined>(() => {
    if (isNewSession || isReadOnlyGroups || currentGroupId) return undefined;
    const items = getSortedGroupItems(groups, sorting);
    return {
      '_group': {
        title: '分组',
        items: [
          { id: '__create__', label: '新建分组' },
          ...items.map(g => ({ id: g.id, label: g.name })),
        ],
        separatorAfterFirst: true,
      },
    };
  }, [isNewSession, isReadOnlyGroups, currentGroupId, groups, sorting]);

  const handleTitleAction = useCallback((actionId: string) => {
    if (!sessionId || isNewSession) return;
    if (actionId === '_rename') {
      showTextPrompt({
        title: '重命名会话',
        defaultValue: currentSession?.title || '',
        onConfirm: (text) => {
          const trimmed = text.trim();
          if (trimmed) void chat.renameSession(sessionId, trimmed);
        },
      });
    } else if (actionId === '_auto_title') {
      void chat.autoTitleSession(sessionId);
    } else if (actionId === '_ungroup' && currentGroupId) {
      void removeSessionsFromGroup(currentGroupId, [sessionId]);
    } else if (actionId === '_compact') {
      Alert.alert(
        '压缩上下文',
        '压缩会话的上下文历史，保留关键信息同时减少 Token 占用。此操作不可撤销。',
        [
          { text: '取消', style: 'cancel' },
          { text: '确认压缩', onPress: () => void chat.compactSession() },
        ],
      );
    }
  }, [sessionId, isNewSession, currentSession?.title, currentGroupId, chat.renameSession, chat.autoTitleSession, chat.compactSession, removeSessionsFromGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDrillDownSelect = useCallback((parentId: string, childId: string) => {
    if (!sessionId || isNewSession) return;
    if (parentId === '_group') {
      if (childId === '__create__') {
        showTextPrompt({
          title: '新建分组',
          onConfirm: (name) => {
            const trimmed = name.trim();
            if (trimmed) void createGroup(trimmed, [sessionId]);
          },
        });
      } else {
        void addSessionsToGroup(childId, [sessionId]);
      }
    }
  }, [sessionId, isNewSession, createGroup, addSessionsToGroup]);

  const handleFork = useCallback(async (message: MessageItem) => {
    const newSessionId = await chat.forkFromMessage(message);
    if (newSessionId) {
      router.replace({ pathname: '/chat/[sessionId]' as any, params: { sessionId: newSessionId } });
    }
  }, [chat.forkFromMessage, router]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePreviewMd = useCallback((filePath: string) => {
    const type = getPreviewFileType(filePath);
    const screen = type === 'html' ? '/chat/html-preview' : '/chat/markdown-preview';
    router.push({ pathname: screen as any, params: { filePath, ...(sessionOwner ? { owner: sessionOwner } : {}) } });
  }, [router, sessionOwner]);

  useEffect(() => {
    const nextDefaultPadding = 56 + insets.bottom;
    if (lastComposerHeightRef.current < nextDefaultPadding) {
      lastComposerHeightRef.current = nextDefaultPadding;
      setComposerHeight(nextDefaultPadding);
    }
  }, [insets.bottom]);

  useEffect(() => {
    return () => {
      if (pendingScrollTimerRef.current) {
        clearTimeout(pendingScrollTimerRef.current);
      }
    };
  }, []);

  // When keyboard opens and user was near bottom, scroll list to bottom to prevent occlusion
  useEffect(() => {
    let wasNearBottom = false;
    if (Platform.OS === 'ios') {
      const willSub = Keyboard.addListener('keyboardWillShow', () => {
        wasNearBottom = chat.isNearBottomRef.current;
        setIsKeyboardOpen(true);
      });
      const didSub = Keyboard.addListener('keyboardDidShow', () => {
        if (wasNearBottom && composerHeight === lastComposerHeightRef.current) {
          scheduleScrollToBottom();
        }
      });
      const willHideSub = Keyboard.addListener('keyboardWillHide', () => {
        setIsKeyboardOpen(false);
      });
      return () => { willSub.remove(); didSub.remove(); willHideSub.remove(); };
    } else {
      const didSub = Keyboard.addListener('keyboardDidShow', () => {
        setIsKeyboardOpen(true);
        if (chat.isNearBottomRef.current) {
          scheduleScrollToBottom(100);
        }
      });
      const hideSub = Keyboard.addListener('keyboardDidHide', () => {
        setIsKeyboardOpen(false);
      });
      return () => { didSub.remove(); hideSub.remove(); };
    }
  }, [chat.isNearBottomRef, composerHeight, scheduleScrollToBottom]);

  useEffect(() => {
    if (sessionId === 'new') {
      if (chat.sessionId) {
        // Use setParams instead of router.replace to avoid triggering
        // a Stack navigation transition animation (visible as a "slide" effect)
        navigation.setParams({ sessionId: chat.sessionId });
      }
      return;
    }
    if (sessionId && sessionId !== chat.sessionId) {
      chat.selectSession(sessionId);
    }
  }, [sessionId, chat.sessionId, navigation]); // eslint-disable-line react-hooks/exhaustive-deps

  // 系统级分享流程：share-target 页面把已上传完成的文件存到 PendingSharedFilesContext，
  // 这里在挂载时一次性消费并灌入 fileUpload state，等用户补一句话发送。
  useEffect(() => {
    if (!pendingShared.hasPending()) return;
    const files = pendingShared.consume();
    if (files.length) chat.addUploadedFiles(files);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: '',
          headerLeft: () => <BackButton />,
          unstable_headerLeftItems: () => [glassFree(
            <BackButton />
          )],
          headerTitle: () => {
            const title = currentSession?.title || '新会话';
            const renderTrigger = (modelLabel: string | null) => (
              <View style={styles.navTitleRow}>
                <View style={styles.navTitleInner}>
                  <Text style={styles.navTitle} numberOfLines={1}>{title}</Text>
                  <View style={styles.navModelRow}>
                    <Text style={[styles.navModelText, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {modelLabel ?? '模型'}
                    </Text>
                    <Ionicons name="chevron-down" size={10} color={colors.mutedForeground} />
                  </View>
                </View>
              </View>
            );
            const inner = chat.modelList ? (
              <ModelPicker
                modelList={chat.modelList}
                selectedModel={chat.selectedModel}
                onModelChange={chat.onModelChange}
                sessionId={chat.sessionId}
                extraSections={extraSections}
                onExtraAction={handleTitleAction}
                drillDowns={drillDowns}
                onDrillDownSelect={handleDrillDownSelect}
              >
                {renderTrigger}
              </ModelPicker>
            ) : renderTrigger(null);
            return inner;
          },
          headerRight: () => chat.tokenUsage ? (
            <TokenDetailTrigger tokenUsage={chat.tokenUsage} onPress={() => {
              hapticLight();
              setShowTokenDetail(prev => !prev);
            }} />
          ) : undefined,
          unstable_headerRightItems: () => chat.tokenUsage ? [glassFree(
            <TokenDetailTrigger tokenUsage={chat.tokenUsage} onPress={() => {
              hapticLight();
              setShowTokenDetail(prev => !prev);
            }} />
          )] : [],
        }}
      />

      <ConnectionBanner connectionState={chat.connectionState} isOnline={isOnline} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <MessageList
        headerPadding={0}
        bottomPadding={Platform.OS === 'ios' ? composerHeight - (isKeyboardOpen ? insets.bottom : 0) : defaultBottomPadding}
        messages={chat.messages}
        loading={chat.loading}
        isLoadingMessages={chat.isLoadingMessages}
        shouldScrollRef={chat.shouldScrollRef}
        isNearBottomRef={chat.isNearBottomRef}
        listRef={listRef}
        onPermissionResponse={chat.handlePermissionResponse}
        onAskUserResponse={chat.handleAskUserResponse}
        onRetryMessage={chat.retryMessage}
        onForkMessage={handleFork}
        onPreviewMd={handlePreviewMd}
        onTtsPlay={tts.available ? tts.play : undefined}
        onScrollBtnVisibilityChange={setShowScrollBtn}
      />
      </KeyboardAvoidingView>
      <KeyboardStickyView style={styles.inputOverlay} offset={{ closed: 0, opened: 0 }}>
        <View onLayout={handleComposerLayout}>
        <ChatInput
          input={chat.input}
          setInput={chat.setInput}
          loading={chat.loading}
          onSend={() => void chat.sendMessage()}
          onStop={chat.stopGeneration}
          stopping={chat.stopping}
          uploadedFiles={chat.uploadedFiles}
          uploading={chat.uploading}
          uploadError={chat.uploadError}
          onDismissUploadError={chat.dismissUploadError}
          onPickFile={chat.pickFile}
          onPickImage={chat.pickImage}
          onTakePhoto={chat.takePhoto}
          onRemoveFile={chat.removeFile}
          isRecording={recorder.isRecording}
          recordingDuration={recorder.duration}
          onStartRecording={recorder.startRecording}
          onStopRecording={recorder.stopAndSend}
          onCancelRecording={recorder.cancelRecording}
          sessionId={chat.sessionId}
          tooShortTip={tooShortTip}
        />
        {/* Safe area padding — smoothly animated with keyboard via Reanimated */}
        {insets.bottom > 0 && <ReAnimated.View style={safeAreaAnimStyle} />}
        </View>
        {/* Scroll to bottom — absolutely positioned above ChatInput, no layout impact */}
        <Animated.View
          style={[styles.scrollBtnWrap, { opacity: scrollBtnOpacity }]}
          pointerEvents={showScrollBtn ? 'auto' : 'none'}
        >
          <TouchableOpacity style={styles.scrollBtn} onPress={scrollToBottom} activeOpacity={0.7}>
            <Ionicons name="chevron-down" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        </Animated.View>
      </KeyboardStickyView>

      {/* Token detail overlay */}
      {showTokenDetail && chat.tokenUsage && (
        <TokenDetailOverlay
          tokenUsage={chat.tokenUsage}
          sessionId={sessionId || ''}
          topOffset={0}
          onDismiss={() => setShowTokenDetail(false)}
        />
      )}
    </View>
  );
}

const HEADER_SIDE_RESERVE = 60;

function useScreenStyles(colors: ThemeColors, screenWidth: number) {
  return useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    navTitleRow: {
      maxWidth: screenWidth - HEADER_SIDE_RESERVE * 2,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      overflow: 'hidden',
    },
    navTitleInner: {
      flexShrink: 1,
      minWidth: 0,
      alignItems: 'center',
      overflow: 'hidden',
    },
    navTitle: {
      fontSize: 15,
      fontWeight: '600' as const,
      lineHeight: 20,
      color: colors.foreground,
    },
    navModelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
    },
    navModelText: {
      fontSize: 10,
      lineHeight: 13,
    },
    inputOverlay: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
    },
    scrollBtnWrap: {
      position: 'absolute',
      top: -40,  // -(36 button height + 4 gap)
      left: 0,
      right: 0,
      alignItems: 'center',
    },
    scrollBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.12,
      shadowRadius: 6,
      elevation: 4,
      borderWidth: 1,
      borderColor: colors.border,
    },
  }), [colors, screenWidth]);
}
