import React, { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Keyboard, Alert, Animated, AppState, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { showTextPrompt } from '../../src/lib/prompt';
import { Stack, useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown } from 'lucide-react-native';
import { type RenderItem, type MessageItem, getPreviewFileType, useGroups, fetchAgentProfile, getSortedGroupItems, mergeIncomingShareText } from '@agent/shared';
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
import { useRuntimeRecovery } from '../../src/hooks/useRuntimeRecovery';
import { useAgentSwitch } from '../../src/hooks/useAgentSwitch';
import { MessageList } from '../../src/components/chat/MessageList';
import { EmptyChatRecommendCards } from '../../src/components/chat/EmptyChatRecommendCards';
import { ExpertWelcome } from '../../src/components/chat/ExpertWelcome';
import { useScenarioDeepLink } from '../../src/hooks/useScenarioDeepLink';
import { resolveActiveExpertPresentation } from '../../src/lib/activeExpertPresentation';
import { SubagentTranscriptSheet } from '../../src/components/chat/SubagentTranscriptSheet';
import {
  SubagentTranscriptProvider,
  type SubagentTranscriptTarget,
} from '../../src/components/chat/blocks';
import { MessageFeedbackProvider } from '../../src/contexts/MessageFeedbackContext';
import { AskUserPromptPanel } from '../../src/components/chat/AskUserPromptPanel';
import { QueuedMessageBar } from '../../src/components/chat/QueuedMessageBar';
import { ChatInput } from '../../src/components/chat/ChatInput';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { TokenDetailOverlay } from '../../src/components/chat/TokenDetail';
import { ChatHeaderRight, ChatHeaderTitle } from '../../src/components/chat/ChatSessionHeader';
import { BillingDetailOverlay, useBillingBadgeData } from '../../src/components/chat/BillingMiniBadge';
import { OrgAgentPickerSheet } from '../../src/components/chat/OrgAgentPickerSheet';
import { AgentSwitchConfirmation } from '../../src/components/chat/AgentSwitchConfirmation';
import { KeyboardStickyView, KeyboardAvoidingView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useHeaderHeight } from '@react-navigation/elements';
import ReAnimated, { useAnimatedStyle, interpolate } from 'react-native-reanimated';
import { hapticLight } from '../../src/lib/haptics';
import { glassFree } from '../../src/lib/headerItems';
import { useColors, spacing, radius, fontScale, type ThemeColors } from '../../src/theme';

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
  const styles = useScreenStyles(colors);

  const { listRef, scrollToTop } = useScrollToTop<RenderItem>();
  // 失败恢复：失败用户消息原位重试，其余失败补发「继续」（与 Web 同语义）。
  const recoverFromFailure = useRuntimeRecovery();
  const [tooShortTip, setTooShortTip] = useState(false);
  // 两张用量卡互斥展开（与 Web MobileLayout `activeUsageCard` 同语义）
  const [activeUsageCard, setActiveUsageCard] = useState<'context' | 'billing' | null>(null);
  // 子任务完整过程：面板挂在会话页（这里才拿得到 MessageList），块内只发起打开请求
  const [transcriptTarget, setTranscriptTarget] = useState<SubagentTranscriptTarget | null>(null);
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
    if (AppState.currentState === 'active') void chat.markCurrentSessionRead();
  }, [listRef, chat.isNearBottomRef, chat.markCurrentSessionRead]);

  const handleScrollButtonVisibility = useCallback((visible: boolean) => {
    setShowScrollBtn(visible);
    if (!visible && AppState.currentState === 'active') void chat.markCurrentSessionRead();
  }, [chat.markCurrentSessionRead]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && chat.isNearBottomRef.current) void chat.markCurrentSessionRead();
    });
    return () => subscription.remove();
  }, [chat.isNearBottomRef, chat.markCurrentSessionRead]);

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

  // Wire the explicitly available TTS capability into auto-play.
  useEffect(() => {
    if (tts.available && tts.autoPlay) {
      chat.voiceCallbackRef.current = (key, text, voice, speed) => {
        tts.play(key, text, voice, speed);
      };
    } else {
      chat.voiceCallbackRef.current = undefined;
    }
  }, [tts.available, tts.autoPlay]); // 依赖故意收窄（react-hooks/exhaustive-deps 在本仓库未启用）

  const handleVoiceSend = useCallback(async (fileUri: string, durationMs: number) => {
    await chat.sendVoiceMessage(fileUri, durationMs);
  }, [chat.sendVoiceMessage]); // 依赖故意收窄（react-hooks/exhaustive-deps 在本仓库未启用）

  const recorder = useVoiceRecorder({
    onVoiceSend: handleVoiceSend,
    identityKey: authUser ? `${authUser.tenantId}:${authUser.id}` : 'anonymous',
    onTooShort: () => {
      setTooShortTip(true);
      setTimeout(() => setTooShortTip(false), 2000);
    },
  });

  const effectiveSessionId = useMemo(() => {
    if (sessionId && sessionId !== 'new') return sessionId;
    return chat.sessionId;
  }, [sessionId, chat.sessionId]);
  useEffect(() => tts.stop, [effectiveSessionId, tts.stop]);

  const currentSession = useMemo(() => {
    if (!effectiveSessionId) return undefined;
    return chat.sessions.find(s => s.sessionId === effectiveSessionId);
  }, [effectiveSessionId, chat.sessions]);

  const sessionOwner = currentSession?.owner?.username;
  const headerAgentTarget = currentSession?.agentTarget ?? chat.activeAgentTarget;

  // Fetch the correct agent profile for the session owner (not the global ownerFilter-based one)
  const [sessionAgentProfile, setSessionAgentProfile] = useState<Awaited<ReturnType<typeof fetchAgentProfile>> | null>(null);
  useEffect(() => {
    const target = sessionOwner || authUser?.username;
    if (!target) { setSessionAgentProfile(null); return; }
    fetchAgentProfile(target)
      .then(setSessionAgentProfile)
      .catch(() => setSessionAgentProfile(null));
  }, [sessionOwner, authUser?.username]);

  // 顶栏 Agent 名回落链与 Web MobileLayout 一致：
  // 服务端绑定快照 → 目录里的专家名 → 本人 Agent 档案名 → 兜底。
  const headerAgentTargetLabel = currentSession
    ? currentSession.agentTargetSnapshot?.name ?? '绑定不可验证'
    : headerAgentTarget?.kind === 'personal'
      ? sessionAgentProfile?.name ?? '个人 Agent'
      : headerAgentTarget?.kind === 'org-agent'
        ? chat.agentTargetCatalog?.orgAgents.find(option => option.target.kind === 'org-agent' && option.target.orgAgentId === headerAgentTarget.orgAgentId)?.presentation?.name ?? '企业专家'
        : '绑定不可验证';

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

  // Agent 切换编排（目标选择 / shared 决策 / 确认 / 取消活动）整体收在独立 hook 里。
  const agentSwitch = useAgentSwitch({
    sessionId: effectiveSessionId ?? null,
    currentSession,
    onLaunchNewSession: useCallback(() => { router.replace('/chat/new'); }, [router]),
  });

  const handleSessionMenuAction = useCallback((actionId: string) => {
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
        '压缩会保留最近两轮对话原文与用户消息摘录，较早历史将被摘要替代以减少 Token 占用。原始记录仍完整保留，可随时检索。',
        [
          { text: '取消', style: 'cancel' },
          { text: '确认压缩', onPress: () => void chat.compactSession() },
        ],
      );
    }
  }, [sessionId, isNewSession, currentSession?.title, currentGroupId, chat.renameSession, chat.autoTitleSession, chat.compactSession, removeSessionsFromGroup]); // 依赖故意收窄（react-hooks/exhaustive-deps 在本仓库未启用）

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
  }, [chat.forkFromMessage, router]); // 依赖故意收窄（react-hooks/exhaustive-deps 在本仓库未启用）

  const handlePreviewMd = useCallback((filePath: string) => {
    if (getPreviewFileType(filePath) === 'html') {
      Alert.alert('旧预览已停用', 'Mobile V1 不打开 workspace HTML。请让发送方通过 Artifact viewer 正式交付。');
      return;
    }
    router.push({ pathname: '/chat/markdown-preview', params: { filePath, ...(sessionOwner ? { owner: sessionOwner } : {}) } });
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
  }, [sessionId, chat.sessionId, navigation]); // 依赖故意收窄（react-hooks/exhaustive-deps 在本仓库未启用）

  // 系统级分享流程：share-target 页面把已上传完成的文件存到 PendingSharedFilesContext，
  // 这里在挂载时一次性消费并灌入 fileUpload state，等用户补一句话发送。
  useEffect(() => {
    if (!pendingShared.hasPending()) return;
    const incoming = pendingShared.consume();
    if (incoming.files.length) chat.addUploadedFiles(incoming.files);
    if (incoming.text.trim()) {
      // Inbound text augments rather than replaces the owner-scoped composer draft.
      chat.setInput(mergeIncomingShareText(chat.input, incoming.text));
    }
  }, []); // 依赖故意收窄（react-hooks/exhaustive-deps 在本仓库未启用）

  const interactionDisabled = Boolean(chat.activeAgentTargetUnavailableReason || !chat.activeAgentTarget);

  // 场景直达：deep link 命中的起手指令预填进输入框（只预填，不自动发送）。
  useScenarioDeepLink(useCallback((prompt: string) => { chat.setInput(prompt); }, [chat.setInput]));

  // 空会话态：企业专家会话展示其起手任务，否则回落到岗位场景推荐卡。
  const activeExpert = useMemo(
    () => resolveActiveExpertPresentation(chat.agentTargetCatalog, headerAgentTarget),
    [chat.agentTargetCatalog, headerAgentTarget],
  );
  const showEmptyState = chat.messages.length === 0 && !chat.isLoadingMessages && !chat.loading;

  const transcriptValue = useMemo(
    () => ({ openTranscript: (target: SubagentTranscriptTarget) => setTranscriptTarget(target) }),
    [],
  );

  // 顶栏右侧的积分徽标：数据面与 Web BillingMiniBadge 同三条接口，30s 轮询。
  const billing = useBillingBadgeData(effectiveSessionId ?? null);

  const toggleUsageCard = useCallback((card: 'context' | 'billing') => {
    hapticLight();
    setActiveUsageCard(prev => (prev === card ? null : card));
  }, []);

  // 顶栏左键三态：子任务面板打开时先关面板，否则退回会话列表。
  const handleHeaderBack = useCallback(() => {
    if (transcriptTarget) { setTranscriptTarget(null); return; }
    router.back();
  }, [transcriptTarget, router]);

  const headerTitleNode = (
    <ChatHeaderTitle
      transcriptTitle={transcriptTarget?.title ?? null}
      sessionTitle={currentSession?.title || '新会话'}
      agentLabel={headerAgentTargetLabel}
      screenWidth={screenWidth}
      agentPickerDisabled={isAdminUser && chat.ownerFilter === null}
      onPressAgent={agentSwitch.openPicker}
      onPressBlank={scrollToTop}
    />
  );
  const headerRightNode = (
    <ChatHeaderRight
      tokenUsage={chat.tokenUsage}
      contextUsage={chat.contextUsage}
      showContextTokens={chat.modelList?.showContextTokens !== false}
      allowContextTokenDetails={chat.modelList?.allowContextTokenDetails === true}
      onToggleTokenCard={() => toggleUsageCard('context')}
      billing={billing}
      onToggleBillingCard={() => toggleUsageCard('billing')}
      ttsAvailable={tts.available}
      ttsAutoPlay={tts.autoPlay}
      onToggleTtsAutoPlay={tts.toggleAutoPlay}
    />
  );

  return (
    <View style={styles.container} testID="chat-screen">
      <Stack.Screen
        options={{
          title: '',
          headerLeft: () => <BackButton onPress={handleHeaderBack} />,
          unstable_headerLeftItems: () => [glassFree(<BackButton onPress={handleHeaderBack} />)],
          headerTitle: () => headerTitleNode,
          headerRight: () => headerRightNode,
          unstable_headerRightItems: () => [glassFree(headerRightNode)],
        }}
      />

      <ConnectionBanner connectionState={chat.connectionState} isOnline={isOnline} />
      {/* /compact skipped 轻提示：历史太短未压缩时显示 note，4s 自动消失 */}
      {chat.compactionNotice ? (
        <View style={styles.compactionNoticeWrap} pointerEvents="none">
          <View style={styles.compactionNoticePill}>
            <Text style={styles.compactionNoticeText}>{chat.compactionNotice}</Text>
          </View>
        </View>
      ) : null}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={headerHeight}>
      {/* 反馈入口的数据面开关：无会话或后端 503 时 value=null，气泡里的按钮零渲染 */}
      {showEmptyState ? (
        activeExpert ? (
          <ExpertWelcome expert={activeExpert} onPrefill={chat.setInput} />
        ) : (
          <EmptyChatRecommendCards onTryScenario={(prompt) => chat.setInput(prompt)} />
        )
      ) : null}
      <MessageFeedbackProvider sessionId={chat.sessionId}>
      <SubagentTranscriptProvider value={transcriptValue}>
      <MessageList
        headerPadding={0}
        bottomPadding={Platform.OS === 'ios' ? composerHeight - (isKeyboardOpen ? insets.bottom : 0) : defaultBottomPadding}
        messages={chat.messages}
        loading={chat.loading}
        compacting={chat.compacting}
        isLoadingMessages={chat.isLoadingMessages}
        shouldScrollRef={chat.shouldScrollRef}
        isNearBottomRef={chat.isNearBottomRef}
        listRef={listRef}
        onPermissionResponse={chat.handlePermissionResponse}
        onAskUserResponse={chat.handleAskUserResponse}
        onRetryMessage={recoverFromFailure}
        onForkMessage={handleFork}
        onPreviewMd={handlePreviewMd}
        onTtsPlay={tts.available ? tts.play : undefined}
        onScrollBtnVisibilityChange={handleScrollButtonVisibility}
        hasMoreHistory={chat.hasMoreHistory}
        isLoadingEarlier={chat.isLoadingEarlier}
        onLoadEarlier={chat.loadEarlierMessages}
      />
      </SubagentTranscriptProvider>
      </MessageFeedbackProvider>
      </KeyboardAvoidingView>
      <KeyboardStickyView style={styles.inputOverlay} offset={{ closed: 0, opened: 0 }}>
        <View onLayout={handleComposerLayout}>
        <QueuedMessageBar />
        <AskUserPromptPanel
          messages={chat.messages}
          disabled={interactionDisabled}
          onAskUserResponse={chat.handleAskUserResponse}
          onPermissionResponse={chat.handlePermissionResponse}
        />
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
          disabledReason={chat.activeAgentTargetUnavailableReason?.message ?? (!chat.activeAgentTarget ? '没有可用的 Agent 目标，请联系组织管理员。' : null)}
          modelList={chat.modelList}
          selectedModel={chat.selectedModel}
          onModelChange={chat.onModelChange}
          modelExtraSections={extraSections}
          onModelExtraAction={handleSessionMenuAction}
          modelDrillDowns={drillDowns}
          onModelDrillDownSelect={handleDrillDownSelect}
          sessionSandboxProfile={currentSession?.sandboxProfile}
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
            <ChevronDown size={20} color={colors.mutedForeground} strokeWidth={2} />
          </TouchableOpacity>
        </Animated.View>
      </KeyboardStickyView>

      {/* 用量卡：上下文明细与积分明细互斥展开 */}
      {activeUsageCard === 'context' && chat.tokenUsage && (
        <TokenDetailOverlay
          tokenUsage={chat.tokenUsage}
          contextUsage={chat.contextUsage}
          messages={chat.messages}
          onOpenChildSession={(childSessionId) => {
            setActiveUsageCard(null);
            router.push({ pathname: '/chat/[sessionId]' as any, params: { sessionId: childSessionId } });
          }}
          sessionId={sessionId || ''}
          topOffset={0}
          onDismiss={() => setActiveUsageCard(null)}
        />
      )}
      {activeUsageCard === 'billing' && (
        <BillingDetailOverlay
          data={billing}
          isAdmin={isAdminUser}
          onDismiss={() => setActiveUsageCard(null)}
        />
      )}

      {/* Agent 目标选择与切换确认 */}
      <OrgAgentPickerSheet
        visible={agentSwitch.pickerVisible}
        onClose={agentSwitch.closePicker}
        catalog={chat.agentTargetCatalog}
        activeTarget={headerAgentTarget ?? null}
        onSelect={agentSwitch.requestAgentSwitch}
      />
      {agentSwitch.confirmation ? (
        <AgentSwitchConfirmation
          visible
          targetName={agentSwitch.confirmation.targetName}
          impacts={agentSwitch.confirmation.impacts}
          cancelling={agentSwitch.cancelling}
          cancelError={agentSwitch.cancelError}
          onKeepOldOpen={agentSwitch.keepOldOpen}
          onCancelActive={agentSwitch.cancelActive}
          onClose={agentSwitch.dismissConfirmation}
        />
      ) : null}

      {/* 子任务完整过程：全屏覆盖，复用 MessageList 渲染子会话回放 */}
      {transcriptTarget && (
        <SubagentTranscriptSheet
          visible
          childSessionId={transcriptTarget.childSessionId}
          title={transcriptTarget.title}
          onClose={() => setTranscriptTarget(null)}
        />
      )}
    </View>
  );
}

function useScreenStyles(colors: ThemeColors) {
  return useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
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
    compactionNoticeWrap: {
      position: 'absolute',
      top: 12,
      left: 0,
      right: 0,
      alignItems: 'center',
      zIndex: 10,
    },
    compactionNoticePill: {
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      paddingHorizontal: spacing.md + 2,
      paddingVertical: spacing.sm,
      maxWidth: '85%',
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.12,
      shadowRadius: 6,
      elevation: 4,
      borderWidth: 1,
      borderColor: colors.border,
    },
    compactionNoticeText: {
      ...fontScale.xs,
      color: colors.mutedForeground,
      textAlign: 'center',
    },
  }), [colors]);
}
