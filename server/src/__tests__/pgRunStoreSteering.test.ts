import { describe, expect, it, vi } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';

describe('PgRunStore steering inbox', () => {
  it('atomically links a new source run to the open run in the same session', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const now = new Date().toISOString();
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql: sql.trim(), params });
        if (sql.includes('SELECT target.run_id')) {
          return { rows: [{ run_id: 'target-run' }] };
        }
        if (sql.includes('INSERT INTO runtime_runs')) {
          const metadata = JSON.parse(String(params[11]));
          return {
            rows: [{ row_json: {
              run_id: 'source-run',
              session_id: 'session-1',
              user_id: 'user-1',
              tenant_id: 'tenant-1',
              status: 'pending',
              model: 'gpt-5.5',
              channel: 'web',
              requested_at: now,
              updated_at: now,
              metadata,
            } }],
          };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    const record = await store.enqueueSteeringAware({
      runId: 'source-run',
      sessionId: 'session-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      model: 'gpt-5.5',
      channel: 'web',
      metadata: { clientMsgId: 'client-1', wakeMessage: { channel: 'web', chatId: 'session-1', content: '插话' } },
    });

    expect(record.metadata).toMatchObject({
      steeringTargetRunId: 'target-run',
      steeringState: 'pending',
    });
    expect(queries.map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      'BEGIN',
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('SELECT target.run_id'),
      expect.stringContaining('INSERT INTO runtime_runs'),
      expect.stringContaining('INSERT INTO runtime_steering_inputs'),
      'COMMIT',
    ]));
    const steeringInsert = queries.find(({ sql }) => sql.includes('INSERT INTO runtime_steering_inputs'));
    expect(steeringInsert?.params.slice(0, 3)).toEqual(['source-run', 'target-run', 'session-1']);
  });

  it('creates a normal pending run when no open steering target exists', async () => {
    const queries: string[] = [];
    const now = new Date().toISOString();
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push(sql.trim());
        if (sql.includes('SELECT target.run_id')) return { rows: [] };
        if (sql.includes('INSERT INTO runtime_runs')) {
          return { rows: [{ row_json: {
            run_id: 'normal-run',
            session_id: 'session-1',
            status: 'pending',
            requested_at: now,
            updated_at: now,
            metadata: JSON.parse(String(params[11])),
          } }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    const record = await store.enqueueSteeringAware({ runId: 'normal-run', sessionId: 'session-1' });

    expect(record.metadata?.steeringTargetRunId).toBeUndefined();
    expect(queries.some((sql) => sql.includes('INSERT INTO runtime_steering_inputs'))).toBe(false);
  });

  it('locks the target row and applies steering only while the target is active', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('SELECT status, metadata')) {
          return { rows: [{ status: 'running', metadata: { steeringInputWindow: 'open' } }] };
        }
        if (sql.includes('SELECT run_id, status')) {
          return { rows: [{ run_id: 'source-run', status: 'pending' }] };
        }
        if (sql.includes('UPDATE runtime_steering_inputs')) {
          return { rows: [{ source_run_id: 'source-run' }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.markSteeringInputsApplied('target-run', ['source-run']))
      .resolves.toEqual(['source-run']);
    expect(queries).toEqual(expect.arrayContaining([
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('UPDATE runtime_steering_inputs'),
      expect.stringContaining("status = 'completed'"),
      'COMMIT',
    ]));
  });

  it('does not absorb a source run cancelled before the model boundary claim', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('SELECT status, metadata')) {
          return { rows: [{ status: 'running', metadata: { steeringInputWindow: 'open' } }] };
        }
        if (sql.includes('SELECT run_id, status')) {
          return { rows: [{ run_id: 'source-run', status: 'cancelled' }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.markSteeringInputsApplied('target-run', ['source-run']))
      .resolves.toEqual([]);
    expect(queries.some((sql) => sql.includes('UPDATE runtime_steering_inputs'))).toBe(false);
    expect(queries.at(-1)).toBe('COMMIT');
  });

  it('claims a steering batch atomically when one source is no longer pending', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('SELECT status, metadata')) {
          return { rows: [{ status: 'running', metadata: { steeringInputWindow: 'open' } }] };
        }
        if (sql.includes('SELECT run_id, status')) {
          return {
            rows: [
              { run_id: 'source-1', status: 'pending' },
              { run_id: 'source-2', status: 'cancelled' },
            ],
          };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.markSteeringInputsApplied('target-run', ['source-1', 'source-2']))
      .resolves.toEqual([]);
    expect(queries.some((sql) => sql.includes('UPDATE runtime_steering_inputs'))).toBe(false);
    expect(queries.at(-1)).toBe('COMMIT');
  });

  it('keeps source runs pending when the target became terminal before claim', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('SELECT status, metadata')) {
          return { rows: [{ status: 'cancelled', metadata: { steeringInputWindow: 'open' } }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.markSteeringInputsApplied('target-run', ['source-run']))
      .resolves.toEqual([]);
    expect(queries.some((sql) => sql.includes('UPDATE runtime_steering_inputs'))).toBe(false);
    expect(queries.at(-1)).toBe('COMMIT');
  });

  it('does not seal the input window while a pending interjection is visible', async () => {
    const clientQueries: string[] = [];
    const client = {
      query: async (sql: string) => {
        clientQueries.push(sql.trim());
        if (sql.includes('SELECT 1') && sql.includes('steering_inputs')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [{ session_id: 'session-1' }] })),
      connect: vi.fn(async () => client),
    };
    const store = new PgRunStore({ pool: pool as any });

    await expect(store.trySealSteeringInputWindow('target-run')).resolves.toBe(false);
    expect(clientQueries.some((sql) => sql.includes("'steeringInputWindow', 'sealed'"))).toBe(false);
    expect(clientQueries.at(-1)).toBe('COMMIT');
  });
});
