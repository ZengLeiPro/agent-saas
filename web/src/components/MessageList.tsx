import { memo, useMemo, useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref, type MutableRefObject } from 'react';
import { ArrowDown, Loader2 } from 'lucide-react';
import { MessageItem as MessageItemType, type RenderItem } from './types';
import { MessageItem, type TtsProps } from './MessageItem';
import { ActivityGroupBlock } from './ActivityGroupBlock';
import { CompactionDivider } from './CompactionDivider';
import { asCompactionItem } from '@/lib/compaction';
import { useGroupedMessages } from './useGroupedMessages';
import { ErrorBoundary } from './ErrorBoundary';
import type { TtsState } from '@/hooks/useTtsPlayer';
import { useVoicePlayer } from '@/hooks/useVoicePlayer';
import { useAuth } from '@/contexts/AuthContext';
import { AgentAvatar, UserAvatar } from './AgentAvatar';
import type { AgentProfile, AskUserAnswers, SessionParticipants } from '@agent/shared';

// ---------------------------------------------------------------------------
// AI Bubble Grouping — mirrors mobile's groupIntoBubbles()
// ---------------------------------------------------------------------------

interface AiBubbleGroup {
  type: 'ai_bubble';
  id: string;
  items: RenderItem[];
}

type BubbleRenderItem = RenderItem | AiBubbleGroup;

/**
 * Groups consecutive AI render items into a single bubble.
 * A bubble ends when a `text` or `voice` item is encountered (terminal output).
 * User / user-voice items are never grouped — they render standalone.
 */
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
    // file_download 两条路径,分别处理:
    //  - [FILE] 标记路径(无 artifactId): MessageItem 在 text 内联展开,顶层跳过。
    //  - legacy artifact_created 事件(有 artifactId): 无关联 text 载体,作为独立顶层项
    //    渲染(flushGroup 后 push,不进 AI bubble 避免与 thinking/tool_use 混排)。
    if (item.type === 'file_download') {
      if (!item.artifactId) continue;
      flushGroup();
      result.push(item);
      continue;
    }
    if (item.type === 'user' || item.type === 'user-voice') {
      flushGroup();
      result.push(item);
    } else if (item.type === 'system-error') {
      // system-error 是会话级独立 alert,不与 AI 输出共享 bubble,也不归属 user 侧。
      // 单独 push,渲染时居中无头像 header。
      flushGroup();
      result.push(item);
    } else if (asCompactionItem(item)) {
      // 压缩状态条/分界线：横铺独立渲染单元（水平线风格,非气泡）
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
// Header helpers
// ---------------------------------------------------------------------------

const AVATAR_SIZE = 36;
const SENDER_GAP = 12;
const TAIL_SIZE = 6;
/** 用户气泡描边色（与 MessageItem 气泡 ring 同色），SVG tail 共用以保证描边连续 */
const USER_TAIL_STROKE = 'rgba(232,132,58,0.22)';

function formatHeaderTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
}

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

const tailBase: React.CSSProperties = {
  width: 0,
  height: 0,
  borderLeft: `${TAIL_SIZE}px solid transparent`,
  borderRight: `${TAIL_SIZE}px solid transparent`,
  marginBottom: -1,
};

function AiMessageHeader({ agentProfile, timestamp }: { agentProfile?: AgentProfile | null; timestamp?: number }) {
  const timeStr = formatHeaderTime(timestamp);
  return (
    <>
      <div style={{ height: SENDER_GAP }} />
      <div className="flex items-center gap-2.5" style={{ marginBottom: 4 }}>
        <AgentAvatar
          avatar={agentProfile?.avatar}
          username={agentProfile?.username}
          size={AVATAR_SIZE}
          version={agentProfile?.avatarVersion}
        />
        <span className="text-sm text-foreground">{agentProfile?.name || 'AI'}</span>
        {timeStr && <span className="text-xs text-muted-foreground">{timeStr}</span>}
      </div>
      <div
        style={{
          ...tailBase,
          borderBottom: `${TAIL_SIZE}px solid hsl(var(--card))`,
          marginLeft: AVATAR_SIZE / 2 - TAIL_SIZE,
        }}
      />
    </>
  );
}

