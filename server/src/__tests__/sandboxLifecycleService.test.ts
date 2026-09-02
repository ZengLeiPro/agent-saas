import { describe, expect, it, vi } from 'vitest';

import {
  AcsSandboxLifecycleClient,
  PgSandboxLifecycleStore,
  SandboxLifecycleService,
  type SandboxLifecycleIdentity,
} from '../runtime/sandboxLifecycleService.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import { sandboxRunAdmissionFenceSql } from '../runtime/sandboxRunAdmissionFence.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';

const identity: SandboxLifecycleIdentity = {
  workspaceId: 'ws-1',
  sessionId: 'session-1',
  sandboxScopeId: 'scope-1',
};

function session(): RuntimeSessionRecord {
  return {
    sessionId: 'session-1', userId: 'u-1', username: 'alice', tenantId: 'tenant-1',
    channel: 'cron', cwd: '/data/workspaces/tenant-1/u-1', transcriptPath: '/tmp/session-1.jsonl',
    workspaceId: 'ws-1', sandboxWorkloadDescriptor: { kind: 'cron' },
    createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

function remote(id = 'agent-saas-acs', baseUrl = 'http://acs.test', mode: 'all' | 'drain' = 'all') {
  return { id, baseUrl, authToken: 'token', rollout: { mode } };
}

function cleanup(generation = 'generation-1') {
  return {
    ...identity,
    runId: 'run-cleanup', tenantId: 'tenant-1', userId: 'u-1', username: 'alice',
    targetHandId: 'agent-saas-acs', deletionGeneration: generation,
  };
}

describe('PgSandboxLifecycleStore terminal candidate contract', () => {
  it('delivered and legacy null-tenant cleanup fences admission until restore advances generation', async () => {
    const admissionSql = sandboxRunAdmissionFenceSql('runtime_runs').join('\n');
    expect(admissionSql).toContain("'prepared','cancelling','pending','claimed','delivered'");

    const query = vi.fn(async (sql: string) => {
      if (sql.includes('WITH cleanup_identity AS')) {
        return {
          rows: [{
            run_id: 'run-cleanup', tenant_id: 'tenant-1', user_id: 'u-1', username: 'alice',
            cleanup: {
              state: 'cancelled', workspaceId: 'ws-1', sessionId: 'session-1', sandboxScopeId: 'scope-1',
              tenantId: 'tenant-1', targetHandId: 'agent-saas-acs',
              previousDeletionGeneration: 'generation-delivered', deletionGeneration: 'generation-restored',
            },
          }],
        };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const store = new PgSandboxLifecycleStore({
      connect: async () => ({ query, release }),
    } as never, 'runtime_runs', 'runtime_steering_inputs');

    await expect(store.cancelCleanup('session-1', 'tenant-1', 'generation-restored')).resolves.toEqual([
      expect.objectContaining({
        runId: 'run-cleanup', previousDeletionGeneration: 'generation-delivered',
        deletionGeneration: 'generation-restored',
      }),
    ]);
    const cancelSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes('WITH cleanup_identity AS'));
    expect(cancelSql).toContain("IN ('prepared','cancelling','pending','claimed','delivered','cancelled')");
    expect(cancelSql).toContain("COALESCE(run.metadata->'sandboxCleanupOutbox'->>'sessionId', run.session_id)=$1");
    expect(cancelSql).toContain('run.tenant_id=$2 OR run.tenant_id IS NULL');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('ranks all terminal rows before delivered/due filtering and binds the fixed scan clock', async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
    const fixed = new Date('2026-09-01T00:00:00.000Z');
    const store = new PgSandboxLifecycleStore(
      { query } as never, 'runtime_runs', 'runtime_steering_inputs', () => fixed,
    );

    await expect(store.listTerminalCandidates()).resolves.toEqual([]);
    const [sql, params] = query.mock.calls[0] as unknown[];
    const text = String(sql);
    expect(text.indexOf('ROW_NUMBER() OVER')).toBeLessThan(text.indexOf("<> 'delivered'"));
    expect(text.indexOf('scope_rank = 1')).toBeLessThan(text.indexOf("<> 'deferred'"));
    expect(text).toContain('PARTITION BY tenant_id, workspace_id, sandbox_scope_id');
    expect(params).toEqual([100, fixed.toISOString()]);
  });
});

describe('AcsSandboxLifecycleClient exact-scope contract', () => {
  it('reads the activity fence and arms a deletion generation before mutating the exact scope', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
      String(input).endsWith('/lifecycle-fence') ? { activityGeneration: 'activity-1' } : { status: 'ok' },
    ), { status: 200 })) as unknown as typeof fetch;
    const client = new AcsSandboxLifecycleClient({ baseUrl: 'http://acs.test/', authToken: 'secret', fetchImpl });
    await expect(client.readLifecycleFence(identity)).resolves.toBe('activity-1');
    await client.notifyTerminal({ ...identity, terminalState: 'completed', terminalAt: '2026-08-30T00:00:00.000Z' });
    await client.advanceDeletionGeneration({ ...identity, deletionGeneration: 'generation-1' });
    await client.deleteScope({ ...identity, deletionGeneration: 'generation-1' });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((call) => [call[0], (call[1] as RequestInit).method])).toEqual([
      ['http://acs.test/sandboxes/lifecycle-fence', 'POST'],
      ['http://acs.test/sandboxes/lifecycle', 'POST'],
      ['http://acs.test/sandboxes/deletion-generation', 'POST'],
      ['http://acs.test/sandboxes/scope', 'DELETE'],
    ]);
    expect(JSON.parse((calls[3]![1] as RequestInit).body as string)).toEqual({
      ...identity, deletionGeneration: 'generation-1',
    });
  });
});

