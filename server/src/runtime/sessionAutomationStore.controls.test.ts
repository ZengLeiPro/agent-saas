import { describe, expect, it, vi } from 'vitest';
import type { SessionAutomationSnapshot } from '@agent/shared';
import { PgSessionAutomationStore } from './sessionAutomationStore.js';

const identity = { tenantId: 'tenant-1', ownerUserId: 'user-1', sessionId: 'session-1' };

function snapshot(status: SessionAutomationSnapshot['status']): SessionAutomationSnapshot {
  return {
    automationId: '00000000-0000-4000-8000-000000000001',
    incarnationId: '00000000-0000-4000-8000-000000000002',
    ...identity,
    status,
    phase: ['completed', 'cancelled', 'failed', 'expired'].includes(status) ? 'terminal' : 'idle',
    generation: 1,
    specVersion: 1,
    controlVersion: 1,
    projectionVersion: 1,
    spec: { kind: 'loop', mode: 'adaptive', prompt: 'work', budget: {} },
    runCount: 0,
    noProgressCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('PgSessionAutomationStore explicit control state matrix', () => {
  const terminalStatuses = ['completed', 'cancelled', 'failed', 'expired'] as const;
  const publicControls = ['pause', 'resume', 'run', 'clear'] as const;

  it.each(terminalStatuses.flatMap(status => publicControls.map(action => [status, action] as const)))(
    'keeps terminal status %s monotonic when %s is requested',
    async (status, action) => {
      const query = vi.fn();
      const store = new PgSessionAutomationStore({} as never);
      await expect(store.control({ query } as never, snapshot(status), action))
        .rejects.toMatchObject({ code: 'CONFLICT', current: expect.objectContaining({ status }) });
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(terminalStatuses)('does not let edit/replace revive terminal status %s', async status => {
    const query = vi.fn();
    const store = new PgSessionAutomationStore({} as never);
    await expect(store.replace({ query } as never, snapshot(status), snapshot(status).spec))
      .rejects.toMatchObject({ code: 'CONFLICT', current: expect.objectContaining({ status }) });
    expect(query).not.toHaveBeenCalled();
  });
  it('atomically activates paused run-now and enqueues an immediate wakeup', async () => {
    const current = snapshot('paused');
    const row = {
      automation_id: current.automationId, incarnation_id: current.incarnationId,
      tenant_id: current.tenantId, session_id: current.sessionId, owner_user_id: current.ownerUserId,
      status: 'active', phase: 'waiting', generation: 2, spec_version: 1,
      control_version: 2, projection_version: 2, spec: current.spec,
      next_wakeup_at: null, active_run_id: null, run_count: 0, no_progress_count: 0,
      last_error: null, created_at: current.createdAt, updated_at: current.updatedAt,
    };
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return sql.includes('SELECT a.*,s.spec') ? { rows: [row] } : { rows: [] };
    });
    const store = new PgSessionAutomationStore({} as never);

    const result = await store.control({ query } as never, current, 'run');

    expect(result).toMatchObject({ status: 'active', generation: 2 });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ sql: expect.stringContaining('SET status=$3'), params: expect.arrayContaining(['active', 2]) }),
      expect.objectContaining({ sql: expect.stringContaining(`INSERT INTO ${store.tables.wakeups}`) }),
    ]));
  });
});

describe('PgSessionAutomationStore command receipt session scope', () => {
  it('uses session_id in the receipt lookup key', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const store = new PgSessionAutomationStore({} as never);

    await expect(store.findCommand({ query } as never, identity, 'same-message', 'digest'))
      .resolves.toBeUndefined();

    expect(query).toHaveBeenNthCalledWith(2,
      expect.stringContaining('session_id=$4'),
      [identity.tenantId, identity.ownerUserId, 'same-message', identity.sessionId],
    );
  });

  it('rejects an owner/clientMessageId collision already bound to another session', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ session_id: 'session-2' }] });
    const store = new PgSessionAutomationStore({} as never);

    await expect(store.findCommand({ query } as never, identity, 'same-message', 'digest'))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects a mismatched receipt session even if a storage adapter returns it', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        tenant_id: identity.tenantId,
        owner_user_id: identity.ownerUserId,
        client_message_id: 'same-message',
        session_id: 'session-2',
        command_digest: 'digest',
        canonical_request: {},
        state: 'committed',
        response: { result: 'status' },
        response_cursor: null,
        session_meta_created: false,
      }] });
    const store = new PgSessionAutomationStore({} as never);

    await expect(store.findCommand({ query } as never, identity, 'same-message', 'digest'))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
