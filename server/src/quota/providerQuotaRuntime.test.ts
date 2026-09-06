import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { CodexCredentialManager } from '../runtime/responses/codexCredentialManager.js';
import { createProviderQuotaRuntime } from './providerQuotaRuntime.js';

class FakePool {
  rows: Array<{ snapshot: unknown }> = [];

  async connect(): Promise<pg.PoolClient> {
    return {
      query: async () => ({ rows: [] }),
      release: () => undefined,
    } as unknown as pg.PoolClient;
  }

  async query(sql: string, params: unknown[] = []) {
    if (sql.includes('INSERT INTO')) {
      this.rows.push({ snapshot: JSON.parse(String(params[4])) });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe('createProviderQuotaRuntime', () => {
  it('把运行时 egress fetch 传给 Codex 套餐额度采集', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            email: 'quota@example.com',
            plan_type: 'pro',
            rate_limit: {
              limit_reached: false,
              primary_window: { used_percent: 42, limit_window_seconds: 604800 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const manager = {
      getConfiguration: () => ({ enabled: true }),
      getCredentialRefs: () => ['credential-1'],
      getStatuses: async () => [],
      getCredentialsForCredential: async () => ({
        accessToken: 'token',
        accountId: 'account-1',
      }),
    } as unknown as CodexCredentialManager;
    const pool = new FakePool();
    const runtime = await createProviderQuotaRuntime({
      pool: pool as unknown as pg.Pool,
      getModelsConfig: () => undefined,
      codexCredentialManager: manager,
      enableCollector: false,
      fetchImpl,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const snapshots = await runtime.service.refresh();

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(snapshots).toEqual([
      expect.objectContaining({ accountKey: 'codex:credential-1', ok: true }),
    ]);
    runtime.stop();
  });
});
