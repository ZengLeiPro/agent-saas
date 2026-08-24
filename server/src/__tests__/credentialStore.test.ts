import { describe, expect, it } from 'vitest';

import { PgCredentialStore } from '../data/credentials/store.js';
import { CredentialInvariantError } from '../data/credentials/types.js';

const NOW = '2026-08-08T00:00:00.000Z';

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    credential_id: 'cred-1',
    tenant_id: 'acme',
    connector_id: 'google_workspace',
    kind: 'personal_grant',
    owner_user_id: 'user-1',
    custodian_user_id: null,
    owner_username: 'alice',
    alias: null,
    purpose: 'Google Workspace API',
    scope_summary_json: {},
    status: 'active',
    generation: '1',
    secret_ref: 'ref-1',
    expires_at: null,
    last_validated_at: null,
    source: 'legacy_projection',
    version: '1',
    created_at: NOW,
    created_by: 'system',
    updated_at: NOW,
    updated_by: 'system',
    ...overrides,
  };
}

interface PoolState {
  credentialRows: Record<string, unknown>[];
  issueRows: Record<string, unknown>[];
}

function buildPool(state: PoolState = { credentialRows: [], issueRows: [] }) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const query = async (sql: string, params?: unknown[]) => {
    const boundParams = params ?? [];
    queries.push({ sql, params: boundParams });
    if (sql.includes('SELECT version FROM')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO test_credentials')) {
      if (sql.includes('RETURNING')) {
        // create: id, tenant, connector, kind, owner, custodian, username, alias,
        // purpose, scope json, secretRef, expiresAt, createdBy
        const duplicate = state.credentialRows.some(row => row.secret_ref === boundParams[10]);
        if (duplicate) return { rows: [], rowCount: 0 };
        const inserted = credentialRow({
          credential_id: boundParams[0],
          tenant_id: boundParams[1],
          connector_id: boundParams[2],
          kind: boundParams[3],
          owner_user_id: boundParams[4],
          custodian_user_id: boundParams[5],
          owner_username: boundParams[6],
          alias: boundParams[7],
          purpose: boundParams[8],
          scope_summary_json: JSON.parse(String(boundParams[9])),
          secret_ref: boundParams[10],
          expires_at: boundParams[11],
        });
        state.credentialRows.push(inserted);
        return { rows: [inserted], rowCount: 1 };
      }
      // backfill: id, tenant, connector, owner, username, purpose, scope json, secretRef, projectedBy
      const secretRef = boundParams[7];
      if (!state.credentialRows.some(row => row.secret_ref === secretRef)) {
        state.credentialRows.push(credentialRow({
          credential_id: boundParams[0],
          tenant_id: boundParams[1],
          connector_id: boundParams[2],
          kind: 'personal_grant',
          owner_user_id: boundParams[3],
          owner_username: boundParams[4],
          purpose: boundParams[5],
          scope_summary_json: JSON.parse(String(boundParams[6])),
          secret_ref: secretRef,
          source: 'legacy_projection',
        }));
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO test_governance_migration_issues') && sql.includes('RETURNING')) {
      const issue = {
        issue_id: `issue-${state.issueRows.length + 1}`,
        issue_type: boundParams[1],
        tenant_id: boundParams[2],
        resource_type: boundParams[3],
        resource_id: boundParams[4],
        legacy_key: boundParams[5],
        detail_json: boundParams[6],
        status: 'open',
        version: '1',
        created_at: NOW,
        created_by: 'system',
      };
      state.issueRows.push(issue);
      return { rows: [issue], rowCount: 1 };
    }
    if (sql.includes('FROM test_credentials WHERE credential_id')) {
      const id = boundParams[0];
      const row = state.credentialRows.find(r => r.credential_id === id);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('WHERE secret_ref = $1')) {
      const row = state.credentialRows.find(r => r.secret_ref === boundParams[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('UPDATE test_credentials') && sql.includes('generation=generation+1') && sql.includes('RETURNING')) {
      const current = state.credentialRows.find(row => row.credential_id === boundParams[1]);
      if (!current || Number(current.version) !== Number(boundParams[2])) return { rows: [], rowCount: 0 };
      const updated = {
        ...current,
        status: 'active',
        generation: String(Number(current.generation as string) + 1),
        version: String(Number(current.version as string) + 1),
        source: 'governance',
        expires_at: boundParams[4] ? null : current.expires_at,
        scope_summary_json: boundParams[5] === null ? current.scope_summary_json : JSON.parse(String(boundParams[5])),
        updated_by: boundParams[3],
      };
      state.credentialRows = state.credentialRows.map(row => row.credential_id === current.credential_id ? updated : row);
      return { rows: [updated], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_credentials') && sql.includes('RETURNING')) {
      const current = state.credentialRows[0];
      if (!current || Number(current.version) !== Number(boundParams[3])) return { rows: [], rowCount: 0 };
      const updated = {
        ...current,
        status: boundParams[1],
        generation: String(Number(current.generation as string) + (boundParams[1] === 'revoked' ? 1 : 0)),
        version: String(Number(current.version as string) + 1),
      };
      state.credentialRows[0] = updated;
      return { rows: [updated], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_credentials') && sql.includes('legacy_projection')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('WHERE tenant_id = $1 AND owner_user_id = $2')) {
      const rows = state.credentialRows.filter(r => r.tenant_id === boundParams[0] && r.owner_user_id === boundParams[1]);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM test_credentials WHERE tenant_id = $1')) {
      const rows = state.credentialRows.filter(r => r.tenant_id === boundParams[0]);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool: pool as never, queries, state };
}

describe('Credential 治理事实模型', () => {
  it('migration V6 创建带 generation/status 的 credential 表与 secret_ref 唯一索引', async () => {
    const { pool, queries } = buildPool();
    const store = new PgCredentialStore({ pool, tablePrefix: 'test' });
    await store.init();
    const sql = queries.map(item => item.sql).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_credentials');
    expect(sql).toContain('generation BIGINT NOT NULL DEFAULT 1');
    expect(sql).toContain("kind TEXT NOT NULL CHECK (kind IN ('org_shared', 'personal_grant', 'infrastructure'))");
    expect(sql).toContain("status IN ('active', 'rotation_due', 'expired', 'suspended', 'revoked', 'validation_failed')");
    expect(sql).toContain("CHECK (kind <> 'personal_grant' OR owner_user_id IS NOT NULL)");
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS test_credentials_secret_ref_uidx');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_credential_commits');
    expect(sql).toContain('PRIMARY KEY (tenant_id,operation,idempotency_key)');
    expect(sql).toContain('UNIQUE (tenant_id,operation,nonce_digest)');
    expect(queries.filter(item => item.sql === 'BEGIN')).toHaveLength(26);
  });

  it('create 强制 secretRef/owner/kind，重复 secretRef fail closed', async () => {
    const { pool, state } = buildPool();
    const store = new PgCredentialStore({ pool, tablePrefix: 'test' });
    state.credentialRows.push(credentialRow());

    await expect(store.create({
      tenantId: 'acme', ownerUserId: 'user-1', kind: 'personal_grant', secretRef: ' ', purpose: 'test', createdBy: 'admin',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_SECRET_REF_MISSING' });
    await expect(store.create({
      tenantId: 'acme', ownerUserId: '', kind: 'personal_grant', secretRef: 'ref-2', purpose: 'test', createdBy: 'admin',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_PERSONAL_OWNER_MISSING' });
    await expect(store.create({
      tenantId: 'acme', ownerUserId: 'user-1', kind: 'nope' as never, secretRef: 'ref-2', purpose: 'test', createdBy: 'admin',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_KIND_INVALID' });
    await expect(store.create({
      tenantId: 'acme', kind: 'org_shared', secretRef: 'ref-2', purpose: 'test', createdBy: 'admin',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_ORG_CUSTODIAN_MISSING' });
    await expect(store.create({
      tenantId: 'acme', ownerUserId: 'user-1', kind: 'personal_grant', secretRef: 'ref-2', purpose: ' ', createdBy: 'admin',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_PURPOSE_MISSING' });
    await expect(store.create({
      tenantId: 'acme', ownerUserId: 'user-1', kind: 'personal_grant', secretRef: 'ref-1', purpose: 'test', createdBy: 'admin',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_SECRET_REF_CONFLICT' });
    expect(state.credentialRows).toHaveLength(1);
  });

  it('completeRotation 原子更新 Secret generation 与 scopeSummary，版本冲突不改旧元数据', async () => {
    const { pool, state } = buildPool();
    const store = new PgCredentialStore({ pool, tablePrefix: 'test' });
    state.credentialRows.push(credentialRow({
      scope_summary_json: { regionId: 'cn-shenzhen', accountId: 'old-account' }, expires_at: '2026-09-01T00:00:00.000Z',
    }));

    const rotated = await store.completeRotation('acme', 'cred-1', 1, 'user-1', false, {
      regionId: 'cn-hangzhou', accountId: 'new-account', identityType: 'RAMUser',
    });
    expect(rotated).toMatchObject({ generation: 2, version: 2, source: 'governance' });
    expect(rotated.scopeSummary).toEqual({ regionId: 'cn-hangzhou', accountId: 'new-account', identityType: 'RAMUser' });

    await expect(store.completeRotation('acme', 'cred-1', 1, 'user-1', false, {
      regionId: 'cn-beijing', accountId: 'wrong-version',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_VERSION_CONFLICT' });
    expect(state.credentialRows[0]?.scope_summary_json).toEqual({
      regionId: 'cn-hangzhou', accountId: 'new-account', identityType: 'RAMUser',
    });
  });

  it('suspend/revoke 走版本化事务；revoked 终态不可再改，重复 suspend 拒绝', async () => {
    const { pool, state } = buildPool();
    const store = new PgCredentialStore({ pool, tablePrefix: 'test' });
    state.credentialRows.push(credentialRow());

    const suspended = await store.updateStatus('cred-1', {
      status: 'suspended', expectedVersion: 1, updatedBy: 'admin', updateReason: 'test',
    });
    expect(suspended.status).toBe('suspended');
    expect(Number(suspended.version)).toBe(2);

    await expect(store.updateStatus('cred-1', {
      status: 'suspended', expectedVersion: 1, updatedBy: 'admin', updateReason: 'test',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_VERSION_CONFLICT' });

    const revoked = await store.updateStatus('cred-1', {
      status: 'revoked', expectedVersion: 2, updatedBy: 'admin', updateReason: 'test',
    });
    expect(revoked).toMatchObject({ status: 'revoked', generation: 2, version: 3 });
    await expect(store.updateStatus('cred-1', {
      status: 'revoked', expectedVersion: 3, updatedBy: 'admin', updateReason: 'test',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED_NO_REUSE' });

    state.credentialRows[0] = { ...credentialRow(), status: 'suspended' };
    await expect(store.updateStatus('cred-1', {
      status: 'suspended', expectedVersion: 1, updatedBy: 'admin', updateReason: 'test',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_ALREADY_SUSPENDED' });

    state.credentialRows = [];
    await expect(store.updateStatus('cred-x', {
      status: 'revoked', expectedVersion: 1, updatedBy: 'admin', updateReason: 'test',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_FOUND' });
  });

  it('legacy 回填：userId 优先；username 同租户唯一命中才投影；未命中/多命中记 issue 不猜', async () => {
    const { pool, state } = buildPool();
    const store = new PgCredentialStore({ pool, tablePrefix: 'test' });
    const users = [
      { id: 'user-1', username: 'alice', tenantId: 'acme' },
      { id: 'user-2', username: 'bob', tenantId: 'acme' },
      { id: 'user-3', username: 'bob', tenantId: 'acme' },
      { id: 'user-4', username: 'charlie', tenantId: 'acme' },
    ];
    const result = await store.backfillLegacyCredentials({
      users,
      platformTenantId: 'pantheon',
      projectedBy: 'system:governance-m1',
      connections: [
        {
          connectorId: 'github', username: 'alice', userId: 'user-1', tenantId: 'acme',
          status: 'connected', credentialRefs: { token: 'ref-alice' },
        },
        {
          connectorId: 'mcp', username: 'bob', tenantId: 'acme',
          status: 'connected', credentialRefs: { token: 'ref-bob' },
        },
        {
          connectorId: 'mcp', username: 'ghost', tenantId: 'acme',
          status: 'connected', credentialRefs: { token: 'ref-ghost' },
        },
        {
          connectorId: 'internal-mcp', username: 'charlie', tenantId: 'acme',
          status: 'connected', credentialRefs: { token: 'ref-charlie' }, capabilities: { mcp: true },
        },
        {
          connectorId: 'root-connector', username: 'root', userId: 'root-1', tenantId: 'pantheon',
          status: 'connected', credentialRefs: { token: 'ref-root' },
        },
        {
          connectorId: 'notion', username: 'alice', tenantId: 'acme',
          status: 'disconnected', credentialRefs: {},
        },
      ],
    });
    expect(result.credentialsProjected).toBe(2);
    expect(result.issuesRecorded).toBe(3);
    const issueTypes = state.issueRows.map(issue => issue.issue_type).sort();
    expect(issueTypes).toEqual([
      'credential_owner_ambiguous',
      'credential_owner_unresolved',
      'platform_tenant_credential_forbidden',
    ]);
    const alice = state.credentialRows.find(row => row.secret_ref === 'ref-alice');
    expect(alice).toMatchObject({ owner_user_id: 'user-1', owner_username: null, kind: 'personal_grant' });
    const charlie = state.credentialRows.find(row => row.secret_ref === 'ref-charlie');
    expect(charlie).toMatchObject({
      owner_user_id: 'user-4',
      owner_username: 'charlie',
      kind: 'personal_grant',
      scope_summary_json: { legacyCapability: 'mcp' },
    });
    expect(state.credentialRows.some(row => row.secret_ref === 'ref-root')).toBe(false);
  });

  it('listForOwner 只按 tenant+owner 过滤', async () => {
    const { pool, state } = buildPool();
    const store = new PgCredentialStore({ pool, tablePrefix: 'test' });
    state.credentialRows.push(credentialRow());
    const list = await store.listForOwner('acme', 'user-1');
    expect(list).toHaveLength(1);
    expect(list[0].ownerUserId).toBe('user-1');
  });

  it('错误类型携带稳定 code', () => {
    expect(new CredentialInvariantError('CREDENTIAL_NOT_FOUND')).toMatchObject({
      code: 'CREDENTIAL_NOT_FOUND',
      name: 'CredentialInvariantError',
    });
  });
});
