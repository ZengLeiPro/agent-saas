/**
 * 质检台数据 hooks
 *
 * - useQaSessions：cursor 分页（加载更多）；过滤条件变化时**先清空旧数据**再拉取，
 *   避免请求期间短暂展示旧过滤器的数据（仿 TenantAnalytics requestId 守卫）
 * - useQaGuardrailEvents / useQaFeedback：offset 分页（上一页/下一页，仿 AuditEventsPanel）
 * - 503 → availability='unavailable'（file backend 未装配 PG，前端隐藏换提示）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import type {
  QaAppealItem,
  QaAppealsFilter,
  QaAvailability,
  QaEventsFilter,
  QaFeedbackFilter,
  QaFeedbackItem,
  QaGuardrailAggregateItem,
  QaGuardrailBoard,
  QaGuardrailEvent,
  QaGuardrailLatencyStats,
  QaGuardrailMode,
  QaGuardrailModelBreakdown,
  QaSessionItem,
  QaSessionsFilter,
} from './types';

function buildParams(entries: Record<string, string | number | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  return params;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data as { error?: string }).error || fallback;
}

export function useQaSessions(filter: QaSessionsFilter) {
  const [items, setItems] = useState<QaSessionItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<QaAvailability>('unknown');
  const requestIdRef = useRef(0);

  const load = useCallback(async (cursor?: string) => {
    const requestId = ++requestIdRef.current;
    if (!cursor) {
      // 过滤条件变化 / 刷新：先清空，避免展示旧过滤器数据
      setItems([]);
      setNextCursor(null);
    }
    setLoading(true);
    try {
      const params = buildParams({
        tenantId: filter.tenantId,
        orgAgentId: filter.orgAgentId,
        userId: filter.userId,
        from: filter.from,
        to: filter.to,
        cursor,
      });
      const res = await authFetch(`/api/admin/qa/sessions?${params.toString()}`);
      if (requestId !== requestIdRef.current) return;
      if (res.status === 503) {
        setAvailability('unavailable');
        return;
      }
      if (!res.ok) throw new Error(await readError(res, `HTTP ${res.status}`));
      const data = await res.json() as { items: QaSessionItem[]; nextCursor?: string };
      if (requestId !== requestIdRef.current) return;
      setAvailability('available');
      setItems((prev) => (cursor ? [...prev, ...data.items] : data.items));
      setNextCursor(data.nextCursor ?? null);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [filter.tenantId, filter.orgAgentId, filter.userId, filter.from, filter.to]);

  useEffect(() => {
    void load();
    return () => { requestIdRef.current += 1; };
  }, [load]);

  const loadMore = useCallback(() => {
    if (nextCursor) void load(nextCursor);
  }, [nextCursor, load]);

  const refresh = useCallback(() => { void load(); }, [load]);

  return { items, loading, error, availability, hasMore: !!nextCursor, loadMore, refresh };
}

const EVENTS_PAGE_SIZE = 50;

export function useQaGuardrailEvents(filter: QaEventsFilter) {
  const [events, setEvents] = useState<QaGuardrailEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<QaAvailability>('unknown');
  const requestIdRef = useRef(0);

  const fetchPage = useCallback(async (pageOffset: number) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const params = buildParams({
        tenantId: filter.tenantId,
        orgAgentId: filter.orgAgentId,
        userId: filter.userId,
        verdict: filter.verdict,
        from: filter.from,
        to: filter.to,
        offset: pageOffset,
        limit: EVENTS_PAGE_SIZE,
      });
      const res = await authFetch(`/api/admin/qa/guardrail-events?${params.toString()}`);
      if (requestId !== requestIdRef.current) return;
      if (res.status === 503) {
        setAvailability('unavailable');
        return;
      }
      if (!res.ok) throw new Error(await readError(res, `HTTP ${res.status}`));
      const data = await res.json() as { events: QaGuardrailEvent[]; total: number };
      if (requestId !== requestIdRef.current) return;
      setAvailability('available');
      setEvents(data.events);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [filter.tenantId, filter.orgAgentId, filter.userId, filter.verdict, filter.from, filter.to]);

  useEffect(() => {
    setOffset(0);
    void fetchPage(0);
    return () => { requestIdRef.current += 1; };
  }, [fetchPage]);

  const refresh = useCallback(() => {
    setOffset(0);
    void fetchPage(0);
  }, [fetchPage]);

  const nextPage = useCallback(() => {
    const next = offset + EVENTS_PAGE_SIZE;
    if (next < total) {
      setOffset(next);
      void fetchPage(next);
    }
  }, [offset, total, fetchPage]);

  const prevPage = useCallback(() => {
    const prev = Math.max(0, offset - EVENTS_PAGE_SIZE);
    if (prev !== offset) {
      setOffset(prev);
      void fetchPage(prev);
    }
  }, [offset, fetchPage]);

  return { events, total, offset, limit: EVENTS_PAGE_SIZE, loading, error, availability, refresh, nextPage, prevPage };
}

export function useQaFeedback(filter: QaFeedbackFilter) {
  const [items, setItems] = useState<QaFeedbackItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<QaAvailability>('unknown');
  const requestIdRef = useRef(0);

  const fetchPage = useCallback(async (pageOffset: number) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const params = buildParams({
        tenantId: filter.tenantId,
        orgAgentId: filter.orgAgentId,
        userId: filter.userId,
        from: filter.from,
        to: filter.to,
        offset: pageOffset,
        limit: EVENTS_PAGE_SIZE,
      });
      const res = await authFetch(`/api/admin/qa/feedback?${params.toString()}`);
      if (requestId !== requestIdRef.current) return;
      if (res.status === 503) {
        setAvailability('unavailable');
        return;
      }
      if (!res.ok) throw new Error(await readError(res, `HTTP ${res.status}`));
      const data = await res.json() as { items: QaFeedbackItem[]; total: number };
      if (requestId !== requestIdRef.current) return;
      setAvailability('available');
      setItems(data.items);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [filter.tenantId, filter.orgAgentId, filter.userId, filter.from, filter.to]);

  useEffect(() => {
    setOffset(0);
    void fetchPage(0);
    return () => { requestIdRef.current += 1; };
  }, [fetchPage]);

  const refresh = useCallback(() => {
    setOffset(0);
    void fetchPage(0);
  }, [fetchPage]);

  const nextPage = useCallback(() => {
    const next = offset + EVENTS_PAGE_SIZE;
    if (next < total) {
      setOffset(next);
      void fetchPage(next);
    }
  }, [offset, total, fetchPage]);

  const prevPage = useCallback(() => {
    const prev = Math.max(0, offset - EVENTS_PAGE_SIZE);
    if (prev !== offset) {
      setOffset(prev);
      void fetchPage(prev);
    }
  }, [offset, fetchPage]);

  return { items, total, offset, limit: EVENTS_PAGE_SIZE, loading, error, availability, refresh, nextPage, prevPage };
}

// ============================================================================
// 门禁看板（shadow 数据看板 · B4 § 4.4.4）
//
// **派生 vs 端点**：4 视图的前 3 个（拒答 top / model 分布 / latency）都可以从
// 已有的 `/api/admin/qa/guardrail-events` 明细列表**在前端派生**——避免依赖尚未
// 装配的聚合端点（`GET /tenant/guardrail-events/aggregate` 属于 MVP 后续增强）。
// 视图 4「申诉队列」走独立端点 `/api/tenant/appeals`，未装配时 404/503 降级为提示。
//
// **拉多少条派生**：为覆盖 30 天，我们把 board hook 拉到 limit=200（后端上限），
// events 若 total > 200 则给 UI 一个"结果为近 200 条估算"标签——真正需要精确
// 聚合的时候再迁移到后端 `/aggregate` 端点（本 hook 内的派生逻辑与后端 SQL 逻辑
// 等价）。
// ============================================================================

const BOARD_SAMPLE_LIMIT = 200;

function bucketMessageText(text: string): string {
  // 简单聚类：取前 24 字（NFKC + 去空白），作为 message_text 的桶键。
  // 后期可迁移到向量聚类，MVP 先人肉分类可读即可（拒答 top 类型直接看 sample）
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= 24) return normalized || '（空消息）';
  return `${normalized.slice(0, 24)}…`;
}

function isShadowVerdict(verdict: string): boolean {
  return verdict.endsWith('_shadow');
}

function filterEventsByMode(events: QaGuardrailEvent[], mode: QaGuardrailMode): QaGuardrailEvent[] {
  if (mode === 'all') return events;
  if (mode === 'shadow') return events.filter((e) => isShadowVerdict(e.verdict));
  return events.filter((e) => !isShadowVerdict(e.verdict));
}

function computeQuantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

function computeLatency(events: QaGuardrailEvent[]): QaGuardrailLatencyStats {
  const latencies = events
    .map((e) => e.latencyMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  return {
    p50: computeQuantile(latencies, 0.5),
    p90: computeQuantile(latencies, 0.9),
    p99: computeQuantile(latencies, 0.99),
    samples: latencies.length,
  };
}

function computeTopRejections(events: QaGuardrailEvent[]): QaGuardrailAggregateItem[] {
  const buckets = new Map<string, { count: number; samples: string[]; off: number; flagged: number }>();
  for (const event of events) {
    const key = bucketMessageText(event.messageText);
    const bucket = buckets.get(key) ?? { count: 0, samples: [], off: 0, flagged: 0 };
    bucket.count += 1;
    if (bucket.samples.length < 3 && !bucket.samples.includes(event.messageText)) {
      bucket.samples.push(event.messageText.slice(0, 120));
    }
    if (event.verdict === 'off_topic' || event.verdict === 'off_topic_shadow') bucket.off += 1;
    else if (event.verdict === 'pass_flagged' || event.verdict === 'pass_flagged_shadow') bucket.flagged += 1;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries())
    .map(([bucket, v]) => ({ bucket, count: v.count, sampleTexts: v.samples, offTopic: v.off, passFlagged: v.flagged }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function computeModelBreakdown(events: QaGuardrailEvent[]): { breakdown: QaGuardrailModelBreakdown[]; fallbackHitRate: number } {
  const counts = new Map<string, number>();
  let withModel = 0;
  for (const event of events) {
    if (!event.model) continue;
    withModel += 1;
    counts.set(event.model, (counts.get(event.model) ?? 0) + 1);
  }
  const breakdown = Array.from(counts.entries())
    .map(([model, count]) => ({ model, count, ratio: withModel > 0 ? count / withModel : 0 }))
    .sort((a, b) => b.count - a.count);
  // fallback 命中率：非首档（第一个 = 主档，按调用量排序）之外的比例
  const primaryCount = breakdown[0]?.count ?? 0;
  const fallbackHitRate = withModel > 0 ? (withModel - primaryCount) / withModel : 0;
  return { breakdown, fallbackHitRate };
}

function computeDailyCounts(events: QaGuardrailEvent[]): Array<{ date: string; count: number }> {
  const buckets = new Map<string, number>();
  for (const event of events) {
    const date = event.createdAt.slice(0, 10);
    buckets.set(date, (buckets.get(date) ?? 0) + 1);
  }
  return Array.from(buckets.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface UseQaGuardrailBoardParams {
  tenantId?: string;
  orgAgentId?: string;
  mode: QaGuardrailMode;
  from?: string;
  to?: string;
}

/**
 * shadow 数据看板派生 hook——一次拉近 200 条明细，前端派生 4 视图数据。
 * mode 变化本地过滤（不重新请求）；tenantId/orgAgentId/时间变化重新请求。
 */
