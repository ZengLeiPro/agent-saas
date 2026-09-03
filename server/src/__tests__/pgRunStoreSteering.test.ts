import { describe, expect, it, vi } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';

describe('PgRunStore steering inbox', () => {
  it('lists chat queue records only through the accepted message ledger', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [] };
    }) };
    const store = new PgRunStore({ pool: pool as any });

    await store.listUserMessagesBySession('session-queue');

    const { sql, params } = queries[0]!;
    expect(sql).toContain('FROM runtime_message_submissions submission');
    expect(sql).toContain('JOIN runtime_runs run ON run.run_id = submission.run_id');
    expect(sql).toContain('WHERE submission.session_id = $1');
    expect(sql).not.toContain('run.idempotency_key IS NOT NULL');
    expect(params).toEqual(['session-queue']);
  });

  it('atomically links a new source run to the open run in the same session', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const now = new Date().toISOString();
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql: sql.trim(), params });
        if (sql.includes('INSERT INTO runtime_message_submissions')) {
          return { rows: [{ run_id: String(params[3]) }] };
        }
        if (sql.includes('SELECT target.run_id')) {
          return { rows: [{ run_id: 'target-run' }] };
        }
        if (sql.includes('INSERT INTO runtime_runs')) {
          const metadata = JSON.parse(String(params[params.length - 1]));
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
    expect(steeringInsert?.params.slice(0, 4)).toEqual(['source-run', 'tenant-1', 'target-run', 'session-1']);
  });

  it('rejects a chat accepted before the latest session stop', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push(sql.trim());
        if (sql.includes('INSERT INTO runtime_message_submissions')) return { rows: [{ run_id: String(params[3]) }] };
        if (sql.includes('SELECT stopped_at')) {
          return { rows: [{ stopped_at: '2026-08-06T04:00:01.000Z' }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.enqueueSteeringAware({
      runId: 'late-source',
      sessionId: 'session-stop-race',
      metadata: { steeringAcceptedAt: '2026-08-06T04:00:00.000Z' },
    })).rejects.toThrow('accepted before the latest session stop');
    expect(queries.some((sql) => sql.includes('INSERT INTO runtime_runs'))).toBe(false);
    expect(queries.at(-1)).toBe('ROLLBACK');
  });

  it('creates a normal pending run when no open steering target exists', async () => {
    const queries: string[] = [];
    const now = new Date().toISOString();
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push(sql.trim());
        if (sql.includes('INSERT INTO runtime_message_submissions')) return { rows: [{ run_id: String(params[3]) }] };
        if (sql.includes('SELECT target.run_id')) return { rows: [] };
        if (sql.includes('INSERT INTO runtime_runs')) {
          return { rows: [{ row_json: {
            run_id: 'normal-run',
            session_id: 'session-1',
            status: 'pending',
            requested_at: now,
            updated_at: now,
            metadata: JSON.parse(String(params[params.length - 1])),
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

  it('keeps ordinary messages as durable queue entries instead of steering into the active run', async () => {
    const queries: string[] = [];
    const now = new Date().toISOString();
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push(sql.trim());
        if (sql.includes('INSERT INTO runtime_message_submissions')) return { rows: [{ run_id: 'queued-run' }] };
        if (sql.includes('SELECT candidate.run_id')) return { rows: [{ run_id: 'active-run' }] };
        if (sql.includes('INSERT INTO runtime_runs')) {
          return { rows: [{ row_json: {
            run_id: 'queued-run', session_id: 'session-1', status: 'pending',
            requested_at: now, updated_at: now, metadata: JSON.parse(String(params[params.length - 1])),
          } }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    const record = await store.enqueueUserMessage({
      runId: 'queued-run',
      sessionId: 'session-1',
      userId: 'user-1',
      idempotencyKey: 'client-queued-1',
      channel: 'web',
      metadata: { wakeMessage: { channel: 'web', chatId: 'session-1', content: '下一项任务' } },
    }, 'queue');

    expect(record.metadata).toMatchObject({ deliveryMode: 'queue', queuedBehindRunId: 'active-run' });
    expect(queries.some((sql) => sql.includes('INSERT INTO runtime_steering_inputs'))).toBe(false);
  });

  it('returns the same-tenant authority when clientMessageId is submitted concurrently', async () => {
    const now = new Date().toISOString();
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('INSERT INTO runtime_message_submissions')) return { rows: [] };
        if (sql.includes('COALESCE(submission.tenant_id')) {
          return { rows: [{ run_id: 'original-run', owner_tenant_id: 'pantheon' }] };
        }
        if (sql.includes('SELECT row_to_json(runtime_runs.*)')) {
          return { rows: [{ row_json: {
            run_id: 'original-run', session_id: 'session-1', status: 'completed',
            requested_at: now, updated_at: now, idempotency_key: 'client-1', metadata: { deliveryMode: 'queue' },
          } }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.enqueueUserMessage({
      runId: 'duplicate-run', sessionId: 'session-1', userId: 'user-1', idempotencyKey: 'client-1',
    }, 'queue')).resolves.toMatchObject({ runId: 'original-run', status: 'completed' });
    expect(queries.some((sql) => sql.includes('INSERT INTO runtime_runs'))).toBe(false);
  });

  it('reserves ownership before durable append and supports idempotent recovery', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql: sql.trim(), params });
        if (sql.includes('SELECT status, metadata')) {
          return { rows: [{ status: 'running', metadata: { steeringInputWindow: 'open' } }] };
        }
        if (sql.includes('SELECT run_id, status')) {
          return { rows: [{ run_id: 'source-run', status: 'pending' }] };
        }
        if (sql.includes("SET state = 'reserved'")) {
          return { rows: [{ source_run_id: 'source-run' }] };
        }
        if (sql.includes("AND state = 'reserved'")) {
          return { rows: [{ source_run_id: 'source-run' }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.reserveSteeringInputs('target-run', ['source-run']))
      .resolves.toEqual(['source-run']);
    const reserveQuery = queries.find(({ sql }) => sql.includes("SET state = 'reserved'"));
    expect(reserveQuery?.sql).toContain("AND state = 'pending'");
    expect(reserveQuery?.sql).toContain('$5::timestamptz');
    expect(reserveQuery?.sql).toContain('tenant_id = $1 AND session_id = $2');
    expect(queries.at(-1)?.sql).toBe('COMMIT');
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
    const inboxUpdate = queries.find((sql) => sql.includes('UPDATE runtime_steering_inputs'));
    const sourceUpdate = queries.find((sql) => sql.includes("status = 'completed'"));
    expect(inboxUpdate).toContain("state = 'reserved'");
    expect(inboxUpdate).toContain('$3::timestamptz');
    expect(sourceUpdate).toContain("'steeringAppliedAt', $4::text");
    expect(sourceUpdate).toContain("- 'wakeMessage'");
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

  it('claims the still-pending subset when one source is no longer pending (best-effort, 2026-08-04)', async () => {
    // 旧行为是 all-or-nothing：任一 source 在 drain→claim 窗口被撤回，整批返回空，
    // loop 随即抛错把健康的目标 run 打成 failed（BUG-3）。新语义：只 claim 仍
    // pending 的子集，被撤回的条目由调用方跳过。
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
        if (sql.includes('UPDATE runtime_steering_inputs')) {
          return { rows: [{ source_run_id: 'source-1' }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.markSteeringInputsApplied('target-run', ['source-1', 'source-2']))
      .resolves.toEqual(['source-1']);
    const claimSql = queries.find((sql) => sql.includes('UPDATE runtime_steering_inputs'));
    expect(claimSql).toBeTruthy();
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
      query: vi.fn(async () => ({ rows: [{ session_id: 'session-1', tenant_id: 'tenant-1' }] })),
      connect: vi.fn(async () => client),
    };
    const store = new PgRunStore({ pool: pool as any });

    await expect(store.trySealSteeringInputWindow('target-run')).resolves.toBe(false);
    expect(clientQueries.some((sql) => sql.includes("'steeringInputWindow', 'sealed'"))).toBe(false);
    expect(clientQueries.at(-1)).toBe('COMMIT');
  });

  it('excludes waiting_user / waiting_approval from steering target candidates (2026-08-04 BUG-1)', async () => {
    // waiting_user 没有 loop 在跑也没有超时 janitor，插话挂上去会永久静默丢失；
    // waiting_approval 只有 24h janitor（BUG-7）。两者都必须从候选目标移除，
    // 此时插话应作为独立 run 直接执行。
    const queries: string[] = [];
    const now = new Date().toISOString();
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push(sql.trim());
        if (sql.includes('INSERT INTO runtime_message_submissions')) return { rows: [{ run_id: String(params[3]) }] };
        if (sql.includes('SELECT target.run_id')) return { rows: [] };
        if (sql.includes('INSERT INTO runtime_runs')) {
          return { rows: [{ row_json: {
            run_id: 'run-1', session_id: 'session-1', status: 'pending',
            requested_at: now, updated_at: now, metadata: JSON.parse(String(params[params.length - 1])),
          } }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });
    await store.enqueueSteeringAware({ runId: 'run-1', sessionId: 'session-1' });

    const targetQuery = queries.find((sql) => sql.includes('SELECT target.run_id'));
    expect(targetQuery).toBeTruthy();
    expect(targetQuery).toContain(`('pending','running','waiting_hand')`);
    expect(targetQuery).not.toContain('waiting_user');
    expect(targetQuery).not.toContain('waiting_approval');
  });

  it('does not label a normal queue message behind waiting_user / waiting_approval', async () => {
    const queries: string[] = [];
    const now = new Date().toISOString();
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push(sql.trim());
        if (sql.includes('INSERT INTO runtime_message_submissions')) return { rows: [{ run_id: String(params[3]) }] };
        if (sql.includes('SELECT candidate.run_id')) return { rows: [] };
        if (sql.includes('INSERT INTO runtime_runs')) {
          return { rows: [{ row_json: {
            run_id: 'queue-run', session_id: 'session-queue', status: 'pending',
            requested_at: now, updated_at: now, metadata: JSON.parse(String(params[params.length - 1])),
          } }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    const run = await store.enqueueUserMessage({
      runId: 'queue-run',
      sessionId: 'session-queue',
      userId: 'user-1',
      idempotencyKey: 'queue-client',
    }, 'queue');

    const blockerQuery = queries.find((sql) => sql.includes('SELECT candidate.run_id'));
    expect(blockerQuery).toContain("candidate.status IN ('pending','running','waiting_hand')");
    expect(blockerQuery).not.toContain('waiting_user');
    expect(blockerQuery).not.toContain('waiting_approval');
    expect(run.metadata?.queuedBehindRunId).toBeUndefined();
  });

  it('recovers non-subagent pending and reserved sources after their steering target becomes terminal', async () => {
    // pending/reserved 都只在目标仍活跃时阻止 source recovery；目标失败后 source
    // 回到可恢复集合，并用 durable user_message 作为独立 run 执行。
    const pool = {
      query: vi.fn(async (sql: string) => {
        expect(sql.match(/AND target\.status IN \('pending','running','waiting_hand'\)/g)).toHaveLength(1);
        expect(sql).toMatch(/input\.state = 'reserved'\s+AND target\.status NOT IN \('completed','failed','cancelled','orphaned'\)/);
        expect(sql).not.toContain(`'waiting_user','waiting_hand'`);
        expect(sql).toContain("COALESCE(run.metadata->>'schedulerState', '') = 'staged'");
        expect(sql).toContain("run.metadata->>'subagent' IS DISTINCT FROM 'true'");
        return { rows: [] };
      }),
    };
    const store = new PgRunStore({ pool: pool as any });
    await store.listRecoverable();
    expect(pool.query).toHaveBeenCalled();
  });

  it('acquires a tenant-scoped lease for a reserved source after its steering target becomes terminal', async () => {
    const now = new Date().toISOString();
    let leaseUpdateSql = '';
    const client = {
      query: async (sql: string) => {
        const normalizedSql = sql.trim();
        if (normalizedSql.includes('SELECT tenant_id, session_id FROM runtime_runs')) {
          return { rows: [{ tenant_id: 'tenant-1', session_id: 'session-reserved-terminal' }] };
        }
        if (normalizedSql.includes('UPDATE runtime_runs candidate')) {
          leaseUpdateSql = normalizedSql;
          const reservedOnlyBlocksLiveTarget = /input\.state = 'reserved'\s+AND target\.status NOT IN \('completed','failed','cancelled','orphaned'\)/.test(normalizedSql);
          return reservedOnlyBlocksLiveTarget
            ? { rows: [{ row_json: {
                run_id: 'source-reserved-terminal',
                session_id: 'session-reserved-terminal',
                status: 'running',
                worker_id: 'worker-reserved-terminal',
                requested_at: now,
                updated_at: now,
              } }] }
            : { rows: [] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.acquireLease('source-reserved-terminal', 'worker-reserved-terminal', 60_000))
      .resolves.toMatchObject({
        runId: 'source-reserved-terminal',
        status: 'running',
        workerId: 'worker-reserved-terminal',
      });
    expect(leaseUpdateSql).toMatch(
      /input\.state = 'reserved'\s+AND target\.status NOT IN \('completed','failed','cancelled','orphaned'\)/,
    );
    expect(leaseUpdateSql).toContain(
      "COALESCE(candidate.metadata->>'schedulerState', '') = 'staged'",
    );
  });

  it('cancels a pending steering source and rejects late withdrawal (2026-08-04 终态设计)', async () => {
    // pending：撤回成功，input 行与 source run 都标 cancelled
    const okQueries: string[] = [];
    const okClient = {
      query: async (sql: string) => {
        okQueries.push(sql.trim());
        if (sql.includes('SELECT status, session_id, metadata')) {
          return { rows: [{ status: 'pending', session_id: 'session-1', metadata: { steeringState: 'pending', clientMsgId: 'c1' } }] };
        }
        if (sql.includes('UPDATE runtime_steering_inputs')) return { rowCount: 1, rows: [] };
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const okStore = new PgRunStore({ pool: { connect: async () => okClient } as any });
    await expect(okStore.cancelPendingSteeringSourceRun('source-run'))
      .resolves.toEqual({ ok: true, sessionId: 'session-1', clientMsgId: 'c1' });
    expect(okQueries.some((sql) => sql.includes("state = 'cancelled'"))).toBe(true);
    expect(okQueries.find((sql) => sql.includes("status = 'cancelled'"))).toContain("- 'wakeMessage'");
    expect(okQueries.at(-1)).toBe('COMMIT');

    // 已被 claim（input 行不再 pending）：too_late，绝不动 run 状态
    const lateQueries: string[] = [];
    const lateClient = {
      query: async (sql: string) => {
        lateQueries.push(sql.trim());
        if (sql.includes('SELECT status, session_id, metadata')) {
          return { rows: [{ status: 'pending', session_id: 'session-1', metadata: { steeringState: 'pending' } }] };
        }
        if (sql.includes('UPDATE runtime_steering_inputs')) return { rowCount: 0, rows: [] };
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const lateStore = new PgRunStore({ pool: { connect: async () => lateClient } as any });
    await expect(lateStore.cancelPendingSteeringSourceRun('source-run'))
      .resolves.toEqual({ ok: false, reason: 'too_late', sessionId: 'session-1' });
    expect(lateQueries.some((sql) => sql.includes("status = 'cancelled'"))).toBe(false);
    expect(lateQueries.at(-1)).toBe('ROLLBACK');
  });

  it('atomically cancels pending and reserved inputs for stop-all', async () => {
    const now = new Date().toISOString();
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('FOR UPDATE OF input, source')) {
          return { rows: [{
            input_id: 'input-reserved',
            source_run_id: 'source-reserved',
            target_run_id: 'target-run',
            session_id: 'session-1',
            state: 'reserved',
            accepted_at: now,
            reserved_at: now,
            applied_at: null,
            row_json: {
              run_id: 'source-reserved', session_id: 'session-1', status: 'pending',
              requested_at: now, updated_at: now, metadata: { clientMsgId: 'c-reserved' },
            },
          }] };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.cancelSteeringBeforeDispatchBySession('session-1', 'aborted', 'target-run'))
      .resolves.toEqual([expect.objectContaining({ sourceRunId: 'source-reserved', state: 'reserved' })]);
    expect(queries.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    const targetLockIndex = queries.findIndex((sql) => (
      sql.includes('SELECT status')
      && sql.includes('WHERE tenant_id = $1 AND session_id = $2 AND run_id = $3')
      && sql.includes('FOR UPDATE')
    ));
    const steeringLockIndex = queries.findIndex((sql) => sql.includes('FOR UPDATE OF input, source'));
    expect(targetLockIndex).toBeGreaterThan(-1);
    expect(targetLockIndex).toBeLessThan(steeringLockIndex);
    expect(queries.filter((sql) => sql.includes("state IN ('pending', 'reserved')"))).toHaveLength(3);
    const sourceUpdate = queries.find((sql) => sql.includes('UPDATE runtime_runs') && sql.includes("'steeringState', 'released'"));
    const targetUpdate = queries.find((sql) => sql.includes("status = 'cancelled'"));
    expect(sourceUpdate).toContain("ELSE (metadata || jsonb_build_object('steeringState', 'cancelled')) - 'wakeMessage'");
    expect(targetUpdate).toContain("- 'wakeMessage'");
    expect(targetUpdate).toContain('tenant_id = $1');
    expect(queries.some((sql) => sql.includes('run_id = $3'))).toBe(true);
    expect(queries.at(-1)).toBe('COMMIT');
  });

  it('releases durable taskboard steering sources to standalone execution when stopping the target', async () => {
    const now = new Date().toISOString();
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('FOR UPDATE OF input, source')) {
          return { rows: [{
            input_id: 'input-taskboard',
            source_run_id: 'source-taskboard',
            target_run_id: 'target-run',
            session_id: 'session-1',
            state: 'pending',
            accepted_at: now,
            reserved_at: null,
            applied_at: null,
            row_json: {
              run_id: 'source-taskboard', session_id: 'session-1', status: 'pending',
              requested_at: now, updated_at: now,
              metadata: {
                taskboardContinuation: true,
                steeringTargetRunId: 'target-run',
                steeringState: 'pending',
                wakeMessage: { content: 'durable comment' },
              },
            },
          }] };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.cancelSteeringBeforeDispatchBySession('session-1', 'aborted', 'target-run'))
      .resolves.toEqual([]);

    expect(queries.some((sql) => sql.includes("THEN 'released' ELSE 'cancelled'"))).toBe(true);
    const sourceUpdate = queries.find((sql) => sql.includes("'steeringState', 'released'"));
    expect(sourceUpdate).toContain("THEN (metadata - 'steeringTargetRunId')");
    expect(sourceUpdate).toContain("ELSE (metadata || jsonb_build_object('steeringState', 'cancelled')) - 'wakeMessage'");
    expect(queries.filter((sql) => sql.includes("status = 'cancelled'"))).toHaveLength(1);
  });

  it('cancels reserved taskboard steering sources instead of releasing them as standalone runs', async () => {
    const now = new Date().toISOString();
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql: sql.trim(), params });
        if (sql.includes('FOR UPDATE OF input, source')) {
          return { rows: [{
            input_id: 'input-taskboard-reserved',
            source_run_id: 'source-taskboard-reserved',
            target_run_id: 'target-run',
            session_id: 'session-1',
            state: 'reserved',
            accepted_at: now,
            reserved_at: now,
            applied_at: null,
            row_json: {
              run_id: 'source-taskboard-reserved', session_id: 'session-1', status: 'pending',
              requested_at: now, updated_at: now,
              metadata: { taskboardContinuation: true, steeringState: 'pending' },
            },
          }] };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.cancelSteeringBeforeDispatchBySession('session-1', 'aborted', 'target-run'))
      .resolves.toEqual([]);

    const inputUpdate = queries.find(({ sql }) => sql.includes('UPDATE runtime_steering_inputs'));
    const sourceUpdate = queries.find(({ sql }) => sql.includes('UPDATE runtime_runs') && sql.includes("'steeringState', 'released'"));
    expect(inputUpdate?.params[2]).toEqual([]);
    expect(sourceUpdate?.params[3]).toEqual([]);
    expect(sourceUpdate?.sql).toContain("ELSE 'cancelled'");
    expect(sourceUpdate?.sql).toContain("'steeringState', 'cancelled'");
  });

  it('reports targetCancelled from the actual stop UPDATE and includes human waiting states', async () => {
    const queries: string[] = [];
    const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push(sql.trim());
        queryCalls.push({ sql: sql.trim(), params });
        if (sql.includes('UPDATE runtime_steering_sessions')) return { rows: [], rowCount: 1 };
        if (sql.includes("worker_id = NULL") && sql.includes("RETURNING run_id")) {
          return { rows: [{ run_id: 'waiting-run' }], rowCount: 1 };
        }
        if (sql.includes('UPDATE runtime_tool_invocations')) {
          return {
            rows: [{
              invocation_id: 'invocation-waiting',
              tool_call_id: 'tool-call-waiting',
              tool_name: 'Shell',
              metadata: { requestedBy: 'user-1' },
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('RETURNING next_sequence - $3 AS start_sequence')) {
          return { rows: [{ start_sequence: '1' }] };
        }
        return { rows: [], rowCount: 0 };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    const result = await store.cancelSteeringBeforeDispatchBySessionWithEvent(
      'session-waiting',
      'web_abort',
      'waiting-run',
      { type: 'run_cancel_requested', sessionId: 'session-waiting', runId: 'waiting-run', reason: 'web_abort' },
      'tenant-waiting',
    );

    expect(result.targetCancelled).toBe(true);
    const targetUpdate = queries.find((sql) => sql.includes('worker_id = NULL'));
    expect(targetUpdate).toContain("'waiting_user'");
    expect(targetUpdate).toContain("'waiting_approval'");
    expect(queries.findIndex((sql) => sql.includes('UPDATE runtime_tool_invocations')))
      .toBeLessThan(queries.findIndex((sql) => sql === 'COMMIT'));
    const eventLockIndex = queries.findIndex((sql, index) => sql.includes('pg_advisory_xact_lock')
      && queryCalls[index]?.params[0] === 'runtime_events:global-sequence-commit-order');
    const firstEventInsertIndex = queries.findIndex((sql) => sql.includes('INSERT INTO runtime_events'));
    expect(eventLockIndex).toBeGreaterThan(-1);
    expect(eventLockIndex).toBeLessThan(firstEventInsertIndex);
    expect(queryCalls[eventLockIndex]?.params).toEqual(['runtime_events:global-sequence-commit-order']);
    const cursorInsert = queryCalls.find(({ sql }) => sql.includes('INSERT INTO runtime_event_cursors'));
    expect(cursorInsert?.sql).toContain('ON CONFLICT (tenant_id, session_id)');
    expect(cursorInsert?.params).toEqual(['tenant-waiting', 'session-waiting', 3]);
    const insertedEventTypes = queryCalls
      .filter(({ sql }) => sql.includes('INSERT INTO runtime_events'))
      .map(({ params }) => params[3]);
    expect(insertedEventTypes).toEqual([
      'run_cancel_requested',
      'tool_invocation_cancel_requested',
      'run_state_changed',
    ]);
  });

  it('does not persist run/tool cancellation events when the target wins the race to a non-cancellable terminal state', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('UPDATE runtime_steering_sessions')) return { rows: [], rowCount: 1 };
        if (sql.includes("worker_id = NULL") && sql.includes("RETURNING run_id")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: vi.fn(),
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    const result = await store.cancelSteeringBeforeDispatchBySessionWithEvent(
      'session-terminal-race',
      'web_abort',
      'completed-run',
      { type: 'run_cancel_requested', sessionId: 'session-terminal-race', runId: 'completed-run', reason: 'web_abort' },
      'tenant-terminal-race',
    );

    expect(result).toMatchObject({ targetCancelled: false, eventCreated: false });
    expect(result.event).toBeUndefined();
    expect(queries.some((sql) => sql.includes('UPDATE runtime_tool_invocations'))).toBe(false);
    expect(queries.some((sql) => sql.includes('INSERT INTO runtime_events'))).toBe(false);
    expect(queries.at(-1)).toBe('COMMIT');
  });

  it('releases pending or reserved steering rows when the source run falls back to standalone execution', async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql.trim());
        return { rows: [] };
      }),
    };
    const store = new PgRunStore({ pool: pool as any });
    await store.releasePendingSteeringForSourceRun('source-run');
    expect(queries.some((sql) => sql.includes("SET state = 'released'"))).toBe(true);
    expect(queries.some((sql) => sql.includes("state IN ('pending', 'reserved')"))).toBe(true);
    expect(queries.some((sql) => sql.includes("'steeringState', 'released'"))).toBe(true);
  });
});
