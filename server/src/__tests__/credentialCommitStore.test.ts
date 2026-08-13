import { describe, expect, it } from 'vitest';

import { PgCredentialStore } from '../data/credentials/store.js';

interface CommitRow {
  tenant_id: string;
  operation: string;
  idempotency_key: string;
  nonce_digest: string;
  request_digest: string;
  target_id: string;
  actor_user_id: string;
  status: string;
  credential_id?: string;
  error_code?: string;
  manual_action_json?: Record<string, unknown>;
  updated_at: string;
}

function poolRig() {
  const rows: CommitRow[] = [];
  const queries: string[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      if (sql.includes('INSERT INTO test_credential_commits')) {
        const duplicate = rows.some(row => (
          row.tenant_id === params[0] && row.operation === params[1]
          && (row.idempotency_key === params[2] || row.nonce_digest === params[3])
        ));
        if (duplicate) return { rows: [] };
        rows.push({
          tenant_id: String(params[0]), operation: String(params[1]), idempotency_key: String(params[2]),
          nonce_digest: String(params[3]), request_digest: String(params[4]), target_id: String(params[5]),
          actor_user_id: String(params[6]), status: 'running',
          manual_action_json: JSON.parse(String(params[7])) as Record<string, unknown>,
          updated_at: new Date().toISOString(),
        });
        return { rows: [{ status: 'running' }] };
      }
      if (sql.includes('SELECT * FROM test_credential_commits')) {
        return { rows: rows.filter(row => row.tenant_id === params[0] && row.operation === params[1]
          && (row.idempotency_key === params[2] || row.nonce_digest === params[3])) };
      }
      if (sql.includes("jsonb_build_object('leaseToken'")) {
        const row = rows.find(item => item.tenant_id === params[0] && item.operation === params[1] && item.idempotency_key === params[2] && item.status === 'running');
        if (!row || Date.now() - Date.parse(row.updated_at) < 30_000) return { rows: [] };
        row.manual_action_json = { ...row.manual_action_json, leaseToken: String(params[3]) };
        row.updated_at = new Date().toISOString();
        return { rows: [{ manual_action_json: row.manual_action_json }] };
      }
      if (sql.includes('|| $5::jsonb')) {
        const row = rows.find(item => item.tenant_id === params[0] && item.operation === params[1] && item.idempotency_key === params[2] && item.status === 'running' && item.manual_action_json?.leaseToken === params[3]);
        if (!row) return { rows: [] };
        row.manual_action_json = { ...row.manual_action_json, ...JSON.parse(String(params[4])) as Record<string, unknown> };
        row.updated_at = new Date().toISOString();
        return { rows: [{ idempotency_key: row.idempotency_key }] };
      }
      if (sql.includes('SET status=$5')) {
        const row = rows.find(item => item.tenant_id === params[0] && item.operation === params[1] && item.idempotency_key === params[2] && item.status === 'running' && item.manual_action_json?.leaseToken === params[3]);
        if (!row) return { rows: [] };
        row.status = String(params[4]);
        if (params[5]) row.credential_id = String(params[5]);
        if (params[6]) row.error_code = String(params[6]);
        row.manual_action_json = JSON.parse(String(params[7])) as Record<string, unknown>;
        row.updated_at = new Date().toISOString();
        return { rows: [{ idempotency_key: row.idempotency_key }] };
      }
      return { rows: [] };
    },
  };
  return { pool: pool as never, rows, queries };
}

const claim = (tenantId = 'tenant-a', overrides: Record<string, string> = {}) => ({
  tenantId, operation: 'create' as const, idempotencyKey: 'idem-create-1', nonceDigest: 'nonce-a',
  requestDigest: 'request-a', targetId: 'credential-create:github:admin-1', actorUserId: 'admin-1',
  ...overrides,
});

