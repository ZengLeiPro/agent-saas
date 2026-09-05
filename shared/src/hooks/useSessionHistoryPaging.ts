import { useCallback, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { ApiSessionDetail } from '../types/session';
import type { MessageItem } from '../types/message';
import { mergeSessionMessagePage } from '../lib/sessionMerge';

/**
 * 会话历史分页（Web / mobile `useSession.loadEarlierMessages` 的共同内核）。
 *
 * 内核只管平台无关的部分：
 * - 每个会话的历史游标（最旧游标 / 尾游标 / 是否到头 / `historyRevision`）；
 * - 按会话隔离的加载锁：A 会话的慢请求不能卡住随后打开的 B 会话；
 * - `historyRevision` 与在飞旧页不一致（compaction / 替换）时放弃该页、交回平台重载最新一代；
 * - 服务端返回 `mode: 'before'` 才向前合并并去重边界，否则整窗替换；
 * - `hasMoreHistory` / `isLoadingEarlier` 两个状态。
 *
 * 平台侧只剩：怎么发请求（注入 `authFetch`）、blocks 怎么映射成消息（Web 懒加载 mapper，
 * mobile 注回 compaction 分界线）、合并结果怎么写回（Web 还要落 IndexedDB 缓存）。
 */

export interface SessionHistoryCursor {
  historyComplete: boolean;
  tailCursor?: string;
  oldestCursor?: string;
  historyRevision?: string;
}

export interface SessionHistoryPagingOptions {
  authFetch: (url: string) => Promise<Response>;
  pageSize: number;
  /** 当前展示的会话 id；与请求开始时的 id 不一致即视为已切走。 */
  sessionIdRef: RefObject<string | null>;
  /** 当前本地消息列表；向前合并时作为基底。 */
  getMessages: () => MessageItem[];
  /** 服务端页 → 消息列表；可异步（Web 懒加载 mapper）。 */
  mapPage: (data: ApiSessionDetail) => MessageItem[] | Promise<MessageItem[]>;
  /** 合并结果写回（setMessages、平台缓存）。 */
  applyPage: (sessionId: string, messages: MessageItem[], cursor: SessionHistoryCursor) => void;
  /** 在飞旧页因 `historyRevision` 变化作废时，由平台重载最新一代；返回 Promise 则等待其完成。 */
  onHistoryRevisionMismatch: (sessionId: string) => void | Promise<void>;
  /**
   * 请求开始时创建的存活判定（mobile 用 identity generation 作内存边界）；
   * 缺省视为始终存活。
   */
  createGuard?: () => () => boolean;
}

export interface SessionHistoryPaging {
  cursorsRef: MutableRefObject<Map<string, SessionHistoryCursor>>;
  hasMoreHistory: boolean;
  setHasMoreHistory: Dispatch<SetStateAction<boolean>>;
  isLoadingEarlier: boolean;
  setIsLoadingEarlier: Dispatch<SetStateAction<boolean>>;
  loadEarlierMessages: () => Promise<void>;
  /** 清空全部游标与加载锁（身份切换等内存边界）。状态由调用方自行重置。 */
  resetHistoryPaging: () => void;
}

const alwaysAlive = () => true;

/** 服务端页面 → 下一份游标状态。 */
export function deriveSessionHistoryCursor(
  data: ApiSessionDetail,
  previous: SessionHistoryCursor | undefined,
  incoming: readonly MessageItem[],
): SessionHistoryCursor {
  const historyComplete =
    data.hasMore !== undefined ? !data.hasMore : data.historyComplete !== false;
  const oldestCursor = data.nextCursor ?? data.oldestCursor ?? incoming[0]?.id;
  const tailCursor = data.cursor ?? previous?.tailCursor;
  return {
    historyComplete,
    ...(tailCursor ? { tailCursor } : {}),
    ...(oldestCursor ? { oldestCursor } : {}),
    ...(data.historyRevision ? { historyRevision: data.historyRevision } : {}),
  };
}

export function useSessionHistoryPaging(
  options: SessionHistoryPagingOptions,
): SessionHistoryPaging {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const cursorsRef = useRef<Map<string, SessionHistoryCursor>>(new Map());
  // 历史分页锁按会话隔离：A 会话的慢请求不能卡住随后打开的 B 会话。
  const loadingSessionIdsRef = useRef<Set<string>>(new Set());
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);

  const loadEarlierMessages = useCallback(async () => {
    const opts = optionsRef.current;
    const id = opts.sessionIdRef.current;
    const cursorState = id ? cursorsRef.current.get(id) : undefined;
    if (
      !id ||
      !cursorState?.oldestCursor ||
      cursorState.historyComplete ||
      loadingSessionIdsRef.current.has(id)
    )
      return;

    const isAlive = opts.createGuard?.() ?? alwaysAlive;
    loadingSessionIdsRef.current.add(id);
    setIsLoadingEarlier(true);
    try {
      const params = new URLSearchParams({
        before: cursorState.oldestCursor,
        limit: String(opts.pageSize),
        silent: '1',
      });
      const response = await opts.authFetch(
        `/api/sessions/${encodeURIComponent(id)}?${params.toString()}`,
      );
      if (!response.ok) {
        console.error('加载更早消息失败:', response.status, response.statusText);
        return;
      }
      if (opts.sessionIdRef.current !== id || !isAlive()) return;
      const data = (await response.json()) as ApiSessionDetail;
      if (opts.sessionIdRef.current !== id || !isAlive()) return;
      if (
        cursorState.historyRevision &&
        data.historyRevision &&
        cursorState.historyRevision !== data.historyRevision
      ) {
        // Compaction/replacement invalidated this in-flight old page; refresh a new latest generation.
        const pending = opts.onHistoryRevisionMismatch(id);
        if (pending) await pending;
        return;
      }

      const incoming = await opts.mapPage(data);
      const merged =
        data.mode === 'before' ? mergeSessionMessagePage(opts.getMessages(), incoming) : incoming;
      const nextCursor = deriveSessionHistoryCursor(data, cursorState, incoming);

      opts.applyPage(id, merged, nextCursor);
      setHasMoreHistory(!nextCursor.historyComplete);
      cursorsRef.current.set(id, nextCursor);
    } catch (err) {
      console.error('加载更早消息失败:', err);
    } finally {
      loadingSessionIdsRef.current.delete(id);
      if (opts.sessionIdRef.current === id && isAlive()) setIsLoadingEarlier(false);
    }
  }, []);

  const resetHistoryPaging = useCallback(() => {
    cursorsRef.current.clear();
    loadingSessionIdsRef.current.clear();
  }, []);

  return {
    cursorsRef,
    hasMoreHistory,
    setHasMoreHistory,
    isLoadingEarlier,
    setIsLoadingEarlier,
    loadEarlierMessages,
    resetHistoryPaging,
  };
}
