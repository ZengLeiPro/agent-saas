import { describe, expect, it, vi } from 'vitest';

import { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';

describe('PgToolInvocationStore admin analysis', () => {
  it('applies tenant/user/tool/skill/error filters and maps summaries', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT t.invocation_id')) {
        return { rows: [{
          invocation_id: 'inv-1', run_id: 'run-1', session_id: 'session-1', tenant_id: 'wain',
          user_id: 'u-1', username: 'alice', tool_name: 'Skill', skill_name: 'ky-data-query',
          execution_target: 'server-remote', status: 'failed',
          started_at: '2026-07-15T08:00:00.000Z', completed_at: '2026-07-15T08:00:01.000Z',
          duration_ms: '1000', error: 'quota exceeded',
        }] };
      }
      if (sql.includes('AS skill_calls')) {
        return { rows: [{ total: 1, failed: 1, affected_tenants: 1, affected_users: 1, skill_calls: 1, skill_calls_tracked: 1 }] };
      }
      if (sql.includes('GROUP BY t.tool_name')) {
        return { rows: [{ tool_name: 'Skill', count: 1, failed: 1, avg_duration_ms: '1000', last_called_at: '2026-07-15T08:00:00.000Z' }] };
      }
      return { rows: [{ skill_name: 'ky-data-query', count: 1, failed: 1, affected_tenants: 1, affected_users: 1, last_called_at: '2026-07-15T08:00:00.000Z' }] };
    });
    const store = new PgToolInvocationStore({ pool: { query } as any, tablePrefix: 'runtime' });

    const result = await store.listForAdmin({
      tenantId: 'wain', userId: 'u-1', toolName: 'Skill', skillName: 'ky-data-query',
      status: 'failed', reasonContains: 'quota', hours: 72, limit: 20, offset: 40,
    });

    expect(result.items[0]).toMatchObject({
      tenantId: 'wain', userId: 'u-1', toolName: 'Skill', skillName: 'ky-data-query',
      status: 'failed', durationMs: 1000,
    });
    expect(result.summary).toEqual({
      total: 1, failed: 1, affectedTenants: 1, affectedUsers: 1, skillCalls: 1, skillCallsTracked: 1,
    });
    expect(result.byTool[0]).toMatchObject({ toolName: 'Skill', failed: 1, avgDurationMs: 1000 });
    expect(result.bySkill[0]).toMatchObject({ skillName: 'ky-data-query', affectedUsers: 1 });

    const [detailSql, detailParams] = query.mock.calls.find(([sql]) => String(sql).includes('SELECT t.invocation_id'))! as unknown as [string, unknown[]];
    expect(detailSql).toContain('t.tenant_id =');
    expect(detailSql).toContain('s.user_id =');
    expect(detailSql).toContain("metadata->>'skillName'");
    expect(detailSql).toContain('ILIKE');
    expect(detailParams).toEqual([72, 'wain', 'u-1', 'Skill', 'ky-data-query', 'failed', 'quota', 20, 40]);
  });
});
