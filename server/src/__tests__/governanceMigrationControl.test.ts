import { describe, expect, it, vi } from 'vitest';

import {
  GOVERNANCE_MIGRATION_DOMAINS,
  GovernanceMigrationControlInvariantError,
  GovernanceShadowComparator,
  GovernanceWriteGate,
  PgGovernanceMigrationControlStore,
  governanceProjectionDigest,
} from '../data/migrationControl/index.js';

const NOW = '2026-08-08T00:00:00.000Z';

function controlRow(overrides: Record<string, unknown> = {}) {
  return {
    control_id: 'global', mode: 'shadow', write_authority: 'dual', legacy_writes_sealed: false,
    compatibility_projection_enabled: true, rollback_enabled: true, revision: '1',
    updated_at: NOW, updated_by: 'system', update_reason: 'initial', ...overrides,
  };
}

function domainRow(domain: string, overrides: Record<string, unknown> = {}) {
  return {
    domain, status: 'shadow', compared_count: '0', matched_count: '0', difference_count: '0',
    unresolved_blocking_count: '0', revision: '1', last_compared_at: null,
    updated_at: NOW, updated_by: 'system', ...overrides,
  };
}

function buildStatePool() {
  let control: Record<string, any> = controlRow();
  const domains = new Map<string, Record<string, any>>(
    GOVERNANCE_MIGRATION_DOMAINS.map(domain => [domain, domainRow(domain)]),
  );
  const differences = new Map<string, Record<string, any>>();
  const query = async (sql: string, params: any[] = []) => {
    if (sql.includes("SELECT * FROM test_governance_migration_control WHERE control_id='global'")) {
      return { rows: [control], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM test_governance_migration_domains ORDER BY')) {
      return { rows: [...domains.values()], rowCount: domains.size };
    }
    if (sql.includes('UPDATE test_governance_migration_control') && sql.includes('write_authority=$2')) {
      if (Number(control.revision) !== Number(params[0]) || control.mode !== 'shadow') return { rows: [], rowCount: 0 };
      control = {
        ...control, write_authority: params[1], legacy_writes_sealed: params[2],
        compatibility_projection_enabled: params[3], rollback_enabled: params[4],
        revision: String(Number(control.revision) + 1), updated_by: params[5], update_reason: params[6],
      };
      return { rows: [control], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_governance_migration_domains') && sql.includes('compared_count=$3')) {
      const row = domains.get(params[0] as any);
      if (!row || Number(row.revision) !== Number(params[7])) return { rows: [], rowCount: 0 };
      const updated = {
        ...row, status: params[1], compared_count: String(params[2]), matched_count: String(params[3]),
        difference_count: String(params[4]), unresolved_blocking_count: String(params[5]),
        revision: String(Number(row.revision) + 1), last_compared_at: NOW, updated_by: params[6],
      };
      domains.set(params[0] as any, updated);
      return { rows: [updated], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO test_governance_shadow_differences')) {
      const key = `${params[1]}:${params[2]}:${params[3]}:${params[4]}:${params[5]}`;
      const existing = differences.get(key);
      const row = {
        difference_id: existing?.difference_id ?? params[0], domain: params[1], tenant_scope: params[2],
        resource_type: params[3], resource_id: params[4], category: params[5], legacy_digest: params[6],
        governance_digest: params[7], blocking: params[8], status: 'open', first_seen_at: existing?.first_seen_at ?? NOW,
        last_seen_at: NOW, resolved_at: null, resolved_by: null, resolution_reason: null,
      };
      differences.set(key, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_governance_shadow_differences') && sql.includes('status=$2')) {
      const row = [...differences.values()].find(item => item.difference_id === params[0] && item.status === 'open');
      if (!row) return { rows: [], rowCount: 0 };
      const updated = { ...row, status: params[1], resolved_at: NOW, resolved_by: params[2], resolution_reason: params[3] };
      for (const [key, value] of differences) if (value === row) differences.set(key, updated);
      return { rows: [updated], rowCount: 1 };
    }
    if (sql.includes("SELECT * FROM test_governance_migration_control WHERE control_id='global' FOR UPDATE")) {
      return { rows: [control], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM test_governance_migration_domains FOR UPDATE')) {
      return { rows: [...domains.values()], rowCount: domains.size };
    }
    if (sql.includes('SELECT COUNT(*) AS count FROM test_governance_shadow_differences')) {
      const count = [...differences.values()].filter(row => row.status === 'open' && row.blocking === true).length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_governance_migration_control') && sql.includes('SET mode=$2')) {
      if (Number(control.revision) !== Number(params[0])) return { rows: [], rowCount: 0 };
      control = { ...control, mode: params[1], revision: String(Number(control.revision) + 1), updated_by: params[2], update_reason: params[3] };
      return { rows: [control], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_governance_migration_domains SET status=$1')) {
      for (const [domain, row] of domains) {
        domains.set(domain, { ...row, status: params[0], revision: String(Number(row.revision) + 1), updated_by: params[1] });
      }
      return { rows: [], rowCount: domains.size };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool: pool as never, domains, differences, getControl: () => control };
}

describe('Governance Migration Control', () => {
  it('migration V16 创建批次门禁、内容 Grant、Run Snapshot 并跑完当前 ledger', async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT version FROM')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgGovernanceMigrationControlStore({ pool: pool as never, tablePrefix: 'test' });
    await store.init();
    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_governance_migration_control');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_governance_migration_domains');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_governance_shadow_differences');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS last_batch_total');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS last_batch_at');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS target_type TEXT');
    expect(sql).toContain("target_type IN ('session','guardrail_collection')");
    expect(sql).toContain('ADD PRIMARY KEY (run_id,snapshot_digest)');
    expect(sql).toContain('snapshot_sequence BIGSERIAL');
    expect(sql).toContain('CREATE TRIGGER test_membership_projection_outbox');
    expect(sql).toContain('CREATE TRIGGER test_platform_admin_projection_outbox');
    expect(sql).toContain('CREATE TRIGGER test_assignment_projection_outbox');
    expect(sql).toContain('CREATE TRIGGER test_assignment_delete_projection_outbox');
    expect(sql).toContain('CREATE TRIGGER test_preference_projection_outbox');
    expect(sql).toContain('CREATE TRIGGER test_entitlement_projection_outbox');
    expect(queries.filter(item => item === 'BEGIN')).toHaveLength(37);
  });

  it('tenantless shadow difference 使用同一空 tenant scope 自动 resolve', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ difference_id: 'diff-1' }], rowCount: 1 });
    const store = new PgGovernanceMigrationControlStore({ pool: { query } as never, tablePrefix: 'test' });
    await expect(store.resolveDifferencesForResource({
      domain: 'assignment', resourceType: 'skill', resourceId: 'skill-1', resolvedBy: 'auditor',
    })).resolves.toBe(1);
    expect(query.mock.calls[0]?.[1]).toEqual(['assignment', '', 'skill', 'skill-1', 'auditor']);
  });

  it('单个 matching 比较不能把整个 Domain 提前标为 ready', async () => {
    let updateSql = '';
    const query = async (sql: string) => {
      updateSql = sql;
      return { rows: [domainRow('assignment', { compared_count: '1', matched_count: '1' })], rowCount: 1 };
    };
    const store = new PgGovernanceMigrationControlStore({
      pool: { query, connect: async () => ({ query, release: () => undefined }) } as never,
      tablePrefix: 'test',
    });
    const state = await store.incrementDomainComparison('assignment', true);
    expect(state.status).toBe('shadow');
    expect(updateSql).toContain("THEN 'shadow' ELSE d.status END");
    expect(updateSql).not.toContain("THEN 'ready'");
  });

  it('canonical comparator 忽略 object key 顺序，相同不造差异', async () => {
    const writes: unknown[] = [];
    const comparator = new GovernanceShadowComparator({ recordDifference: async input => {
      writes.push(input);
      return {} as never;
    } });
    expect(governanceProjectionDigest({ a: 1, b: 2 })).toBe(governanceProjectionDigest({ b: 2, a: 1 }));
    await expect(comparator.compare({
      domain: 'assignment', tenantId: 'acme', resourceType: 'skill', resourceId: 's1',
      legacy: { a: 1, b: 2 }, governance: { b: 2, a: 1 },
    })).resolves.toEqual({ matched: true });
    expect(writes).toHaveLength(0);
  });

  it('差异分类并脱敏为 digest，不保存原值', async () => {
    const { pool } = buildStatePool();
    const store = new PgGovernanceMigrationControlStore({ pool, tablePrefix: 'test' });
    const comparator = new GovernanceShadowComparator(store);
    const result = await comparator.compare({
      domain: 'agent_skill', tenantId: 'acme', resourceType: 'org_agent', resourceId: 'oa-1',
      legacy: { revision: 1 }, governance: { revision: 2 }, blocking: true,
    });
    expect(result).toMatchObject({ matched: false, category: 'value_mismatch' });
    expect(result.difference?.legacyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.difference)).not.toContain('revision');
  });

  it('空比较批次不能伪造 ready', async () => {
    const { pool } = buildStatePool();
    const store = new PgGovernanceMigrationControlStore({ pool, tablePrefix: 'test' });
    await expect(store.recordDomainSnapshot({
      domain: 'membership', expectedRevision: 1, comparedCount: 0, matchedCount: 0,
      differenceCount: 0, unresolvedBlockingCount: 0, updatedBy: 'auditor',
    })).resolves.toMatchObject({ status: 'shadow' });
  });

  it('enforce 前必须七个 domain ready、无 blocking diff、封旧写且启用回滚投影', async () => {
    const { pool } = buildStatePool();
    const store = new PgGovernanceMigrationControlStore({ pool, tablePrefix: 'test' });
    await expect(store.transitionMode({ expectedRevision: 1, mode: 'enforce', updatedBy: 'admin', reason: 'cutover' }))
      .rejects.toMatchObject({ code: 'MIGRATION_DOMAIN_NOT_READY' });
    const settings = await store.updateSettings({
      expectedRevision: 1, writeAuthority: 'governance', legacyWritesSealed: true,
      compatibilityProjectionEnabled: true, rollbackEnabled: true, updatedBy: 'admin', reason: 'prepare',
    });
    for (const domain of GOVERNANCE_MIGRATION_DOMAINS) {
      await store.recordDomainSnapshot({
        domain, expectedRevision: 1, comparedCount: 10, matchedCount: 10,
        differenceCount: 0, unresolvedBlockingCount: 0, updatedBy: 'auditor',
      });
    }
    await expect(store.transitionMode({
      expectedRevision: settings.revision, mode: 'enforce', updatedBy: 'admin', reason: 'all green',
    })).resolves.toMatchObject({ mode: 'enforce' });
  });

  it('blocking diff 阻止 enforce；解决后才可继续', async () => {
    const { pool } = buildStatePool();
    const store = new PgGovernanceMigrationControlStore({ pool, tablePrefix: 'test' });
    const settings = await store.updateSettings({
      expectedRevision: 1, writeAuthority: 'governance', legacyWritesSealed: true,
      compatibilityProjectionEnabled: true, rollbackEnabled: true, updatedBy: 'admin', reason: 'prepare',
    });
    for (const domain of GOVERNANCE_MIGRATION_DOMAINS) {
      await store.recordDomainSnapshot({ domain, expectedRevision: 1, comparedCount: 1, matchedCount: 1, differenceCount: 0, unresolvedBlockingCount: 0, updatedBy: 'auditor' });
    }
    const difference = await store.recordDifference({
      domain: 'assignment', tenantId: 'acme', resourceType: 'skill', resourceId: 's1',
      category: 'value_mismatch', blocking: true,
    });
    await expect(store.transitionMode({ expectedRevision: settings.revision, mode: 'enforce', updatedBy: 'admin', reason: 'cutover' }))
      .rejects.toMatchObject({ code: 'MIGRATION_BLOCKING_DIFFERENCES' });
    await store.resolveDifference(difference.differenceId, 'admin', '已完成源数据核对', true);
    await expect(store.transitionMode({ expectedRevision: settings.revision, mode: 'enforce', updatedBy: 'admin', reason: 'cutover' }))
      .resolves.toMatchObject({ mode: 'enforce' });
  });

  it('revision 冲突拒绝覆盖控制状态，回滚到 shadow 后用户 legacy 写仍保持封口', async () => {
    const { pool } = buildStatePool();
    const store = new PgGovernanceMigrationControlStore({ pool, tablePrefix: 'test' });
    await expect(store.updateSettings({
      expectedRevision: 99, writeAuthority: 'dual', legacyWritesSealed: false,
      compatibilityProjectionEnabled: true, rollbackEnabled: true, updatedBy: 'admin', reason: 'stale',
    })).rejects.toMatchObject({ code: 'MIGRATION_CONTROL_VERSION_CONFLICT' });

    const rollbackGate = new GovernanceWriteGate({ getControl: async () => ({
      controlId: 'global', mode: 'rollback', writeAuthority: 'legacy', legacyWritesSealed: false,
      compatibilityProjectionEnabled: true, rollbackEnabled: true,
      revision: 3, updatedAt: NOW, updatedBy: 'admin', updateReason: 'rollback',
    }) });
    await expect(rollbackGate.assertLegacyWriteAllowed({ actor: 'user', compatibilityProjection: false })).rejects.toMatchObject({ code: 'MIGRATION_LEGACY_WRITE_SEALED' });
    await expect(rollbackGate.enforcementMode()).resolves.toBe('shadow');
  });

  it('enforce 封旧写，仅兼容投影 service 可写', async () => {
    const enforceControl = { ...controlRow(), mode: 'enforce', write_authority: 'governance', legacy_writes_sealed: true } as any;
    const gate = new GovernanceWriteGate({ getControl: async () => ({
      controlId: 'global', mode: enforceControl.mode, writeAuthority: enforceControl.write_authority,
      legacyWritesSealed: true, compatibilityProjectionEnabled: true, rollbackEnabled: true,
      revision: 2, updatedAt: NOW, updatedBy: 'admin', updateReason: 'cutover',
    }) });
    await expect(gate.assertLegacyWriteAllowed({ actor: 'user', compatibilityProjection: false }))
      .rejects.toBeInstanceOf(GovernanceMigrationControlInvariantError);
    await expect(gate.assertLegacyWriteAllowed({ actor: 'service', compatibilityProjection: true })).resolves.toBeUndefined();
    await expect(gate.enforcementMode()).resolves.toBe('enforce');
  });
});
