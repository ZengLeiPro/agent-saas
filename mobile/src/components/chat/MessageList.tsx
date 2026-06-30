import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import { View, StyleSheet, Text, ActivityIndicator, Animated } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { MessageItem, RenderItem, AgentProfile } from '@agent/shared';
import { groupMessages } from '@agent/shared';
import { MessageItemView } from './MessageItem';
import { scheduleIdle } from '../../lib/ric';
import { useColors, useChatTypography, spacing, radius } from '../../theme';
import type { ThemeColors } from '../../theme';
import { useChatAppState } from '../../contexts/ChatAppStateContext';
import { useAuth } from '../../contexts/AuthContext';
import type { AuthUser } from '@agent/shared';
import { AgentAvatar, UserAvatar } from '../AgentAvatar';

/** Distance from bottom (in px) within which we consider the user "at bottom" */
const NEAR_BOTTOM_THRESHOLD = 150;

// ---------------------------------------------------------------------------
// AI Bubble Grouping
// ---------------------------------------------------------------------------

interface AiBubbleGroup {
  type: 'ai_bubble';
  id: string;
  items: RenderItem[];
}

type BubbleRenderItem = RenderItem | AiBubbleGroup;

function groupIntoBubbles(items: RenderItem[]): BubbleRenderItem[] {
  const result: BubbleRenderItem[] = [];
  let currentGroup: RenderItem[] = [];

  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    result.push({
      type: 'ai_bubble' as const,
      id: `bubble-${currentGroup[0].id}`,
      items: [...currentGroup],
    });
    currentGroup = [];
  };

  for (const item of items) {
    if (item.type === 'user' || item.type === 'user-voice') {
      flushGroup();
      result.push(item);
    } else if (item.type === 'text' || item.type === 'voice') {
      currentGroup.push(item);
      flushGroup();
    } else {
      currentGroup.push(item);
    }
  }

  flushGroup();
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AVATAR_SIZE = 36;

function getFirstTimestamp(items: RenderItem[]): number | undefined {
  for (const item of items) {
    if ('timestamp' in item && item.timestamp) return item.timestamp;
    if (item.type === 'activity_group') {
      for (const sub of item.items) {
        if ('timestamp' in sub && sub.timestamp) return sub.timestamp;
      }
    }
  }
  return undefined;
}

function formatMessageTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hour}:${min}`;
}

// ---------------------------------------------------------------------------
// Header style factory (shared by both header components)
// ---------------------------------------------------------------------------

/** Extra gap inserted before a sender-change header (independent of header's own margins) */
const SENDER_GAP = 10;
const TAIL_SIZE = 6;

function createHeaderStyles(colors: ThemeColors, typo: ReturnType<typeof useChatTypography>) {
  return StyleSheet.create({
    senderGap: {
      height: SENDER_GAP,
    },
    aiRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 4,
    },
    userRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 10,
      marginBottom: 4,
    },
    name: {
      ...typo.bodySmall,
      color: colors.foreground,
    },
    time: {
      ...typo.caption,
      color: colors.mutedForeground,
    },
    aiTail: {
      width: 0,
      height: 0,
      borderLeftWidth: TAIL_SIZE,
      borderLeftColor: 'transparent',
      borderRightWidth: TAIL_SIZE,
      borderRightColor: 'transparent',
      borderBottomWidth: TAIL_SIZE,
      borderBottomColor: colors.card,
      marginLeft: AVATAR_SIZE / 2 - TAIL_SIZE, // center under avatar
      marginBottom: -1,
    },
    userTail: {
      width: 0,
      height: 0,
      borderLeftWidth: TAIL_SIZE,
      borderLeftColor: 'transparent',
      borderRightWidth: TAIL_SIZE,
      borderRightColor: 'transparent',
      borderBottomWidth: TAIL_SIZE,
      borderBottomColor: colors.userBubble,
      alignSelf: 'flex-end' as const,
      marginRight: AVATAR_SIZE / 2 - TAIL_SIZE, // center under avatar
      marginBottom: -1,
    },
  });
}

// ---------------------------------------------------------------------------
// Message Header Components (React.memo leaf nodes)
// ---------------------------------------------------------------------------

interface AiHeaderProps {
  agentName?: string;
  agentAvatar?: string;
  agentUsername?: string;
  agentAvatarVersion?: number;
  timestamp?: number;
}

const AiMessageHeader = React.memo(function AiMessageHeader({
  agentName, agentAvatar, agentUsername, agentAvatarVersion, timestamp,
}: AiHeaderProps) {
  const colors = useColors();
  const typo = useChatTypography();
  const s = useMemo(() => createHeaderStyles(colors, typo), [colors, typo]);
  const timeStr = formatMessageTime(timestamp);

  return (
    <>
      <View style={s.senderGap} />
      <View style={s.aiRow}>
        <AgentAvatar avatar={agentAvatar} username={agentUsername} size={AVATAR_SIZE} version={agentAvatarVersion} />
        <Text style={s.name}>{agentName || 'AI'}</Text>
        {timeStr ? <Text style={s.time}>{timeStr}</Text> : null}
      </View>
      <View style={s.aiTail} />
    </>
  );
});

interface UserHeaderProps {
  userId?: string;
  realName?: string;
  username?: string;
  userAvatar?: string;
  userAvatarVersion?: number;
  timestamp?: number;
}

const UserMessageHeader = React.memo(function UserMessageHeader({
  userId, realName, username, userAvatar, userAvatarVersion, timestamp,
}: UserHeaderProps) {
  const colors = useColors();
  const typo = useChatTypography();
  const s = useMemo(() => createHeaderStyles(colors, typo), [colors, typo]);
  const timeStr = formatMessageTime(timestamp);

  return (
    <>
      <View style={s.senderGap} />
      <View style={s.userRow}>
        {timeStr ? <Text style={s.time}>{timeStr}</Text> : null}
        <Text style={s.name}>{realName || username || '我'}</Text>
        <UserAvatar userId={userId} avatar={userAvatar} size={AVATAR_SIZE} version={userAvatarVersion} />
      </View>
      <View style={s.userTail} />
    </>
  );
});

// ---------------------------------------------------------------------------
// AI Bubble View
// ---------------------------------------------------------------------------

interface AiBubbleViewProps {
  group: AiBubbleGroup;
  skipAnimation: boolean;
  lastActivityGroupId: string | null;
  onPermissionResponse?: (interactionId: string, allow: boolean) => Promise<void>;
  onAskUserResponse?: (interactionId: string, answers: Record<string, string>) => Promise<void>;
  onPreviewMd?: (filePath: string) => void;
  onTtsPlay?: (key: string, text: string) => void;
  loading: boolean;
  showHeader?: boolean;
  agentName?: string;
  agentAvatar?: string;
  agentUsername?: string;
  agentAvatarVersion?: number;
}

const AiBubbleView = React.memo(function AiBubbleView({
  group,
  skipAnimation,
  lastActivityGroupId,
  onPermissionResponse,
  onAskUserResponse,
  onPreviewMd,
  onTtsPlay,
  loading,
  showHeader,
  agentName,
  agentAvatar,
  agentUsername,
  agentAvatarVersion,
}: AiBubbleViewProps) {
  const colors = useColors();
  const fadeAnim = useRef(new Animated.Value(skipAnimation ? 1 : 0)).current;
  useEffect(() => {
    if (skipAnimation) return;
    const anim = Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const bubbleStyle = useMemo(() => ({
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 0,
    marginBottom: 8,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 1 } as const,
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  }), [colors.card, colors.shadow]);

  const timestamp = useMemo(() => getFirstTimestamp(group.items), [group.items]);

  return (
    <>
      {showHeader && (
        <AiMessageHeader
          agentName={agentName}
          agentAvatar={agentAvatar}
          agentUsername={agentUsername}
          agentAvatarVersion={agentAvatarVersion}
          timestamp={timestamp}
        />
      )}
      <Animated.View style={[{ opacity: fadeAnim }, bubbleStyle]}>
        {group.items.map(subItem => (
          <MessageItemView
            key={subItem.id}
            item={subItem}
            isLast={subItem.type === 'activity_group' && subItem.id === lastActivityGroupId}
            skipAnimation
            onPermissionResponse={onPermissionResponse}
            onAskUserResponse={onAskUserResponse}
            onPreviewMd={onPreviewMd}
            onTtsPlay={onTtsPlay}
            isLoading={loading}
          />
        ))}
      </Animated.View>
    </>
  );
});

// ---------------------------------------------------------------------------
// Message List
// ---------------------------------------------------------------------------

interface MessageListProps {
  messages: MessageItem[];
  loading: boolean;
  isLoadingMessages?: boolean;
  shouldScrollRef: React.MutableRefObject<boolean>;
  isNearBottomRef: React.MutableRefObject<boolean>;
  listRef?: React.RefObject<FlashListRef<RenderItem> | null>;
  onPermissionResponse?: (interactionId: string, allow: boolean) => Promise<void>;
  onAskUserResponse?: (interactionId: string, answers: Record<string, string>) => Promise<void>;
  onRetryMessage?: (message: MessageItem) => void;
  onForkMessage?: (message: MessageItem) => void;
  onPreviewMd?: (filePath: string) => void;
  onTtsPlay?: (key: string, text: string) => void;
  headerPadding?: number;
  bottomPadding?: number;
  onScrollBtnVisibilityChange?: (visible: boolean) => void;
}

export function MessageList({
  messages,
  loading,
  isLoadingMessages,
  shouldScrollRef,
  isNearBottomRef,
  listRef: externalRef,
  onPermissionResponse,
  onAskUserResponse,
  onRetryMessage,
  onForkMessage,
  onPreviewMd,
  onTtsPlay,
  headerPadding,
  bottomPadding,
  onScrollBtnVisibilityChange,
}: MessageListProps) {
  const colors = useColors();
  const internalRef = useRef<FlashListRef<RenderItem>>(null);
  const listRef = externalRef ?? internalRef;

  const filteredMessages = useMemo(() => messages.filter(m => m.type !== 'file_download'), [messages]);
  const renderItems = useMemo(() => groupMessages(filteredMessages, loading), [filteredMessages, loading]);
  const bubbleItems = useMemo(() => groupIntoBubbles(renderItems), [renderItems]);

  const initialScrollDoneRef = useRef(false);
  const prevLengthRef = useRef(0);

  const firstUserMsgId = useMemo(() => {
    for (const m of filteredMessages) {
      if (m.type === 'user') return m.id;
    }
    return null;
  }, [filteredMessages]);

  // Show header when the "side" (user vs ai) changes from the previous item.
  const headerItemIds = useMemo(() => {
    const ids = new Set<string>();
    let prevSide: 'user' | 'ai' | null = null;
    for (const item of bubbleItems) {
      const side = (item.type === 'user' || item.type === 'user-voice') ? 'user' : 'ai';
      if (side !== prevSide) {
        ids.add(item.id);
      }
      prevSide = side;
    }
    return ids;
  }, [bubbleItems]);

  const lastActivityGroupId = useMemo(() => {
    for (let i = bubbleItems.length - 1; i >= 0; i--) {
      const item = bubbleItems[i];
      if (item.type === 'ai_bubble') {
        for (let j = item.items.length - 1; j >= 0; j--) {
          if (item.items[j].type === 'activity_group') return item.items[j].id;
        }
      }
    }
    return null;
  }, [bubbleItems]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    const nearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
    isNearBottomRef.current = nearBottom;
    onScrollBtnVisibilityChange?.(!nearBottom && distanceFromBottom > NEAR_BOTTOM_THRESHOLD * 2);
  }, [isNearBottomRef, onScrollBtnVisibilityChange]);

  useEffect(() => {
    const len = bubbleItems.length;
    if (len === 0) {
      prevLengthRef.current = 0;
      initialScrollDoneRef.current = false;
      return;
    }

    const isInitialLoad = prevLengthRef.current === 0 && len > 0;
    prevLengthRef.current = len;

    if (isInitialLoad) {
      shouldScrollRef.current = false;
      initialScrollDoneRef.current = false;
      const cancel = scheduleIdle(() => {
        listRef.current?.scrollToEnd({ animated: false });
        initialScrollDoneRef.current = true;
        isNearBottomRef.current = true;
      });
      return cancel;
    }

    if (!initialScrollDoneRef.current) return;

    const forced = shouldScrollRef.current;
    shouldScrollRef.current = false;

    // Auto-follow: check isNearBottomRef at effect-execution time to avoid race with user scroll
    if (forced || isNearBottomRef.current) {
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 50);
    }
  }, [bubbleItems, shouldScrollRef, listRef, isNearBottomRef]);

  // Stable refs for data that changes rarely — keeps renderItem deps minimal
  const { user } = useAuth();
  const { agentProfile, sessionParticipants } = useChatAppState();

  const displayUser = useMemo(() => {
    const owner = sessionParticipants?.owner;
    if (owner) {
      return { id: owner.userId, realName: owner.realName, username: owner.username, avatar: owner.avatar, avatarVersion: owner.avatarVersion } as AuthUser;
    }
    return user;
  }, [sessionParticipants?.owner, user]);
  const displayAgent = sessionParticipants?.agent ?? agentProfile;

  // FlashList extraData：当参与者身份变化时强制重新渲染已有项
  const extraData = useMemo(
    () => ({ displayUser, displayAgent }),
    [displayUser, displayAgent],
  );

  const userRef = useRef(displayUser);
  userRef.current = displayUser;
  const agentRef = useRef(displayAgent);
  agentRef.current = displayAgent;

  const renderItem = useCallback(({ item }: { item: BubbleRenderItem }) => {
    const showHeader = headerItemIds.has(item.id);
    const agent = agentRef.current;
    const usr = userRef.current;

    if (item.type === 'ai_bubble') {
      return (
        <AiBubbleView
          group={item}
          skipAnimation={!initialScrollDoneRef.current}
          lastActivityGroupId={lastActivityGroupId}
          onPermissionResponse={onPermissionResponse}
          onAskUserResponse={onAskUserResponse}
          onPreviewMd={onPreviewMd}
          onTtsPlay={onTtsPlay}
          loading={loading}
          showHeader={showHeader}
          agentName={agent?.name}
          agentAvatar={agent?.avatar}
          agentUsername={agent?.username}
          agentAvatarVersion={agent?.avatarVersion}
        />
      );
    }

    // User / user-voice messages
    const timestamp = 'timestamp' in item ? item.timestamp : undefined;
    return (
      <>
        {showHeader && (
          <UserMessageHeader
            userId={usr?.id}
            realName={usr?.realName}
            username={usr?.username}
            userAvatar={usr?.avatar}
            userAvatarVersion={usr?.avatarVersion}
            timestamp={timestamp}
          />
        )}
        <MessageItemView
          item={item}
          skipAnimation={!initialScrollDoneRef.current}
          onRetryMessage={onRetryMessage}
          onForkMessage={onForkMessage}
          isFirstUser={item.type === 'user' && item.id === firstUserMsgId}
          isLoading={loading}
        />
      </>
    );
  }, [headerItemIds, lastActivityGroupId, onPermissionResponse, onAskUserResponse, onRetryMessage, onForkMessage, firstUserMsgId, loading, onPreviewMd, onTtsPlay]);

  const getItemType = useCallback((item: BubbleRenderItem) => item.type, []);
  const keyExtractor = useCallback((item: BubbleRenderItem) => item.id, []);

  const showCenterLoading = isLoadingMessages && messages.length === 0 && !loading;
  const showSyncLoading = isLoadingMessages && messages.length > 0 && !loading;

  const syncFooter = useMemo(() => {
    if (!showSyncLoading) return null;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: spacing.md }}>
        <ActivityIndicator size="small" color={colors.mutedForeground} />
        <Text style={{ fontSize: 13, color: colors.mutedForeground }}>正在加载最新消息...</Text>
      </View>
    );
  }, [showSyncLoading, colors.mutedForeground]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    content: {
      backgroundColor: colors.background,
      paddingHorizontal: spacing.md,
      paddingTop: (headerPadding ?? 0) + spacing.md,
      paddingBottom: (bottomPadding ?? 0) + spacing.md,
    },
    centerLoading: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: colors.background,
      paddingTop: (headerPadding ?? 0) + spacing.md,
      paddingBottom: (bottomPadding ?? 0) + spacing.md,
    },
  }), [colors, headerPadding, bottomPadding]);

  if (showCenterLoading) {
    return (
      <View style={styles.centerLoading}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text style={{ fontSize: 13, color: colors.mutedForeground }}>加载中...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlashList
        ref={listRef as any}
        data={bubbleItems}
        renderItem={renderItem}
        extraData={extraData}
        getItemType={getItemType}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.content}
        scrollIndicatorInsets={{ bottom: Math.max(0, (bottomPadding ?? 0) - 35) }}
        drawDistance={250}
        overrideProps={{ initialDrawBatchSize: 15 }}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        ListFooterComponent={syncFooter}
      />
    </View>
  );
}