function UserMessageHeader({ userId, realName, username, avatar, avatarVersion, timestamp }: {
  userId?: string;
  realName?: string;
  username?: string;
  avatar?: string;
  avatarVersion?: number;
  timestamp?: number;
}) {
  const timeStr = formatHeaderTime(timestamp);
  const tailWidth = TAIL_SIZE * 2;
  return (
    <>
      <div style={{ height: SENDER_GAP }} />
      <div className="flex items-center justify-end gap-2.5" style={{ marginBottom: 4 }}>
        {timeStr && <span className="text-xs text-muted-foreground">{timeStr}</span>}
        <span className="text-sm text-foreground">{realName || username || '我'}</span>
        <UserAvatar userId={userId} avatar={avatar} size={AVATAR_SIZE} version={avatarVersion} />
      </div>
      {/*
       * 用户气泡指向三角：SVG 而非 CSS border，让 stroke 与气泡的 ring 描边对齐。
       * path 是开放的（M-L-L 不闭合），fill 自动闭合但 stroke 只描"外侧"两条边，
       * 底部与气泡相接处不画 stroke。
       * zIndex:1 让 SVG 盖住气泡 ring 的 box-shadow，否则 ring 横线会穿过三角形底边。
       */}
      <svg
        width={tailWidth}
        height={TAIL_SIZE}
        style={{
          overflow: 'visible',
          marginBottom: -1,
          marginRight: AVATAR_SIZE / 2 - TAIL_SIZE,
          alignSelf: 'flex-end',
          position: 'relative',
          zIndex: 1,
        }}
        aria-hidden
      >
        <path
          d={`M 0 ${TAIL_SIZE} L ${TAIL_SIZE} 0 L ${tailWidth} ${TAIL_SIZE}`}
          fill="hsl(var(--user-bubble))"
          stroke={USER_TAIL_STROKE}
          strokeWidth={1}
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}

interface MessageListProps {
  messages: MessageItemType[];
  loading: boolean;
  isLoadingMessages?: boolean;
  onPermissionResponse?: (interactionId: string, allow: boolean) => void;
  onAskUserResponse?: (interactionId: string, answers: AskUserAnswers) => void;
  onRetry?: (message: MessageItemType) => void;
  onFork?: (message: MessageItemType) => void;
  lastMessageRef?: Ref<HTMLDivElement>;
  scrollContainerRef?: Ref<HTMLDivElement>;
  isNearBottomRef?: MutableRefObject<boolean>;
  tts?: TtsProps;
  /** 独立传入，避免 ttsProps 引用因 stateMap 变化而重建 */
  ttsStateMap?: Record<string, TtsState>;
  agentProfile?: AgentProfile | null;
  sessionParticipants?: SessionParticipants | null;
  /** 分享页等只读上下文可显式指定调试模式；未传时沿用当前登录用户设置。 */
  debugModeOverride?: boolean;
  /**
   * 空会话槽位：会话没有任何消息且不在加载中时渲染（场景推荐卡等）。
   * 注意：本组件被 memo，上层需传入引用稳定（useMemo）的节点，避免破坏 memo。
   */
  emptySlot?: React.ReactNode;
}

export const MessageList = memo(function MessageList({
  messages,
  loading,
  isLoadingMessages,
  onPermissionResponse,
  onAskUserResponse,
  onRetry,
  onFork,
  lastMessageRef,
  scrollContainerRef,
  isNearBottomRef,
  tts,
  ttsStateMap,
  agentProfile,
  sessionParticipants,
  debugModeOverride,
  emptySlot,
}: MessageListProps) {
  const NEAR_BOTTOM_THRESHOLD = 150;
  // 本地捕获滚动容器 DOM，供「回到最新消息」浮动按钮判定距离与主动滚动。
  // 通过 setContainerRef 合并到外部传入的 scrollContainerRef，不破坏原有引用契约。
  const internalContainerRef = useRef<HTMLDivElement | null>(null);
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    internalContainerRef.current = node;
    if (typeof scrollContainerRef === 'function') {
      scrollContainerRef(node);
    } else if (scrollContainerRef) {
      (scrollContainerRef as MutableRefObject<HTMLDivElement | null>).current = node;
    }
  }, [scrollContainerRef]);

  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const syncNearBottomState = useCallback(() => {
    const el = internalContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNear = distance < NEAR_BOTTOM_THRESHOLD;
    if (isNearBottomRef) isNearBottomRef.current = isNear;
    setShowJumpToBottom((prev) => (prev === !isNear ? prev : !isNear));
  }, [isNearBottomRef]);

  const handleScroll = useCallback(() => {
    syncNearBottomState();
  }, [syncNearBottomState]);

  const handleJumpToBottom = useCallback(() => {
    const el = internalContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  const voicePlayer = useVoicePlayer();
  const groupedMessages = useGroupedMessages(messages, loading);
  const bubbleItems = useMemo(() => groupIntoBubbles(groupedMessages), [groupedMessages]);
  const lastRenderIdx = bubbleItems.length - 1;

  // 构建 MessageItem id → 原始 messages 索引的映射（用于 TTS key 稳定性）
  const msgIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      map.set(messages[i].id, i);
    }
    return map;
  }, [messages]);

  // agent 尚未回复：loading 中且最后一个渲染单元是用户消息（或无消息）
  const lastItem = bubbleItems[lastRenderIdx];
  const showAgentLoading = loading && (!lastItem || (lastItem.type !== 'ai_bubble' && lastItem.type !== 'activity_group' && lastItem.type === 'user'));

  // 场景 A：无缓存，从服务端加载中 → 居中 spinner
  const showCenterLoading = isLoadingMessages && messages.length === 0 && !loading;
  // 场景 B：有缓存已展示，后台刷新中 → 底部 spinner + 文案
  const showSyncLoading = isLoadingMessages && messages.length > 0 && !loading;

  // 最后一个 activity_group 的 id（用于默认展开）
  const lastActivityGroupId = useMemo(() => {
    // Search through bubble items; activity_groups can be inside ai_bubble groups
    for (let i = bubbleItems.length - 1; i >= 0; i--) {
      const item = bubbleItems[i];
      if (item.type === 'ai_bubble') {
        for (let j = item.items.length - 1; j >= 0; j--) {
          if (item.items[j].type === 'activity_group') return item.items[j].id;
        }
      }
      if (item.type === 'activity_group') return item.id;
    }
    return null;
  }, [bubbleItems]);

  // 第一条 user 消息的 id（不显示 fork 按钮）
  const firstUserMsgId = useMemo(() => {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].type === 'user') return messages[i].id;
    }
    return null;
  }, [messages]);

  // 发送方切换时显示头像行
  const headerItemIds = useMemo(() => {
    const ids = new Set<string>();
    let prevSide: 'user' | 'ai' | null = null;
    for (const item of bubbleItems) {
      // system-error / compaction 是中性渲染单元,不参与 user/ai 头像 header 切换计算（也不打断后续 prevSide）
      if (item.type === 'system-error' || asCompactionItem(item)) continue;
      const side = (item.type === 'user' || item.type === 'user-voice') ? 'user' : 'ai';
      if (side !== prevSide) ids.add(item.id);
      prevSide = side;
    }
    return ids;
  }, [bubbleItems]);

  // 消息列表或加载态变化后重算「距底距离」，让浮动按钮及时出/隐（新消息将底部推远时也能触发）。
  useLayoutEffect(() => {
    syncNearBottomState();
  }, [syncNearBottomState, bubbleItems, showAgentLoading, showSyncLoading]);

  // ResizeObserver：内容异步撑高（图片/PDF 首次布局）时同样重算。
  useEffect(() => {
    const el = internalContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => syncNearBottomState());
    ro.observe(el);
    // 观察内部内容区，捕获内容高度变化
    const inner = el.firstElementChild;
    if (inner instanceof Element) ro.observe(inner);
    return () => ro.disconnect();
  }, [syncNearBottomState]);

  const { user } = useAuth();
  const debugMode = debugModeOverride ?? user?.debugMode === true;
  const displayUser = useMemo(() => {
    const owner = sessionParticipants?.owner;
    if (owner) {
      return { id: owner.userId, realName: owner.realName, username: owner.username, avatar: owner.avatar, avatarVersion: owner.avatarVersion };
    }
    return user ? { id: user.id, realName: user.realName, username: user.username, avatar: user.avatar, avatarVersion: user.avatarVersion } : null;
  }, [sessionParticipants?.owner, user]);
  const displayAgent = sessionParticipants?.agent ?? agentProfile;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={setContainerRef} onScroll={showCenterLoading ? undefined : handleScroll} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain">
      <div className="content-container flex flex-col gap-3 pt-4 pb-4 px-5 md:px-3">
        {showCenterLoading ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span className="text-sm">加载中...</span>
            </div>
          </div>
        ) : bubbleItems.length === 0 && !loading && emptySlot ? (
          // 新会话空白态：展示空会话槽位（场景推荐卡）；一旦产生消息立即让位
          emptySlot
        ) : bubbleItems.map((item, ri) => {
          const showHeader = headerItemIds.has(item.id);

          // --- AI Bubble Group ---
          if (item.type === 'ai_bubble') {
            const timestamp = getFirstTimestamp(item.items);
            return (
              <div
                key={item.id}
                ref={ri === lastRenderIdx && !showAgentLoading ? lastMessageRef : undefined}
                className="flex flex-col"
              >
                {showHeader && (
                  <AiMessageHeader agentProfile={displayAgent} timestamp={timestamp} />
                )}
                <div className="rounded-lg bg-card px-3 py-2 shadow-[0_2px_4px_rgba(15,23,42,0.06),0_8px_24px_-6px_rgba(15,23,42,0.10)]">
                  {item.items.map((sub) => {
                    // 双重保险:此层理论上不该出现 file_download。
                    // - [FILE] 内联(无 artifactId): groupIntoBubbles 已 continue 掉。
                    // - legacy artifact_created 卡片(有 artifactId): groupIntoBubbles 已独立提到顶层。
                    if (sub.type === 'file_download') return null;
                    if (sub.type === 'activity_group') {
                      return (
                        <ErrorBoundary key={sub.id} inline>
                          <ActivityGroupBlock items={sub.items} isActive={sub.isActive} isLast={sub.id === lastActivityGroupId} debugMode={debugMode} />
                        </ErrorBoundary>
                      );
                    }
                    const origIndex = msgIndexMap.get(sub.id) ?? 0;
                    const msgKey = `msg-${origIndex}`;
                    const ttsState = ttsStateMap?.[msgKey] || 'idle';
                    const ttsIsActive = tts?.activeKey === msgKey;
                    const voicePlayState = sub.type === 'user-voice'
                      ? voicePlayer.getState(`voice-msg-${sub.id}`)
                      : undefined;
                    return (
                      <ErrorBoundary key={sub.id} inline>
                        <MessageItem
                          message={sub}
                          index={origIndex}
                          onPermissionResponse={onPermissionResponse}
                          onAskUserResponse={onAskUserResponse}
                          onRetry={onRetry}
                          onFork={onFork}
                          isFirstUser={false}
                          isLoading={loading}
                          tts={tts}
                          ttsState={ttsState}
                          ttsIsActive={ttsIsActive}
                          voicePlayer={voicePlayer}
                          voicePlayState={voicePlayState}
                          debugMode={debugMode}
                        />
                      </ErrorBoundary>
                    );
                  })}
                </div>
              </div>
            );
          }

          // --- Standalone activity_group (shouldn't happen with bubble grouping, but fallback) ---
          if (item.type === 'activity_group') {
            return (
              <div key={item.id} ref={ri === lastRenderIdx && !showAgentLoading ? lastMessageRef : undefined}
                className="flex flex-col">
                {showHeader && (
                  <AiMessageHeader agentProfile={displayAgent} timestamp={undefined} />
                )}
                <div className="rounded-lg bg-card px-3 py-2 shadow-[0_2px_4px_rgba(15,23,42,0.06),0_8px_24px_-6px_rgba(15,23,42,0.10)]">
                  <ErrorBoundary inline>
                    <ActivityGroupBlock items={item.items} isActive={item.isActive} isLast={item.id === lastActivityGroupId} debugMode={debugMode} />
                  </ErrorBoundary>
                </div>
              </div>
            );
          }

          // --- compaction: 压缩状态条 / 分界线,无头像 header,横铺 ---
          const compactionItem = asCompactionItem(item);
          if (compactionItem) {
            return (
              <div
                key={item.id}
                ref={ri === lastRenderIdx && !showAgentLoading ? lastMessageRef : undefined}
                className="flex flex-col"
              >
                <ErrorBoundary inline>
                  <CompactionDivider item={compactionItem} debugMode={debugMode} />
                </ErrorBoundary>
              </div>
            );
          }

          // --- system-error: 会话级失败/取消 alert,无头像 header,横铺 ---
          if (item.type === 'system-error') {
            const origIndex = msgIndexMap.get(item.id) ?? 0;
            return (
              <div
                key={item.id}
                ref={ri === lastRenderIdx && !showAgentLoading ? lastMessageRef : undefined}
                className="flex flex-col"
              >
                <ErrorBoundary inline>
                  <MessageItem
                    message={item}
                    index={origIndex}
                    onPermissionResponse={onPermissionResponse}
                    onAskUserResponse={onAskUserResponse}
                    onRetry={onRetry}
                    onFork={onFork}
                    isFirstUser={false}
                    isLoading={loading}
                    tts={tts}
                    ttsState={'idle'}
                    ttsIsActive={false}
                    voicePlayer={voicePlayer}
                    voicePlayState={undefined}
                    debugMode={debugMode}
                  />
                </ErrorBoundary>
              </div>
            );
          }

          // --- file_download 顶层项: legacy artifact_created 卡片(带 artifactId),
          //     无关联 text 载体,独立渲染(不进气泡、无头像 header)。
          //     [FILE] 标记路径已在 groupIntoBubbles 阶段被跳过,不会走到这里。
          if (item.type === 'file_download') {
            const origIndex = msgIndexMap.get(item.id) ?? 0;
            return (
              <div
                key={item.id}
                ref={ri === lastRenderIdx && !showAgentLoading ? lastMessageRef : undefined}
                className="flex flex-col"
              >
                <ErrorBoundary inline>
                  <MessageItem
                    message={item}
                    index={origIndex}
                    onPermissionResponse={onPermissionResponse}
                    onAskUserResponse={onAskUserResponse}
                    onRetry={onRetry}
                    onFork={onFork}
                    isFirstUser={false}
                    isLoading={loading}
                    tts={tts}
                    ttsState={'idle'}
                    ttsIsActive={false}
                    voicePlayer={voicePlayer}
                    voicePlayState={undefined}
                    debugMode={debugMode}
                  />
                </ErrorBoundary>
              </div>
            );
          }

          // --- User messages (standalone, no bubble wrapper) ---
          const origIndex = msgIndexMap.get(item.id) ?? 0;
          const msgKey = `msg-${origIndex}`;
          const ttsState = ttsStateMap?.[msgKey] || 'idle';
          const ttsIsActive = tts?.activeKey === msgKey;
          const voicePlayState = item.type === 'user-voice'
            ? voicePlayer.getState(`voice-msg-${item.id}`)
            : undefined;
          const userTimestamp = 'timestamp' in item ? item.timestamp : undefined;

          return (
            <div key={item.id} ref={ri === lastRenderIdx && !showAgentLoading ? lastMessageRef : undefined} className="flex flex-col">
              {showHeader && (
                <UserMessageHeader
                  userId={displayUser?.id}
                  realName={displayUser?.realName}
                  username={displayUser?.username}
                  avatar={displayUser?.avatar}
                  avatarVersion={displayUser?.avatarVersion}
                  timestamp={userTimestamp}
                />
              )}
              <ErrorBoundary inline>
                <MessageItem
                  message={item}
                  index={origIndex}
                  onPermissionResponse={onPermissionResponse}
                  onAskUserResponse={onAskUserResponse}
                  onRetry={onRetry}
                  onFork={onFork}
                  isFirstUser={item.type === 'user' && item.id === firstUserMsgId}
                  isLoading={loading}
                  tts={tts}
                  ttsState={ttsState}
                  ttsIsActive={ttsIsActive}
                voicePlayer={voicePlayer}
                voicePlayState={voicePlayState}
                debugMode={debugMode}
              />
              </ErrorBoundary>
            </div>
          );
        })}

        {!showCenterLoading && showAgentLoading && (
          <div ref={lastMessageRef} className="flex flex-col">
            <AiMessageHeader agentProfile={displayAgent} timestamp={undefined} />
            <div className="rounded-lg bg-card px-3 py-2 shadow-[0_2px_4px_rgba(15,23,42,0.06),0_8px_24px_-6px_rgba(15,23,42,0.10)]">
              <div className="flex items-center gap-1.5 py-0.5 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/70" />
                <span>正在思考</span>
                <span className="animate-pulse">...</span>
              </div>
            </div>
          </div>
        )}

        {showSyncLoading && (
          <div ref={lastMessageRef} className="flex items-center gap-2 justify-start">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">正在加载最新消息...</span>
          </div>
        )}
      </div>
    </div>
    {showJumpToBottom && (
      // 滚动条距最新消息超过 NEAR_BOTTOM_THRESHOLD 时展示，位于 ChatInput 上方正中间。
      <button
        type="button"
        onClick={handleJumpToBottom}
        className="pointer-events-auto absolute bottom-3 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border/60 bg-background/95 text-muted-foreground shadow-md backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
        title="回到最新消息"
        aria-label="回到最新消息"
      >
        <ArrowDown className="size-4" />
      </button>
    )}
    </div>
  );
});
