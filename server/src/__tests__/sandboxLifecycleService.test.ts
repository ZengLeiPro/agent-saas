import { describe, expect, it, vi } from 'vitest';

import {
  AcsSandboxLifecycleClient,
  SandboxLifecycleService,
  type SandboxLifecycleIdentity,
} from '../runtime/sandboxLifecycleService.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';

const identity: SandboxLifecycleIdentity = {
  workspaceId: 'ws-1', sessionId: 'session-1', sandboxScopeId: 'scope-1',
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

describe('AcsSandboxLifecycleClient exact-scope contract', () => {
  it('arms a generation before deleting the exact three-field scope', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })) as unknown as typeof fetch;
    const client = new AcsSandboxLifecycleClient({ baseUrl: 'http://acs.test/', authToken: 'secret', fetchImpl });
    await client.notifyTerminal({ ...identity, terminalState: 'completed', terminalAt: '2026-08-30T00:00:00.000Z' });
    await client.advanceDeletionGeneration({ ...identity, deletionGeneration: 'generation-1' });
    await client.deleteScope({ ...identity, deletionGeneration: 'generation-1' });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((call) => [call[0], (call[1] as RequestInit).method])).toEqual([
      ['http://acs.test/sandboxes/lifecycle', 'POST'],
      ['http://acs.test/sandboxes/deletion-generation', 'POST'],
      ['http://acs.test/sandboxes/scope', 'DELETE'],
    ]);
    expect(JSON.parse((calls[2]![1] as RequestInit).body as string)).toEqual({
      ...identity, deletionGeneration: 'generation-1',
    });
  });
});

describe('SandboxLifecycleService', () => {
  it('notifies a terminal top-level workload only after its whole scope is inactive', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })) as unknown as typeof fetch;
    const store = {
      listCleanupCandidates: vi.fn(async () => []),
      listTerminalCandidates: vi.fn(async () => [{
        ...identity, runId: 'run-top', tenantId: 'tenant-1', status: 'completed' as const,
        terminalAt: '2026-08-30T00:00:00.000Z', workload: { kind: 'cron' as const },
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.markTerminalDelivered).toHaveBeenCalledWith('run-top', expect.any(String));
  });

  it('cancels active descendants and keeps the durable cleanup claimed when ACS is busy', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'busy' }), { status: 409 })) as unknown as typeof fetch;
    const cancelRun = vi.fn(async () => ({ targetCancelled: true }));
    let enqueued = cleanup();
    const store = {
      listActiveScopeRuns: vi.fn(async () => [{
        runId: 'run-child', sessionId: 'sub-child', tenantId: 'tenant-1', userId: 'u-1',
      }]),
      enqueueCleanup: vi.fn(async (candidate: typeof enqueued) => {
        enqueued = { ...candidate, runId: 'run-cleanup' };
        return enqueued;
      }),
      claimCleanup: vi.fn(async (_runId: string, claimId: string) => ({ ...enqueued, claimId })),
      isCleanupClaimCurrent: vi.fn(async () => true),
      releaseCleanupClaim: vi.fn(async () => undefined),
      markCleanupDelivered: vi.fn(async () => undefined),
    };
    const service = new SandboxLifecycleService({
      agentCwd: '/data', store: store as never,
      runStore: { cancelSteeringBeforeDispatchBySessionWithEvent: cancelRun } as never,
      sessionCatalog: { get: async () => session() },
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
    );
    expect(store.enqueueCleanup).toHaveBeenCalledWith(expect.objectContaining({
      ...identity, tenantId: 'tenant-1', userId: 'u-1', username: 'alice',
      targetHandId: 'agent-saas-acs', deletionGeneration: expect.any(String),
    }));
    expect(store.releaseCleanupClaim).toHaveBeenCalledWith('run-cleanup', expect.any(String));
  });

  it('retries persisted cleanup on its original hand after rollout switches to another ACS', async () => {
    const pending = { ...cleanup(), targetHandId: 'acs-old' };
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
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
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
    expect(markCleanupDelivered).toHaveBeenCalledWith('run-cleanup', expect.any(String), expect.any(String));
  });

  it('initial cleanup pins the actually registered ACS hand instead of server-remote providerId', async () => {
    const hands = [remote('acs-new', 'http://acs-new.test'), remote('acs-old', 'http://acs-old.test', 'drain')];
    let pending = cleanup();
    const enqueueCleanup = vi.fn(async (candidate: typeof pending) => {
      pending = { ...candidate, runId: 'run-cleanup' };
      return pending;
    });
    const store = {
      listActiveScopeRuns: vi.fn(async () => []), enqueueCleanup,
      claimCleanup: vi.fn(async (_runId: string, claimId: string) => ({ ...pending, claimId })),
      isCleanupClaimCurrent: vi.fn(async () => true), markCleanupDelivered: vi.fn(async () => undefined),
    };
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const service = new SandboxLifecycleService({
      agentCwd: '/data', store: store as never, runStore: {} as never,
      sessionCatalog: { get: async () => session() },
      handStore: {
        get: async () => ({ providerId: 'server-remote', metadata: { recipe: { sandboxScopeId: 'scope-1' } } }) as never,
        listBySession: async () => [{ providerId: 'acs-old', metadata: {} } as never],
      },
      tenantRemoteHands: () => hands,
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => hands }),
      fetchImpl,
    });

    await expect(service.prepareSessionDeletion('session-1')).resolves.toBe('deleted');
    expect(enqueueCleanup).toHaveBeenCalledWith(expect.objectContaining({ targetHandId: 'acs-old' }));
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
