/**
 * 会话列表行内元信息的纯逻辑 —— Web `MobileSessionList` 与移动端原生列表共用。
 *
 * 这里只放「从服务端数据推导展示语义」的函数，不含任何渲染或平台 API：
 * 1. 运行中 / 等待人工 的运行态推导（服务端 O(1) 的 activeInteraction 摘要）；
 * 2. 分组折叠行的未读聚合；
 * 3. 无限滚动触发判定（距底 < 200px）；
 * 4. 行滑动打开态对点击选择的抑制（滑开态点击只收起，收回后 300ms 内不选择）。
 */
import type { SessionRuntimeStatus } from '../types/sidebar';

/** 服务端下发的待处理交互摘要（`ApiSessionListItem.activeInteraction` 的最小形状） */
export interface SessionListInteractionSummary {
  type: 'ask_user' | 'permission_request' | 'approval';
}

export interface SessionListRuntimeInput {
  activeInteraction?: SessionListInteractionSummary;
  /** 该会话当前是否处于活跃 run（由调用方的运行时投影给出） */
  running?: boolean;
}

/**
 * 会话列表行的运行态：待人工的交互优先于「运行中」，与 Web
 * `getSessionWaitingLabel` 的展示优先级一致（有等待文案时不转圈）。
 */
export function resolveSessionListRuntimeStatus(
  input: SessionListRuntimeInput,
): SessionRuntimeStatus | undefined {
  const type = input.activeInteraction?.type;
  if (type === 'ask_user') return 'waiting_user';
  if (type === 'permission_request' || type === 'approval') return 'waiting_approval';
  return input.running ? 'running' : undefined;
}

export interface UnreadSessionRef {
  id: string;
  hasUnreadAiReply?: boolean;
}

export interface UnreadGroupRef {
  id: string;
  sessionIds: readonly string[];
}

/**
 * 分组折叠行的聚合未读：分组内任一会话有未读 AI 回复即整行标红点。
 * 语义与 Web `MobileSessionList` 的 `unreadByGroupId` 一致。
 */
export function selectGroupUnreadMap(
  groups: readonly UnreadGroupRef[],
  sessions: readonly UnreadSessionRef[],
): Map<string, boolean> {
  const unreadIds = new Set(
    sessions.filter((session) => session.hasUnreadAiReply === true).map((session) => session.id),
  );
  const map = new Map<string, boolean>();
  for (const group of groups) {
    map.set(
      group.id,
      group.sessionIds.some((id) => unreadIds.has(id)),
    );
  }
  return map;
}

/** 距底触发下一页的默认阈值（px），对齐 Web `MobileSessionList`。 */
export const LOAD_MORE_DISTANCE_PX = 200;

export interface ScrollLoadMoreInput {
  /** 内容总高度 */
  contentHeight: number;
  /** 当前滚动偏移 */
  offsetY: number;
  /** 可视区高度 */
  viewportHeight: number;
  distance?: number;
}

/** 距底小于 `distance` 时应触发 `onLoadMore`。 */
export function shouldLoadMoreOnScroll(input: ScrollLoadMoreInput): boolean {
  const distance = input.distance ?? LOAD_MORE_DISTANCE_PX;
  return input.contentHeight - input.offsetY - input.viewportHeight < distance;
}

/** 行收回后抑制点击选择的时长（ms），对齐 Web `MobileSessionList`。 */
export const SWIPE_DISMISS_GUARD_MS = 300;

export interface SwipeSelectGuardInput {
  /** 当前是否有行处于滑开态 */
  hasOpenRow: boolean;
  /** 最近一次从滑开变为收回的时间戳；从未发生传 0 */
  dismissedAt: number;
  now: number;
  guardMs?: number;
}

export type SwipeSelectGuard = 'close-open-row' | 'suppress' | 'select';

/**
 * 滑开态点击只收起；收回后 `guardMs` 内的点击一律丢弃，避免误触进入会话。
 */
export function resolveSwipeSelectGuard(input: SwipeSelectGuardInput): SwipeSelectGuard {
  if (input.hasOpenRow) return 'close-open-row';
  const guardMs = input.guardMs ?? SWIPE_DISMISS_GUARD_MS;
  if (input.dismissedAt > 0 && input.now - input.dismissedAt < guardMs) return 'suppress';
  return 'select';
}