export function useQaGuardrailBoard(params: UseQaGuardrailBoardParams): {
  board: QaGuardrailBoard;
  loading: boolean;
  error: string | null;
  availability: QaAvailability;
  truncated: boolean;
  refresh: () => void;
} {
  const [rawEvents, setRawEvents] = useState<QaGuardrailEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<QaAvailability>('unknown');
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const query = buildParams({
        tenantId: params.tenantId,
        orgAgentId: params.orgAgentId,
        from: params.from,
        to: params.to,
        offset: 0,
        limit: BOARD_SAMPLE_LIMIT,
      });
      const res = await authFetch(`/api/admin/qa/guardrail-events?${query.toString()}`);
      if (requestId !== requestIdRef.current) return;
      if (res.status === 503) {
        setAvailability('unavailable');
        return;
      }
      if (!res.ok) throw new Error(await readError(res, `HTTP ${res.status}`));
      const data = await res.json() as { events: QaGuardrailEvent[]; total: number };
      if (requestId !== requestIdRef.current) return;
      setAvailability('available');
      setRawEvents(data.events);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [params.tenantId, params.orgAgentId, params.from, params.to]);

  useEffect(() => {
    void load();
    return () => { requestIdRef.current += 1; };
  }, [load]);

  const board = useMemo<QaGuardrailBoard>(() => {
    const filtered = filterEventsByMode(rawEvents, params.mode);
    const offTopicCount = filtered.filter((e) => e.verdict.startsWith('off_topic')).length;
    const passFlaggedCount = filtered.filter((e) => e.verdict.startsWith('pass_flagged')).length;
    const { breakdown, fallbackHitRate } = computeModelBreakdown(filtered);
    return {
      total: filtered.length,
      offTopicCount,
      passFlaggedCount,
      topRejections: computeTopRejections(filtered),
      modelBreakdown: breakdown,
      fallbackHitRate,
      latency: computeLatency(filtered),
      dailyCounts: computeDailyCounts(filtered),
    };
  }, [rawEvents, params.mode]);

  return {
    board,
    loading,
    error,
    availability,
    truncated: total > rawEvents.length,
    refresh: load,
  };
}

