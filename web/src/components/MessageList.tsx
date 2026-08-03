import { memo, useMemo, useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref, type MutableRefObject } from 'react';
import { ArrowDown, Loader2 } from 'lucide-react';
import { MessageItem as MessageItemType, type RenderItem } from './types';
// 呈现块外挂层：display 缺省时直通 MessageItem，MessageItem.tsx 本身零改动
import { MessageItemWithDisplay as MessageItem } from './MessageItemWithDisplay';
import type { TtsProps } from './MessageItem';
import { ActivityGroupBlock } from './ActivityGroupBlock';
import { BusinessStepFlow, BusinessStepSectionView } from './BusinessStepFlow';
import { CompactionDivider } from './CompactionDivider';
import { asCompactionItem } from '@/lib/compaction';
import {
  buildMessageVirtualLayout,
  findMessageRowAtOffset,
  getMessageVirtualRange,
  MAX_RENDERED_MESSAGE_ROWS,
} from '@/lib/messageVirtualizer';
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
    } else if (item.type === 'system-error' || item.type === 'system_event') {
      // 系统事件与会话级错误都是独立中性信息，不归属用户或 AI 气泡。
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
    if (item.type === 'business_step_section') {
      const nested = getFirstTimestamp(item.items);
      if (nested) return nested;
    }
  }
  return undefined;
}

