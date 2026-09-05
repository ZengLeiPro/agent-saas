/**
 * 会话 Context 引用（[CITE]{"contextId","label"}）的只读展示模型规整。
 *
 * 由 `web/src/components/ContextCitationCard.tsx` / `ContextCitationDrawer.tsx`
 * 里的纯函数下沉而来（web 侧只剩 DOM 绑定，可直接换成本模块）。
 * 数据来自 `GET /api/sessions/:sessionId/context-citations/:contextId`，
 * 字段命名在不同上游系统间不统一，这里做一次容错归一：
 * - 拒绝无对象 / 无证据的畸形结果（返回 null，由调用侧提示「返回格式错误」）；
 * - marker 内可能夹带的 tenant/user/session 字段一律不进入结果；
 * - 原文链接只放行 http/https，其余（javascript: / data: …）判为不可打开。
 */

export interface ContextCitationEvidence {
  quote: string;
  author: string | null;
  nativeUrl: string | null;
}

export interface ContextCitationDetail {
  source: string;
  occurredAt: string | null;
  freshness: string;
  freshnessAsOf: string | null;
  derived: boolean;
  degraded: boolean;
  evidence: ContextCitationEvidence[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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
  const direct = firstString(record, [
    'occurredAt',
    'occurred_at',
    'sourceTime',
    'source_time',
    'timestamp',
    'createdAt',
  ]);
  if (direct) return direct;
  const time = asRecord(record.time);
  return time ? firstString(time, ['occurredAt', 'sourceUpdatedAt', 'observedAt']) : null;
}

function normalizeFreshness(record: Record<string, unknown>): {
  value: string;
  asOf: string | null;
} {
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
    nativeUrl: firstString(record, [
      'nativeUrl',
      'native_url',
      'originalUrl',
      'original_url',
      'url',
    ]),
  };
}

/** 将接口返回规整成只读展示模型；拒绝无对象/无证据的畸形结果。 */
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
    degraded:
      firstBoolean(envelope, ['degraded', 'isDegraded', 'is_degraded']) ||
      firstBoolean(record, ['degraded', 'isDegraded', 'is_degraded']),
    evidence,
  };
}

/** HTTP 状态 → 面向用户的失败文案（两端同一口径） */
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

/** 只放行 http/https 的原文链接；其余返回 null（调用侧提示「因安全策略不可打开」） */
export function safeContextCitationUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** 引用时间展示（Asia/Shanghai 24 小时制）；不可解析时原样回显 */
export function formatContextCitationTime(value: string | null | undefined): string {
  if (!value) return '未提供';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

/** 会话 Context 引用证据接口路径（两端同一条） */
export function contextCitationPath(sessionId: string, contextId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/context-citations/${encodeURIComponent(contextId)}`;
}