/**
 * 员工申诉队列 hook——列表 + 处理动作（接受/拒绝）。
 * B4 后端端点 `/api/tenant/appeals` 未装配时 404 → availability='unavailable' 提示未部署。
 */
export function useQaAppeals(filter: QaAppealsFilter): {
  items: QaAppealItem[];
  loading: boolean;
  error: string | null;
  availability: QaAvailability;
  refresh: () => void;
  handle: (id: string, action: 'accept' | 'reject', note?: string) => Promise<void>;
} {
  const [items, setItems] = useState<QaAppealItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<QaAvailability>('unknown');
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const query = buildParams({
        tenantId: filter.tenantId,
        orgAgentId: filter.orgAgentId,
        status: filter.status,
      });
      const res = await authFetch(`/api/tenant/appeals?${query.toString()}`);
      if (requestId !== requestIdRef.current) return;
      if (res.status === 404 || res.status === 503) {
        setAvailability('unavailable');
        setItems([]);
        return;
      }
      if (!res.ok) throw new Error(await readError(res, `HTTP ${res.status}`));
      const data = await res.json() as { items: QaAppealItem[] } | QaAppealItem[];
      if (requestId !== requestIdRef.current) return;
      const list = Array.isArray(data) ? data : data.items;
      // pending 排前面（管理员优先处理）
      const sorted = [...list].sort((a, b) => {
        if (a.status === b.status) return b.createdAt.localeCompare(a.createdAt);
        if (a.status === 'pending') return -1;
        if (b.status === 'pending') return 1;
        return b.createdAt.localeCompare(a.createdAt);
      });
      setAvailability('available');
      setItems(sorted);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [filter.tenantId, filter.orgAgentId, filter.status]);

  useEffect(() => {
    void load();
    return () => { requestIdRef.current += 1; };
  }, [load]);

  const handle = useCallback(async (id: string, action: 'accept' | 'reject', note?: string) => {
    const res = await authFetch(`/api/tenant/appeals/${encodeURIComponent(id)}/handle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, note }),
    });
    if (!res.ok) throw new Error(await readError(res, `HTTP ${res.status}`));
    await load();
  }, [load]);

  return { items, loading, error, availability, refresh: load, handle };
}