describe('SandboxLifecycleService durable lifecycle protocol', () => {
  it('notifies a terminal top-level workload only after its entire scope is inactive', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
      String(input).endsWith('/lifecycle-fence') ? { activityGeneration: 'activity-1' } : { status: 'ok' },
    ), { status: 200 })) as unknown as typeof fetch;
    const store = {
      listCleanupCandidates: vi.fn(async () => []),
      listTerminalCandidates: vi.fn(async () => [{
        ...identity, runId: 'run-top', tenantId: 'tenant-1', targetHandId: 'agent-saas-acs',
        status: 'completed' as const, terminalAt: '2026-08-30T00:00:00.000Z',
        workload: { kind: 'cron' as const },
      }]),
      hasActivity: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      markTerminalDelivered: vi.fn(async () => undefined),
    };
    const service = new SandboxLifecycleService({
      agentCwd: '/data', store: store as never, runStore: {} as never,
      sessionCatalog: { get: async () => session() },
      tenantRemoteHands: () => [remote()],
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => [remote()] }),
      fetchImpl,
    });
    const scan = () => (service as unknown as { scan(): Promise<void> }).scan();
    await scan();
    expect(fetchImpl).not.toHaveBeenCalled();
    await scan();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([
      'http://acs.test/sandboxes/lifecycle-fence', 'http://acs.test/sandboxes/lifecycle',
    ]);
    const terminalBody = JSON.parse(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1] as RequestInit).body as string);
    expect(terminalBody.expectedActivityGeneration).toBe('activity-1');
    expect(store.markTerminalDelivered).toHaveBeenCalledWith('run-top', expect.any(String));
  });

  it('does not notify when scope activity starts after reading the lifecycle fence', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ activityGeneration: 'activity-old' }), { status: 200 })) as unknown as typeof fetch;
    const store = {
      listCleanupCandidates: vi.fn(async () => []),
      listTerminalCandidates: vi.fn(async () => [{
        ...identity, runId: 'run-racing', tenantId: 'tenant-1', targetHandId: 'agent-saas-acs',
        status: 'completed' as const, terminalAt: '2026-08-30T00:00:00.000Z', workload: { kind: 'cron' as const },
      }]),
      hasActivity: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      markTerminalDelivered: vi.fn(async () => undefined),
    };
    const service = new SandboxLifecycleService({
      agentCwd: '/data', store: store as never, runStore: {} as never,
      sessionCatalog: { get: async () => session() }, tenantRemoteHands: () => [remote()],
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => [remote()] }),
      fetchImpl,
    });

    await (service as unknown as { scan(): Promise<void> }).scan();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])
      .toBe('http://acs.test/sandboxes/lifecycle-fence');
    expect(store.markTerminalDelivered).not.toHaveBeenCalled();
  });

  it('terminal outbox 固定原 hand，重启和 rollout 后仍重投原目标，404 不标记 delivered', async () => {
    const hands = [remote('acs-new', 'http://acs-new.test'), remote('acs-old', 'http://acs-old.test', 'drain')];
    let pinned: string | undefined;
    const markTerminalDelivered = vi.fn(async () => undefined);
    const candidate = () => ({
      ...identity, runId: 'run-top', tenantId: 'tenant-1', ...(pinned ? { targetHandId: pinned } : {}),
      status: 'completed' as const, terminalAt: '2026-08-30T00:00:00.000Z', workload: { kind: 'cron' as const },
    });
    const store = {
      listCleanupCandidates: vi.fn(async () => []), listTerminalCandidates: vi.fn(async () => [candidate()]),
      hasActivity: vi.fn(async () => false),
      pinTerminalTargetHand: vi.fn(async (_runId: string, handId: string) => { pinned = handId; return handId; }),
      markTerminalDelivered,
    };
    const handStore = {
      get: async () => ({ providerId: 'server-remote', metadata: { tenantRemoteHandId: 'acs-old', recipe: { sandboxScopeId: 'scope-1' } } }) as never,
      listBySession: async () => [],
    };
    const missingFetch = vi.fn(async () => new Response('Sandbox as-old not found', { status: 404 })) as unknown as typeof fetch;
    const first = new SandboxLifecycleService({
      agentCwd: '/data', store: store as never, runStore: {} as never,
      sessionCatalog: { get: async () => session() }, handStore,
      tenantRemoteHands: () => hands,
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => hands }),
      fetchImpl: missingFetch,
    });
    await (first as unknown as { scan(): Promise<void> }).scan();
    expect(pinned).toBe('acs-old');
    expect(markTerminalDelivered).not.toHaveBeenCalled();

    const recoveredFetch = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
      String(input).endsWith('/lifecycle-fence') ? { activityGeneration: 'activity-recovered' } : {},
    ), { status: 200 })) as unknown as typeof fetch;
    const restarted = new SandboxLifecycleService({
      agentCwd: '/data', store: store as never, runStore: {} as never,
      sessionCatalog: { get: async () => null },
      tenantRemoteHands: () => hands,
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => hands }),
      fetchImpl: recoveredFetch,
    });
    await (restarted as unknown as { scan(): Promise<void> }).scan();
    expect((recoveredFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([
      'http://acs-old.test/sandboxes/lifecycle-fence', 'http://acs-old.test/sandboxes/lifecycle',
    ]);
    expect(markTerminalDelivered).toHaveBeenCalledWith('run-top', expect.any(String));
  });

  it('distinguishes verified not_required from unresolved blocked and retries after target recovery', async () => {
    const enqueueCleanup = vi.fn(async (candidate: object) => ({ ...cleanup(), ...candidate }));
    let current: RuntimeSessionRecord | null = null;
    const service = new SandboxLifecycleService({
      agentCwd: '/data',
      store: {
        listPreparedCleanupCandidates: vi.fn(async () => []),
        listCleanupCandidates: vi.fn(async () => []),
        enqueueCleanup,
      } as never,
      runStore: {} as never,
      sessionCatalog: { get: async () => current },
      tenantRemoteHands: () => [remote()],
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => [remote()] }),
    });

    await expect(service.prepareSessionDeletion('session-1')).resolves.toBe('blocked');
    current = { ...session(), kind: 'subagent' };
    await expect(service.prepareSessionDeletion('session-1')).resolves.toBe('not_required');
    expect(enqueueCleanup).not.toHaveBeenCalled();

    current = session();
    await expect(service.prepareSessionDeletionIntent('session-1')).resolves.toBe('queued');
    expect(enqueueCleanup).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', targetHandId: 'agent-saas-acs',
    }), { prepared: true });
  });

  it('cancels active descendants under the durable claim lock and keeps cleanup queued when ACS is busy', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'busy' }), { status: 409 })) as unknown as typeof fetch;
    const cancelRun = vi.fn(async () => ({ targetCancelled: true }));
    let enqueued = cleanup();
    let state: 'none' | 'prepared' | 'cancelling' | 'pending' = 'none';
    const store = {
      listActiveScopeRuns: vi.fn()
        .mockResolvedValueOnce([{
          runId: 'run-child', sessionId: 'sub-child', tenantId: 'tenant-1', userId: 'u-1',
        }])
        .mockResolvedValueOnce([{
          runId: 'run-late-child', sessionId: 'sub-late-child', tenantId: 'tenant-1', userId: 'u-1',
        }])
        .mockResolvedValue([]),
      enqueueCleanup: vi.fn(async (candidate: typeof enqueued) => {
        enqueued = { ...candidate, runId: 'run-cleanup' }; state = 'prepared'; return enqueued;
      }),
      listPreparedCleanupCandidates: vi.fn(async () => state === 'prepared' ? [enqueued] : []),
      claimPreparedCleanup: vi.fn(async (_runId: string, claimId: string) => {
        state = 'cancelling'; return { ...enqueued, claimId, claimGeneration: 1 };
      }),
      isPreparedCleanupClaimCurrent: vi.fn(async () => state === 'cancelling'),
      runWhilePreparedCleanupClaimCurrent: vi.fn(async (...args: unknown[]) => {
        await (args[5] as () => Promise<void>)(); return true;
      }),
      completePreparedCleanup: vi.fn(async () => { state = 'pending'; return enqueued; }),
      releasePreparedCleanupClaim: vi.fn(async () => undefined),
      listCleanupCandidates: vi.fn(async () => state === 'pending' ? [enqueued] : []),
      claimCleanup: vi.fn(async (_runId: string, claimId: string) => ({ ...enqueued, claimId })),
      isCleanupClaimCurrent: vi.fn(async () => true),
      releaseCleanupClaim: vi.fn(async () => undefined),
      markCleanupDelivered: vi.fn(async () => undefined),
    };
    const service = new SandboxLifecycleService({
      agentCwd: '/data', store: store as never,
      runStore: { cancelSteeringBeforeDispatchBySessionWithEvent: cancelRun } as never,
      sessionCatalog: { get: async () => ({ ...session(), deletedAt: '2026-08-30T01:00:00.000Z' }) },
      handStore: {
        get: async () => ({ metadata: { recipe: { sandboxScopeId: 'scope-1' } } }) as never,
        listBySession: async () => [],
      },
      tenantRemoteHands: () => [remote()],
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => [remote()] }),
      fetchImpl,
    });

    await expect(service.prepareSessionDeletion('session-1')).resolves.toBe('queued');
    expect(cancelRun).toHaveBeenCalledWith(
      'sub-child', 'session_deleted:session-1', 'run-child',
      expect.objectContaining({ type: 'run_cancel_requested', runId: 'run-child' }), 'tenant-1',
      expect.objectContaining({ cleanupRunId: 'run-cleanup', sandboxScopeId: 'scope-1' }),
    );
    expect(cancelRun).toHaveBeenCalledWith(
      'sub-late-child', 'session_deleted:session-1', 'run-late-child',
      expect.objectContaining({ type: 'run_cancel_requested', runId: 'run-late-child' }), 'tenant-1',
      expect.objectContaining({ cleanupRunId: 'run-cleanup', sandboxScopeId: 'scope-1' }),
    );
    expect(store.enqueueCleanup).toHaveBeenCalledWith(expect.objectContaining({
      ...identity, tenantId: 'tenant-1', userId: 'u-1', username: 'alice',
      targetHandId: 'agent-saas-acs', deletionGeneration: expect.any(String),
    }), { prepared: true });
    expect(store.releaseCleanupClaim).toHaveBeenCalledWith('run-cleanup', expect.any(String));
    expect(store.completePreparedCleanup).toHaveBeenCalledBefore(store.claimCleanup);
  });

  it('retries persisted cleanup on its original hand with the inherited generation chain', async () => {
    const pending = {
      ...cleanup('generation-2'), targetHandId: 'acs-old',
      previousDeletionGeneration: 'generation-root',
    };
    const markCleanupDelivered = vi.fn(async () => undefined);
    const store = {
      listCleanupCandidates: vi.fn(async () => [pending]),
      claimCleanup: vi.fn(async (_runId: string, claimId: string) => ({ ...pending, claimId })),
      isCleanupClaimCurrent: vi.fn(async () => true),
      releaseCleanupClaim: vi.fn(async () => undefined),
      markCleanupDelivered,
      listTerminalCandidates: vi.fn(async () => []),
    };
    const hands = [remote('acs-new', 'http://acs-new.test'), remote('acs-old', 'http://acs-old.test', 'drain')];
    let currentGeneration = 'generation-root';
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        deletionGeneration: string; previousDeletionGeneration?: string;
      };
      if (String(input).endsWith('/deletion-generation')) {
        if (body.previousDeletionGeneration !== currentGeneration) {
          return new Response(JSON.stringify({ error: 'generation conflict' }), { status: 409 });
        }
        currentGeneration = body.deletionGeneration;
      }
      if (String(input).endsWith('/scope') && body.deletionGeneration !== currentGeneration) {
        return new Response(JSON.stringify({ error: 'stale deletion' }), { status: 409 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const restarted = new SandboxLifecycleService({
      agentCwd: '/data', store: store as never, runStore: {} as never,
      sessionCatalog: { get: async () => null },
      tenantRemoteHands: () => hands,
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => hands }),
      fetchImpl,
    });

    await (restarted as unknown as { scan(): Promise<void> }).scan();

    const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      'http://acs-old.test/sandboxes/deletion-generation',
      'http://acs-old.test/sandboxes/scope',
    ]);
    expect(currentGeneration).toBe('generation-2');
    expect(markCleanupDelivered).toHaveBeenCalledWith('run-cleanup', expect.any(String), expect.any(String));
  });

  it('initial prepared cleanup pins the actually registered ACS hand instead of server-remote providerId', async () => {
    const hands = [remote('acs-new', 'http://acs-new.test'), remote('acs-old', 'http://acs-old.test', 'drain')];
    let pending = cleanup();
    let state: 'none' | 'prepared' | 'cancelling' | 'pending' = 'none';
    const enqueueCleanup = vi.fn(async (candidate: typeof pending) => {
      pending = { ...candidate, runId: 'run-cleanup' }; state = 'prepared'; return pending;
    });
    const store = {
      listActiveScopeRuns: vi.fn(async () => []), enqueueCleanup,
      listPreparedCleanupCandidates: vi.fn(async () => state === 'prepared' ? [pending] : []),
      claimPreparedCleanup: vi.fn(async (_runId: string, claimId: string) => {
        state = 'cancelling'; return { ...pending, claimId, claimGeneration: 1 };
      }),
      isPreparedCleanupClaimCurrent: vi.fn(async () => state === 'cancelling'),
      runWhilePreparedCleanupClaimCurrent: vi.fn(async (...args: unknown[]) => {
        await (args[5] as () => Promise<void>)(); return true;
      }),
      completePreparedCleanup: vi.fn(async () => { state = 'pending'; return pending; }),
      releasePreparedCleanupClaim: vi.fn(async () => undefined),
      listCleanupCandidates: vi.fn(async () => state === 'pending' ? [pending] : []),
      claimCleanup: vi.fn(async (_runId: string, claimId: string) => ({ ...pending, claimId })),
      isCleanupClaimCurrent: vi.fn(async () => true), releaseCleanupClaim: vi.fn(async () => undefined),
      markCleanupDelivered: vi.fn(async () => undefined),
    };
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const service = new SandboxLifecycleService({
      agentCwd: '/data', store: store as never, runStore: {} as never,
      sessionCatalog: { get: async () => ({ ...session(), deletedAt: '2026-08-30T01:00:00.000Z' }) },
      handStore: {
        get: async () => ({ providerId: 'server-remote', metadata: { recipe: { sandboxScopeId: 'scope-1' } } }) as never,
        listBySession: async () => [{ providerId: 'acs-old', metadata: {} } as never],
      },
      tenantRemoteHands: () => hands,
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => hands }),
      fetchImpl,
    });

    await expect(service.prepareSessionDeletion('session-1')).resolves.toBe('deleted');
    expect(enqueueCleanup).toHaveBeenCalledWith(expect.objectContaining({ targetHandId: 'acs-old' }), { prepared: true });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]))).toEqual([
      'http://acs-old.test/sandboxes/deletion-generation', 'http://acs-old.test/sandboxes/scope',
    ]);
  });

  it('a restore on worker B advances the remote fence before worker A releases its old DELETE', async () => {
    let state: 'pending' | 'claimed' | 'cancelled' = 'pending';
    let currentGeneration: string | undefined;
    let scopeExists = true;
    let deleteStarted!: () => void;
    let releaseDelete!: () => void;
    const started = new Promise<void>((resolve) => { deleteStarted = resolve; });
    const blockedDelete = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const pending = cleanup('generation-1');
    const markCleanupDelivered = vi.fn(async () => undefined);
    const store = {
      listCleanupCandidates: vi.fn(async () => state === 'pending' ? [pending] : []),
      claimCleanup: vi.fn(async (_runId: string, claimId: string) => {
        if (state !== 'pending') return undefined;
        state = 'claimed';
        return { ...pending, claimId };
      }),
      isCleanupClaimCurrent: vi.fn(async () => state === 'claimed'),
      cancelCleanup: vi.fn(async (_sessionId: string, _tenantId: string, generation: string) => {
        state = 'cancelled';
        return [{ ...pending, previousDeletionGeneration: pending.deletionGeneration, deletionGeneration: generation }];
      }),
      releaseCleanupClaim: vi.fn(async () => undefined),
      markCleanupDelivered,
      listTerminalCandidates: vi.fn(async () => []),
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { deletionGeneration: string };
      if (String(url).endsWith('/sandboxes/deletion-generation')) {
        currentGeneration = body.deletionGeneration;
        return new Response('{}', { status: 200 });
      }
      deleteStarted();
      await blockedDelete;
      if (currentGeneration === body.deletionGeneration) scopeExists = false;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const shared = {
      agentCwd: '/data', store: store as never, runStore: {} as never,
      sessionCatalog: { get: async () => session() },
      tenantRemoteHands: () => [remote()],
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => [remote()] }),
      fetchImpl,
    };
    const workerA = new SandboxLifecycleService(shared);
    const workerB = new SandboxLifecycleService(shared);
    const scan = (workerA as unknown as { scan(): Promise<void> }).scan();
    await started;

    await workerB.cancelSessionDeletion('session-1');
    scopeExists = true; // restore 后 warmup/new Run 复用同一 scope
    releaseDelete();
    await scan;

    expect(state).toBe('cancelled');
    expect(scopeExists).toBe(true);
    expect(markCleanupDelivered).not.toHaveBeenCalled();
  });
});