describe('credential commit persistence', () => {
  it('existing-only claim 不创建新 ledger，并拒绝同租户 nonce 指向另一 idempotency key', async () => {
    const { pool, rows } = poolRig();
    const store = new PgCredentialStore({ pool, tablePrefix: 'test' });

    await expect(store.claimCommit({ ...claim(), existingOnly: true })).resolves.toEqual({ state: 'missing' });
    expect(rows).toHaveLength(0);
    await store.claimCommit(claim());
    await expect(store.claimCommit({
      ...claim(), idempotencyKey: 'idem-create-other', existingOnly: true,
    })).resolves.toEqual({ state: 'conflict' });
    await expect(store.claimCommit({
      ...claim(), requestDigest: 'request-tampered', existingOnly: true,
    })).resolves.toEqual({ state: 'conflict' });
    expect(rows).toHaveLength(1);
  });

  it('同租户 commit 以唯一 idempotencyKey/nonce 原子占位并拒绝并发与重放', async () => {
    const { pool, rows } = poolRig();
    const store = new PgCredentialStore({ pool, tablePrefix: 'test' });

    const [first, concurrent] = await Promise.all([store.claimCommit(claim()), store.claimCommit(claim())]);
    expect([first.state, concurrent.state].sort()).toEqual(['acquired', 'in_progress']);
    expect(rows).toHaveLength(1);
    if (first.state !== 'acquired') throw new Error('expected first claimant to acquire lease');

    await store.finishCommit({
      tenantId: 'tenant-a', operation: 'create', idempotencyKey: 'idem-create-1',
      leaseToken: first.leaseToken, status: 'succeeded', credentialId: 'cred-1',
    });
    await expect(store.claimCommit(claim())).resolves.toEqual({ state: 'replayed', credentialId: 'cred-1' });
    expect(rows).toHaveLength(1);
  });

  it('idempotencyKey 换请求或 nonce 换 key 均冲突；相同 key 可被另一租户独立使用', async () => {
    const { pool, rows } = poolRig();
    const store = new PgCredentialStore({ pool, tablePrefix: 'test' });
    await expect(store.claimCommit(claim())).resolves.toMatchObject({ state: 'acquired', leaseToken: expect.any(String) });
    await expect(store.claimCommit(claim('tenant-a', { requestDigest: 'request-b' }))).resolves.toEqual({ state: 'conflict' });
    await expect(store.claimCommit(claim('tenant-a', { idempotencyKey: 'idem-create-2' }))).resolves.toEqual({ state: 'conflict' });
    await expect(store.claimCommit(claim('tenant-b'))).resolves.toMatchObject({ state: 'acquired', leaseToken: expect.any(String) });
    expect(rows).toHaveLength(2);
  });

  it('过期 running lease 可被同租户同请求安全接管，旧 lease 被 fencing', async () => {
    const { pool, rows } = poolRig();
    const store = new PgCredentialStore({ pool, tablePrefix: 'test' });
    const acquired = await store.claimCommit(claim());
    if (acquired.state !== 'acquired') throw new Error('expected commit lease');
    await store.recordCommitProgress({
      tenantId: 'tenant-a', operation: 'create', idempotencyKey: 'idem-create-1',
      leaseToken: acquired.leaseToken,
      progress: { phase: 'vault_written', secretRef: 'vault-ref-internal' },
    });
    rows[0]!.updated_at = new Date(Date.now() - 31_000).toISOString();

    const takeover = await store.claimCommit({ ...claim(), existingOnly: true });
    expect(takeover).toMatchObject({
      state: 'reconcile', leaseToken: expect.any(String),
      recovery: { phase: 'vault_written', secretRef: 'vault-ref-internal' },
    });
    if (takeover.state !== 'reconcile') throw new Error('expected stale lease takeover');
    expect(takeover.leaseToken).not.toBe(acquired.leaseToken);
    await expect(store.finishCommit({
      tenantId: 'tenant-a', operation: 'create', idempotencyKey: 'idem-create-1',
      leaseToken: acquired.leaseToken, status: 'failed',
    })).rejects.toThrow('CREDENTIAL_COMMIT_LEASE_LOST');
    await expect(store.finishCommit({
      tenantId: 'tenant-a', operation: 'create', idempotencyKey: 'idem-create-1',
      leaseToken: takeover.leaseToken, status: 'failed',
    })).resolves.toBeUndefined();
  });

  it('compensation_failed 持久化终态和仅供人工处理的内部线索', async () => {
    const { pool, rows } = poolRig();
    const store = new PgCredentialStore({ pool, tablePrefix: 'test' });
    const acquired = await store.claimCommit(claim());
    if (acquired.state !== 'acquired') throw new Error('expected commit lease');
    await store.finishCommit({
      tenantId: 'tenant-a', operation: 'create', idempotencyKey: 'idem-create-1',
      leaseToken: acquired.leaseToken,
      status: 'compensation_failed', errorCode: 'CREDENTIAL_CREATE_COMPENSATION_FAILED',
      manualAction: { action: 'revoke_orphaned_secret', secretRef: 'vault-ref-internal' },
    });
    expect(rows[0]).toMatchObject({
      status: 'compensation_failed', error_code: 'CREDENTIAL_CREATE_COMPENSATION_FAILED',
      manual_action_json: { action: 'revoke_orphaned_secret', secretRef: 'vault-ref-internal' },
    });
    await expect(store.claimCommit(claim())).resolves.toEqual({ state: 'terminal', status: 'compensation_failed' });
  });
});
