import { describe, expect, it } from 'vitest';

import {
  contextCitationError,
  contextCitationPath,
  formatContextCitationTime,
  normalizeContextCitationDetail,
  safeContextCitationUrl,
} from './contextCitation';

describe('normalizeContextCitationDetail', () => {
  it('非对象 payload 返回 null', () => {
    expect(normalizeContextCitationDetail(null)).toBeNull();
    expect(normalizeContextCitationDetail('x')).toBeNull();
    expect(normalizeContextCitationDetail([{ quote: 'a' }])).toBeNull();
  });

  it('从 data 信封取正文，来源对象拼接去重', () => {
    const detail = normalizeContextCitationDetail({
      data: {
        source: { displayName: '钉钉', collection: '钉钉' },
        occurredAt: '2026-07-01T10:00:00Z',
        evidence: [{ quote: '原话', author: '张三', url: 'https://a.example/1' }],
      },
    });
    expect(detail).toEqual({
      source: '钉钉',
      occurredAt: '2026-07-01T10:00:00Z',
      freshness: '未评估',
      freshnessAsOf: null,
      derived: false,
      degraded: false,
      evidence: [{ quote: '原话', author: '张三', nativeUrl: 'https://a.example/1' }],
    });
  });

  it('字符串证据与单对象证据都归一成数组', () => {
    expect(normalizeContextCitationDetail({ citation: { evidence: '一句话' } })?.evidence).toEqual([
      { quote: '一句话', author: null, nativeUrl: null },
    ]);
    expect(normalizeContextCitationDetail({ evidences: { text: '另一句' } })?.evidence).toEqual([
      { quote: '另一句', author: null, nativeUrl: null },
    ]);
  });

  it('没有 evidence 字段时正文本身当作一条证据', () => {
    const detail = normalizeContextCitationDetail({
      content: '正文兜底',
      authorName: '李四',
      source: { name: '飞书', url: 'https://b.example' },
    });
    expect(detail?.evidence).toEqual([{ quote: '正文兜底', author: '李四', nativeUrl: null }]);
    expect(detail?.source).toBe('飞书');
  });

  it('evidence 为空数组时才走 source.url 兜底分支', () => {
    const detail = normalizeContextCitationDetail({
      evidence: [],
      quote: '兜底原话',
      author: '王五',
      source: { name: '飞书', url: 'https://b.example' },
    });
    expect(detail?.evidence).toEqual([
      { quote: '兜底原话', author: '王五', nativeUrl: 'https://b.example' },
    ]);
  });

  it('无任何可用证据时 evidence 为空数组（调用侧显示空态）', () => {
    expect(normalizeContextCitationDetail({ source: 'x' })?.evidence).toEqual([]);
  });

  it('freshness 支持字符串与对象两种形态', () => {
    expect(
      normalizeContextCitationDetail({ freshness: ' fresh ', freshnessAsOf: '2026-07-02' }),
    ).toMatchObject({ freshness: 'fresh', freshnessAsOf: '2026-07-02' });
    expect(
      normalizeContextCitationDetail({ freshness: { status: 'stale', asOf: '2026-07-03' } }),
    ).toMatchObject({ freshness: 'stale', freshnessAsOf: '2026-07-03' });
  });

  it('降级标记信封与正文任一为真即为真', () => {
    expect(normalizeContextCitationDetail({ degraded: true, data: {} })?.degraded).toBe(true);
    expect(normalizeContextCitationDetail({ data: { is_derived: true } })?.derived).toBe(true);
  });

  it('marker 夹带的身份字段不会进入结果', () => {
    const detail = normalizeContextCitationDetail({
      tenantId: 't1',
      userId: 'u1',
      sessionId: 's1',
      evidence: [{ quote: 'q' }],
    });
    expect(Object.keys(detail!).sort()).toEqual([
      'degraded',
      'derived',
      'evidence',
      'freshness',
      'freshnessAsOf',
      'occurredAt',
      'source',
    ]);
  });

  it('occurredAt 回落到 time 子对象', () => {
    expect(
      normalizeContextCitationDetail({
        time: { observedAt: '2026-01-01T00:00:00Z' },
        evidence: 'q',
      })?.occurredAt,
    ).toBe('2026-01-01T00:00:00Z');
  });
});

describe('contextCitationError', () => {
  it('已知状态给出明确指引', () => {
    expect(contextCitationError(401)).toContain('重新登录');
    expect(contextCitationError(403)).toContain('无权');
    expect(contextCitationError(404)).toContain('已撤权');
    expect(contextCitationError(409)).toContain('新建会话');
    expect(contextCitationError(503)).toContain('稍后重试');
  });

  it('未知状态回落到通用文案并带上状态码', () => {
    expect(contextCitationError(500)).toBe('引用证据加载失败（HTTP 500），请稍后重试。');
  });
});

describe('safeContextCitationUrl', () => {
  it('只放行 http/https', () => {
    expect(safeContextCitationUrl('https://a.example/x')).toBe('https://a.example/x');
    expect(safeContextCitationUrl('http://a.example/')).toBe('http://a.example/');
    expect(safeContextCitationUrl('javascript:alert(1)')).toBeNull();
    expect(safeContextCitationUrl('data:text/html,x')).toBeNull();
    expect(safeContextCitationUrl('dingtalk://open')).toBeNull();
    expect(safeContextCitationUrl('not a url')).toBeNull();
    expect(safeContextCitationUrl(null)).toBeNull();
    expect(safeContextCitationUrl(undefined)).toBeNull();
    expect(safeContextCitationUrl('')).toBeNull();
  });
});

describe('formatContextCitationTime', () => {
  it('缺省显示未提供，非法值原样回显', () => {
    expect(formatContextCitationTime(null)).toBe('未提供');
    expect(formatContextCitationTime('前天')).toBe('前天');
  });

  it('ISO 时间按 Asia/Shanghai 24 小时制展示', () => {
    expect(formatContextCitationTime('2026-07-01T02:03:04Z')).toBe('2026/07/01 10:03:04');
  });
});

describe('contextCitationPath', () => {
  it('两段都做 URL 编码', () => {
    expect(contextCitationPath('s/1', 'c#2')).toBe('/api/sessions/s%2F1/context-citations/c%232');
  });
});
