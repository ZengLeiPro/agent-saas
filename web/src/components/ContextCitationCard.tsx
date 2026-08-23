import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { cn } from '@/lib/utils';
import {
  ContextCitationDrawer,
  type ContextCitationDetail,
  type ContextCitationEvidence,
} from './ContextCitationDrawer';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstBoolean(record: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (typeof record[key] === 'boolean') return record[key] as boolean;
  }
  return false;
}

function normalizeSource(record: Record<string, unknown>): string {
  const source = record.source;
  if (typeof source === 'string' && source.trim()) return source.trim();
  const sourceRecord = asRecord(source);
  if (sourceRecord) {
    const values = [
      firstString(sourceRecord, ['displayName', 'name', 'sourceName', 'system', 'kind']),
      firstString(sourceRecord, ['collection', 'collectionName']),
    ].filter((value): value is string => !!value);
    if (values.length) return [...new Set(values)].join(' · ');
  }
  return firstString(record, ['sourceName', 'source_name', 'system', 'collection']) || '未提供';
}

function normalizeOccurredAt(record: Record<string, unknown>): string | null {
  const direct = firstString(record, ['occurredAt', 'occurred_at', 'sourceTime', 'source_time', 'timestamp', 'createdAt']);
  if (direct) return direct;
  const time = asRecord(record.time);
  return time ? firstString(time, ['occurredAt', 'sourceUpdatedAt', 'observedAt']) : null;
}

function normalizeFreshness(record: Record<string, unknown>): { value: string; asOf: string | null } {
  const freshness = record.freshness;
  if (typeof freshness === 'string' && freshness.trim()) {
    return {
      value: freshness.trim(),
      asOf: firstString(record, ['freshnessAsOf', 'freshness_as_of']),
    };
  }
  const freshnessRecord = asRecord(freshness);
  return {
    value: freshnessRecord
      ? firstString(freshnessRecord, ['status', 'value', 'label']) || '未评估'
      : '未评估',
    asOf: freshnessRecord
      ? firstString(freshnessRecord, ['asOf', 'as_of', 'evaluatedAt'])
      : firstString(record, ['freshnessAsOf', 'freshness_as_of']),
  };
}

function normalizeEvidenceItem(value: unknown): ContextCitationEvidence | null {
  if (typeof value === 'string' && value.trim()) {
    return { quote: value.trim(), author: null, nativeUrl: null };
  }
  const record = asRecord(value);
  if (!record) return null;
  const quote = firstString(record, ['quote', 'text', 'content', 'excerpt']);
  if (!quote) return null;
  return {
    quote,
    author: firstString(record, ['author', 'authorName', 'speaker', 'createdBy']),
    nativeUrl: firstString(record, ['nativeUrl', 'native_url', 'originalUrl', 'original_url', 'url']),
  };
}

/** 将接口返回规整成 Drawer 只读展示模型；拒绝无对象/无来源的畸形结果。 */
export function normalizeContextCitationDetail(payload: unknown): ContextCitationDetail | null {
  const envelope = asRecord(payload);
  if (!envelope) return null;
  const record = asRecord(envelope.data) || asRecord(envelope.citation) || envelope;
  const freshness = normalizeFreshness(record);
  const rawEvidence = record.evidence ?? record.evidences ?? record.items;
  const evidenceValues = Array.isArray(rawEvidence)
    ? rawEvidence
    : rawEvidence !== undefined && rawEvidence !== null
      ? [rawEvidence]
      : [record];
  const evidence = evidenceValues
    .map(normalizeEvidenceItem)
    .filter((item): item is ContextCitationEvidence => item !== null);
  if (!evidence.length) {
    const fallback = normalizeEvidenceItem({
      quote: firstString(record, ['content', 'quote']),
      author: firstString(record, ['author', 'authorName']),
      nativeUrl: firstString(asRecord(record.source) || {}, ['url']),
    });
    if (fallback) evidence.push(fallback);
  }

  return {
    source: normalizeSource(record),
    occurredAt: normalizeOccurredAt(record),
    freshness: freshness.value,
    freshnessAsOf: freshness.asOf,
    derived: firstBoolean(record, ['derived', 'isDerived', 'is_derived']),
    degraded: firstBoolean(envelope, ['degraded', 'isDegraded', 'is_degraded'])
      || firstBoolean(record, ['degraded', 'isDegraded', 'is_degraded']),
    evidence,
  };
}

export function contextCitationError(status: number): string {
  switch (status) {
    case 401:
      return '401：登录状态已失效，请重新登录后查看。';
    case 403:
      return '403：无权查看此上下文引用。';
    case 404:
      return '404：引用不存在、已撤权，或当前无权查看。';
    case 409:
      return '409：当前授权与会话快照已变化，请新建会话后重试。';
    case 503:
      return '503：上下文服务暂时不可用，请稍后重试。';
    default:
      return `引用证据加载失败（HTTP ${status}），请稍后重试。`;
  }
}

export interface ContextCitationCardProps {
  contextId: string;
  label: string;
  /** 只能来自当前 Chat/MessageList 上下文，不读取 marker 内任何身份字段。 */
  sessionId?: string | null;
}

export function ContextCitationCard({ contextId, label, sessionId }: ContextCitationCardProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContextCitationDetail | null>(null);
  const requestVersion = useRef(0);
  const disabled = !sessionId;

  useEffect(() => () => {
    requestVersion.current += 1;
  }, []);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const currentRequest = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const response = await authFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/context-citations/${encodeURIComponent(contextId)}`,
        { method: 'GET' },
      );
      if (!response.ok) throw new Error(contextCitationError(response.status));
      const normalized = normalizeContextCitationDetail(await response.json());
      if (!normalized) throw new Error('引用证据返回格式错误，请稍后重试。');
      if (requestVersion.current === currentRequest) setDetail(normalized);
    } catch (caught) {
      if (requestVersion.current === currentRequest) {
        setError(caught instanceof Error ? caught.message : '引用证据加载失败，请稍后重试。');
      }
    } finally {
      if (requestVersion.current === currentRequest) setLoading(false);
    }
  }, [contextId, sessionId]);

  const handleOpen = () => {
    if (disabled) return;
    setOpen(true);
    void load();
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        title={disabled ? 'Context 引用仅可在登录后的原会话中查看' : `查看 Context 引用：${label}`}
        aria-label={`Context 引用：${label}`}
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors',
          disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-border',
        )}
      >
        <BookOpen className="size-3.5 shrink-0 text-brand-600" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </button>
      <ContextCitationDrawer
        open={open}
        label={label}
        detail={detail}
        loading={loading}
        error={error}
        onClose={() => setOpen(false)}
        onRetry={() => { void load(); }}
      />
    </>
  );
}
