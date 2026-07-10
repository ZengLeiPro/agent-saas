/**
 * 质检台数据 hooks
 *
 * - useQaSessions：cursor 分页（加载更多）；过滤条件变化时**先清空旧数据**再拉取，
 *   避免请求期间短暂展示旧过滤器的数据（仿 TenantAnalytics requestId 守卫）
 * - useQaGuardrailEvents / useQaFeedback：offset 分页（上一页/下一页，仿 AuditEventsPanel）
 * - 503 → availability='unavailable'（file backend 未装配 PG，前端隐藏换提示）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import type {
  QaAvailability,
  QaEventsFilter,
  QaFeedbackFilter,
  QaFeedbackItem,
  QaGuardrailEvent,
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
