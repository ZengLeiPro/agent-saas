import { describe, expect, it } from 'vitest';

import {
  GovernanceAuditUnavailableError,
  InMemoryGovernanceAuditStore,
  PgGovernanceAuditStore,
  governanceDigest,
  recordGovernanceIntent,
  recordGovernanceOutcome,
} from '../data/governance-audit/index.js';

describe('治理审计存储', () => {
  const actor = { sub: 'user-platform-1', role: 'admin', tenantId: 'pantheon' };

  it('以独立 intent/outcome 事件追加，使用不可变 userId 与同一 correlationId', async () => {
    const store = new InMemoryGovernanceAuditStore();
    const intent = await recordGovernanceIntent(store, actor, {
      action: 'tenant.delete',
      targetType: 'tenant',
      targetId: 'acme',
      targetTenantId: 'acme',
      purpose: 'platform_governance',
      reason: 'confirmed_hard_delete',
      beforeDigest: governanceDigest({ id: 'acme', disabled: false }),
    });
    const outcome = await recordGovernanceOutcome(store, intent, 'succeeded', {
      afterDigest: governanceDigest({ deleted: true }),
      metadata: { usersDeleted: 2 },
    });

    expect(store.events).toHaveLength(2);
    expect(intent).toMatchObject({
      actorUserId: 'user-platform-1',
      actorPersona: 'platform_admin',
      result: 'intent',
    });
    expect(outcome).toMatchObject({
      correlationId: intent.correlationId,
      changeId: intent.auditId,
      result: 'succeeded',
    });
    expect(outcome.auditId).not.toBe(intent.auditId);
  });

  it('拒绝可能承载正文或 Secret 的 metadata key', async () => {
    const store = new InMemoryGovernanceAuditStore();
    await expect(store.append({
      correlationId: 'correlation-1',
      actorType: 'user',
      actorUserId: 'user-1',
      actorPersona: 'platform_admin',
      action: 'tenant.delete',
      targetType: 'tenant',
      targetId: 'acme',
      purpose: 'platform_governance',
      result: 'intent',
      metadata: { messagePreview: '不得落库' },
    })).rejects.toThrow(/Unsafe governance audit metadata key/);
  });

  it('PG store 使用独立 schema version 与仅追加 INSERT', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, ...(params ? { params } : {}) });
      return { rows: [], rowCount: 0 };
    };
    const pool = {
      query,
      connect: async () => ({ query, release: () => undefined }),
    };
    const store = new PgGovernanceAuditStore({ pool: pool as never, tablePrefix: 'test' });
    await store.init();
    const initQueryCount = queries.length;
    await store.append({
      correlationId: 'correlation-1',
      actorType: 'user',
      actorUserId: 'user-1',
      actorPersona: 'platform_admin',
      action: 'billing.account.adjust',
      targetType: 'billing_account',
      targetId: 'acme',
      targetTenantId: 'acme',
      purpose: 'financial_adjustment',
      result: 'intent',
      metadata: { creditsDelta: 100 },
    });

    expect(queries.some(item => item.sql.includes('test_governance_schema_versions'))).toBe(true);
    const appendQueries = queries.slice(initQueryCount);
    expect(appendQueries.at(-1)?.sql).toContain('INSERT INTO test_governance_audit_events');
    expect(appendQueries.every(item => !/\bUPDATE\b|\bDELETE\b/.test(item.sql))).toBe(true);
  });

  it('intent 存储不可用时统一包装为 fail-closed 错误', async () => {
    await expect(recordGovernanceIntent({
      append: async () => { throw new Error('database down'); },
    }, actor, {
      action: 'workspace.delete',
      targetType: 'workspace',
      targetId: 'tenant/user',
      purpose: 'storage_governance',
    })).rejects.toBeInstanceOf(GovernanceAuditUnavailableError);
  });
});
