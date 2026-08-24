/** RuntimeEfficiencyQuery explicit-window invariants and SQL parameter tests. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeEfficiencyQuery } from '../runtime/efficiencyQuery.js';

class RecordingPool {
  readonly calls: Array<{ text: string; params?: unknown[] }> = [];

  async query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.calls.push({ text, params });
    return { rows: [] };
  }
}

function createSubject(): { pool: RecordingPool; query: RuntimeEfficiencyQuery } {
  const pool = new RecordingPool();
  return {
    pool,
    query: new RuntimeEfficiencyQuery({
      pool,
      eventsTable: 'runtime_events',
      runsTable: 'runtime_runs',
      billingUsageEventsTable: 'runtime_billing_usage_events',
    }),
  };
}

function sqlTag(text: string): string | undefined {
  return /\/\* (eff:[^ ]+) \*\//.exec(text)?.[1];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RuntimeEfficiencyQuery 显式时间窗口', () => {
  it('未来 to 仅供统计范围使用，long_running 与 dataAsOf 截止当前 observedAt', async () => {
    const now = '2026-08-24T00:00:00.000Z';
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
    const { pool, query } = createSubject();
    const from = '2026-08-18T00:00:00.000Z';
    const to = '2026-08-25T00:00:00.000Z';

    const report = await query.getEfficiency({ days: 7, from, to, tenantId: 'kaiyan' });

    expect(pool.calls).toHaveLength(15);
    for (const call of pool.calls) {
      if (sqlTag(call.text) === 'eff:long_running_runs') {
        expect(call.params).toEqual([from, 'kaiyan', to, now]);
        expect(call.text).toContain('$4::timestamptz - COALESCE(started_at, requested_at)');
        expect(call.text).toContain("$4::timestamptz - interval '24 hours'");
        expect(call.text).toContain('requested_at < $3::timestamptz');
      } else {
        expect(call.params).toEqual([from, 'kaiyan', to]);
      }
    }
    expect(report.range).toEqual({ from, to, days: 7, bounds: '[from,to)' });
    expect(report.statistics.dataAsOf).toBe(now);
    expect(Date.parse(report.statistics.dataAsOf)).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    ['仅 from', { days: 7, from: '2026-08-18T00:00:00.000Z' }],
    ['仅 to', { days: 7, to: '2026-08-25T00:00:00.000Z' }],
    ['from 不可解析', { days: 7, from: 'not-a-date', to: '2026-08-25T00:00:00.000Z' }],
    ['to 不可解析', { days: 7, from: '2026-08-18T00:00:00.000Z', to: 'not-a-date' }],
    ['from 等于 to', { days: 7, from: '2026-08-25T00:00:00.000Z', to: '2026-08-25T00:00:00.000Z' }],
    ['from 晚于 to', { days: 7, from: '2026-08-26T00:00:00.000Z', to: '2026-08-25T00:00:00.000Z' }],
    ['跨度不等于 days × 24h', { days: 7, from: '2026-08-17T00:00:00.000Z', to: '2026-08-25T00:00:00.000Z' }],
  ])('%s 时拒绝且不发 SQL', async (_label, opts) => {
    const { pool, query } = createSubject();

    await expect(query.getEfficiency(opts)).rejects.toThrow();

    expect(pool.calls).toHaveLength(0);
  });
});