function getBubbleVirtualKey(item: BubbleRenderItem): string {
  const timestamp = item.type === 'ai_bubble'
    ? getFirstTimestamp(item.items)
    : 'timestamp' in item
      ? item.timestamp
      : item.type === 'activity_group'
        ? getFirstTimestamp(item.items)
        : undefined;
  // Transcript block ids restart at line-1 in every session. Including the stable timestamp
  // prevents height measurements from one cached session leaking into another with equal ids.
  return `${item.id}:${timestamp ?? ''}`;
}

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
  hasMoreHistory?: boolean;
  isLoadingEarlier?: boolean;
  onLoadEarlier?: () => Promise<void>;
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
  hasMoreHistory,
  isLoadingEarlier,
  onLoadEarlier,
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

  const voicePlayer = useVoicePlayer();
  const { user } = useAuth();
  const debugMode = debugModeOverride ?? user?.debugMode === true;
  const groupedMessages = useGroupedMessages(messages, loading, { debugMode, sectioning: true });
  const bubbleItems = useMemo(() => groupIntoBubbles(groupedMessages), [groupedMessages]);
  const lastRenderIdx = bubbleItems.length - 1;
  const bubbleKeys = useMemo(() => bubbleItems.map(getBubbleVirtualKey), [bubbleItems]);
  const [measuredRowHeights, setMeasuredRowHeights] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const layoutTiming = useMemo(() => {
    const start = performance.now();
    const layout = buildMessageVirtualLayout(bubbleKeys, measuredRowHeights);
    return { layout, start, end: performance.now() };
  }, [bubbleKeys, measuredRowHeights]);
  const virtualLayout = layoutTiming.layout;

  // Loading rows remain outside the virtualized bubble region, as before.
  const lastItem = bubbleItems[lastRenderIdx];
  const showAgentLoading = loading && (!lastItem || (lastItem.type !== 'ai_bubble' && lastItem.type !== 'activity_group' && lastItem.type === 'user'));
  const showCenterLoading = isLoadingMessages && messages.length === 0 && !loading;
  const showSyncLoading = isLoadingMessages && messages.length > 0 && !loading;

  // ResizeObserver 在 streaming / 图片加载时可能逐帧触发；只在消息行数变化时
  // 留一条最新 measure，避免 PerformanceEntry 自身成为长会话内存增长源。
  const lastMeasuredLayoutRowCountRef = useRef(-1);
  useEffect(() => {
    const rowCount = virtualLayout.keys.length;
    if (lastMeasuredLayoutRowCountRef.current === rowCount) return;
    lastMeasuredLayoutRowCountRef.current = rowCount;
    try {
      performance.clearMeasures('message-list:virtual-layout');
      performance.measure('message-list:virtual-layout', {
        start: layoutTiming.start,
        end: layoutTiming.end,
        detail: { totalRowCount: rowCount },
      });
    } catch {
      // Older browsers and test shims may not support numeric marks or measure detail.
    }
  }, [layoutTiming, virtualLayout.keys.length]);

  const virtualBodyRef = useRef<HTMLDivElement | null>(null);
  const rowNodesRef = useRef(new Map<string, HTMLDivElement>());
  const rowObserverRef = useRef<ResizeObserver | null>(null);
  const rowRefCallbacksRef = useRef(
    new Map<string, (node: HTMLDivElement | null) => void>(),
  );
  const setMeasuredRow = useCallback((key: string, node: HTMLDivElement | null) => {
    const previous = rowNodesRef.current.get(key);
    if (previous === node) return;
    if (previous) rowObserverRef.current?.unobserve(previous);
    if (node) {
      rowNodesRef.current.set(key, node);
      rowObserverRef.current?.observe(node);
    } else {
      rowNodesRef.current.delete(key);
    }
  }, []);
  const getMeasuredRowRef = useCallback((key: string) => {
    let callback = rowRefCallbacksRef.current.get(key);
    if (!callback) {
      callback = (node) => setMeasuredRow(key, node);
      rowRefCallbacksRef.current.set(key, callback);
    }
    return callback;
  }, [setMeasuredRow]);

  useEffect(() => {
    const activeKeys = new Set(bubbleKeys);
    setMeasuredRowHeights((current) => {
      if ([...current.keys()].every((key) => activeKeys.has(key))) return current;
      return new Map([...current].filter(([key]) => activeKeys.has(key)));
    });
    for (const key of rowRefCallbacksRef.current.keys()) {
      if (!activeKeys.has(key)) rowRefCallbacksRef.current.delete(key);
    }
  }, [bubbleKeys]);

  const [viewport, setViewport] = useState({ start: 0, size: 0 });
  const viewportRafRef = useRef(0);
  const viewportSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateViewportNow = useCallback(() => {
    viewportRafRef.current = 0;
    const container = internalContainerRef.current;
    const body = virtualBodyRef.current;
    if (!container || !body) return;
    const start = Math.max(0, container.scrollTop - body.offsetTop);
    const size = container.clientHeight;
    setViewport((previous) => previous.start === start && previous.size === size
      ? previous
      : { start, size });
  }, []);
  const scheduleViewportUpdate = useCallback(() => {
    if (viewportRafRef.current) return;
    viewportRafRef.current = requestAnimationFrame(updateViewportNow);
  }, [updateViewportNow]);

  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const wasNearBottomRef = useRef(isNearBottomRef?.current ?? true);
  const syncNearBottomState = useCallback(() => {
    const el = internalContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNear = distance < NEAR_BOTTOM_THRESHOLD;
    wasNearBottomRef.current = isNear;
    if (isNearBottomRef) isNearBottomRef.current = isNear;
    setShowJumpToBottom((previous) => previous === !isNear ? previous : !isNear);
  }, [isNearBottomRef]);

  const handleScroll = useCallback(() => {
    syncNearBottomState();
    scheduleViewportUpdate();
  }, [scheduleViewportUpdate, syncNearBottomState]);

  const handleJumpToBottom = useCallback(() => {
    const el = internalContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  const prependScrollRef = useRef<{
    anchorKey: string;
    screenOffset: number;
    firstKey?: string;
  } | null>(null);
  const handleLoadEarlier = useCallback(() => {
    const el = internalContainerRef.current;
    const body = virtualBodyRef.current;
    if (!el || !body || !onLoadEarlier || isLoadingEarlier) return;
    const localStart = Math.max(0, el.scrollTop - body.offsetTop);
    const anchorIndex = findMessageRowAtOffset(virtualLayout, localStart);
    const anchorKey = virtualLayout.keys[anchorIndex];
    if (anchorKey) {
      prependScrollRef.current = {
        anchorKey,
        screenOffset: virtualLayout.offsets[anchorIndex] - localStart,
        firstKey: virtualLayout.keys[0],
      };
    }
    void onLoadEarlier();
  }, [isLoadingEarlier, onLoadEarlier, virtualLayout]);

  // Preserve a key-based visual anchor across prepend and asynchronous row remeasurement.
  const previousLayoutRef = useRef(virtualLayout);
  useLayoutEffect(() => {
    const el = internalContainerRef.current;
    const body = virtualBodyRef.current;
    const previous = previousLayoutRef.current;
    if (!el || !body) {
      previousLayoutRef.current = virtualLayout;
      return;
    }

    if (wasNearBottomRef.current) {
      // Streaming, appended rows, and image/expander growth follow only while near the bottom.
      el.scrollTop = el.scrollHeight;
    } else if (previous !== virtualLayout && previous.keys.length > 0) {
      const pendingPrepend = prependScrollRef.current;
      const didPrepend = pendingPrepend
        && pendingPrepend.firstKey !== virtualLayout.keys[0]
        && virtualLayout.indexByKey.has(pendingPrepend.anchorKey);
      if (didPrepend) {
        const nextIndex = virtualLayout.indexByKey.get(pendingPrepend.anchorKey)!;
        const nextLocalStart = virtualLayout.offsets[nextIndex] - pendingPrepend.screenOffset;
        el.scrollTop = body.offsetTop + nextLocalStart;
        prependScrollRef.current = null;
      } else {
        const previousLocalStart = Math.max(0, el.scrollTop - body.offsetTop);
        const anchorIndex = findMessageRowAtOffset(previous, previousLocalStart);
        const anchorKey = previous.keys[anchorIndex];
        const nextIndex = virtualLayout.indexByKey.get(anchorKey);
        if (nextIndex !== undefined) {
          el.scrollTop += virtualLayout.offsets[nextIndex] - previous.offsets[anchorIndex];
        }
      }
    }

    previousLayoutRef.current = virtualLayout;
    syncNearBottomState();
    updateViewportNow();
    // useMessages may force scrollTop in a parent effect without dispatching a scroll event.
    // Re-sample once after that rAF rather than polling continuously.
    if (viewportSettleTimerRef.current) clearTimeout(viewportSettleTimerRef.current);
    viewportSettleTimerRef.current = setTimeout(() => {
      viewportSettleTimerRef.current = null;
      syncNearBottomState();
      updateViewportNow();
    }, 50);
  }, [hasMoreHistory, showAgentLoading, showSyncLoading, syncNearBottomState, updateViewportNow, virtualLayout]);

  useEffect(() => {
    const container = internalContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const measurements: Array<[string, number]> = [];
      for (const entry of entries) {
        if (entry.target === container) {
          scheduleViewportUpdate();
          continue;
        }
        const node = entry.target as HTMLDivElement;
        const key = node.dataset.messageVirtualKey;
        if (!key) continue;
        measurements.push([
          key,
          Math.max(1, Math.ceil(node.getBoundingClientRect().height)),
        ]);
      }
      if (measurements.length === 0) return;
      setMeasuredRowHeights((current) => {
        let next: Map<string, number> | null = null;
        for (const [key, height] of measurements) {
          if ((next ?? current).get(key) === height) continue;
          if (!next) next = new Map(current);
          next.set(key, height);
        }
        return next ?? current;
      });
    });
    rowObserverRef.current = observer;
    observer.observe(container);
    for (const node of rowNodesRef.current.values()) observer.observe(node);
    scheduleViewportUpdate();
    return () => {
      rowObserverRef.current = null;
      observer.disconnect();
    };
  }, [scheduleViewportUpdate]);

  useEffect(() => () => {
    if (viewportRafRef.current) cancelAnimationFrame(viewportRafRef.current);
    if (viewportSettleTimerRef.current) clearTimeout(viewportSettleTimerRef.current);
  }, []);

  const virtualRange = useMemo(
    () => getMessageVirtualRange(virtualLayout, viewport.start, viewport.size),
    [viewport, virtualLayout],
  );
  const visibleRows = useMemo(() => {
    const rows: Array<{ item: BubbleRenderItem; key: string; index: number; top: number }> = [];
    for (let index = virtualRange.start; index < virtualRange.end; index += 1) {
      rows.push({
        item: bubbleItems[index],
        key: virtualLayout.keys[index],
        index,
        top: virtualLayout.offsets[index],
      });
    }
    return rows;
  }, [bubbleItems, virtualLayout.keys, virtualLayout.offsets, virtualRange]);

  // 构建 MessageItem id → 原始 messages 索引的映射（用于 TTS key 稳定性）
  const msgIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      map.set(messages[i].id, i);
    }
    return map;
  }, [messages]);

  // 最后一个 activity_group 的 id（用于默认展开）
  const lastActivityGroupId = useMemo(() => {
    // Search through bubble items; activity_groups can be inside ai_bubble groups
    // and business step sections (章节化后活动组可能嵌在步骤节内).
    const findInList = (items: RenderItem[]): string | null => {
      for (let j = items.length - 1; j >= 0; j--) {
        const sub = items[j];
        if (sub.type === 'activity_group') return sub.id;
        if (sub.type === 'business_step_section') {
          const nested = findInList(sub.items);
          if (nested) return nested;
        }
      }
      return null;
    };
    for (let i = bubbleItems.length - 1; i >= 0; i--) {
      const item = bubbleItems[i];
      if (item.type === 'ai_bubble') {
        const found = findInList(item.items);
        if (found) return found;
      }
      if (item.type === 'activity_group') return item.id;
      if (item.type === 'business_step_section') {
        const found = findInList(item.items);
        if (found) return found;
      }
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
      // 系统事件、system-error 与 compaction 是中性渲染单元，不参与头像切换计算。
      if (item.type === 'system_event' || item.type === 'system-error' || asCompactionItem(item)) continue;
      const side = (item.type === 'user' || item.type === 'user-voice') ? 'user' : 'ai';
      if (side !== prevSide) ids.add(item.id);
      prevSide = side;
    }
    return ids;
  }, [bubbleItems]);

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
    <div
      ref={setContainerRef}
      onScroll={showCenterLoading ? undefined : handleScroll}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain"
      style={{ overflowAnchor: 'none' }}
    >
      <div className="content-container flex flex-col gap-3 py-4">
        {!showCenterLoading && hasMoreHistory && (
          <div className="flex justify-center pb-1">
            <button
              type="button"
              onClick={handleLoadEarlier}
              disabled={isLoadingEarlier}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoadingEarlier && <Loader2 className="size-3.5 animate-spin" />}
              {isLoadingEarlier ? "正在加载" : "加载更早消息"}
            </button>
          </div>
        )}
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
        ) : bubbleItems.length === 0 ? null : (
          <div
            ref={virtualBodyRef}
            className="relative w-full shrink-0"
            style={{ height: virtualLayout.totalSize }}
            data-rendered-row-count={visibleRows.length}
            data-max-rendered-rows={MAX_RENDERED_MESSAGE_ROWS}
          >
          {visibleRows.map(({ item, key: virtualKey, index: ri, top }) => {
          const showHeader = headerItemIds.has(item.id);

          // AI 流内子项渲染：ai_bubble 内与业务步骤节内共用（节内过程 = 完整消息渲染，非降级视图）。
          const renderFlowItem = (sub: RenderItem, inSection = false): React.ReactNode => {
            if (sub.type === 'business_step_section') {
              return (
                <ErrorBoundary key={sub.id} inline>
                  <BusinessStepSectionView section={sub} debugMode={debugMode}>
                    {sub.items.map((child) => renderFlowItem(child, true))}
                  </BusinessStepSectionView>
                </ErrorBoundary>
              );
            }
            if (sub.type === 'business_step') {
              return (
                <ErrorBoundary key={sub.id} inline>
                  <BusinessStepFlow event={sub} />
                </ErrorBoundary>
              );
            }
            // 双重保险:此层理论上不该出现 file_download。
            // - [FILE] 内联(无 artifactId): MessageItem 在 text 内联展开,顶层跳过。
            // - legacy artifact_created 卡片(有 artifactId): groupIntoBubbles 已独立提到顶层。
            if (sub.type === 'file_download' && sub.artifactId) return null;
            if (sub.type === 'activity_group') {
              return (
                <ErrorBoundary key={sub.id} inline>
                  <ActivityGroupBlock
                    items={sub.items}
                    isActive={sub.isActive}
                    isLast={sub.id === lastActivityGroupId}
                    debugMode={debugMode}
                    // 调试模式沿用节内平铺；普通用户保留活动组折叠摘要，但锁定为不可展开。
                    flat={inSection && debugMode}
                  />
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
          };

          const rowContent = (() => {

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
                <div className="py-2">
                  {item.items.map((sub) => {
                    // ai_bubble 顶层的 file_download 双重保险维持原语义：一律跳过。
                    if (sub.type === 'file_download') return null;
                    return renderFlowItem(sub);
                  })}
                </div>
              </div>
            );
          }

          // --- Standalone business_step / section (normally grouped into an AI bubble) ---
          if (item.type === 'business_step' || item.type === 'business_step_section') {
            return (
              <div
                key={item.id}
                ref={ri === lastRenderIdx && !showAgentLoading ? lastMessageRef : undefined}
                className="flex flex-col"
              >
                {showHeader && (
                  <AiMessageHeader agentProfile={displayAgent} timestamp={undefined} />
                )}
                <div className="py-2">
                  {renderFlowItem(item)}
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
                <div className="py-2">
                  <ErrorBoundary inline>
                    <ActivityGroupBlock items={item.items} isActive={item.isActive} isLast={item.id === lastActivityGroupId} debugMode={debugMode} />
                  </ErrorBoundary>
                </div>
              </div>
            );
          }

          // --- system_event: 业务事件 / 定时触发，无用户或 AI 头像 ---
          if (item.type === 'system_event') {
            return (
              <div
                key={item.id}
                ref={ri === lastRenderIdx && !showAgentLoading ? lastMessageRef : undefined}
                className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3"
              >
                <div className="text-xs font-semibold text-muted-foreground">{item.title}</div>
                <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-foreground">{item.content}</div>
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
          })();
          return (
            <div
              key={virtualKey}
              ref={getMeasuredRowRef(virtualKey)}
              data-message-virtual-key={virtualKey}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translate3d(0, ${top}px, 0)` }}
            >
              {rowContent}
            </div>
          );
        })}
          </div>
        )}

        {!showCenterLoading && showAgentLoading && (
          <div ref={lastMessageRef} className="flex flex-col">
            <AiMessageHeader agentProfile={displayAgent} timestamp={undefined} />
            <div className="py-2">
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
