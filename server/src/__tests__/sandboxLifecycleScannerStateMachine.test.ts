import { describe, expect, it, vi } from 'vitest';

import { SandboxLifecycleService } from '../runtime/sandboxLifecycleService.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';

const deletedAt = '2026-08-31T00:00:00.000Z';
const baseCleanup = {
  runId: 'cleanup-run', workspaceId: 'workspace-1', sessionId: 'session-1', sandboxScopeId: 'scope-1',
  tenantId: 'tenant-1', userId: 'user-1', username: 'alice', targetHandId: 'acs-good',
  deletionGeneration: 'deletion-1',
};

function record(sessionId = 'session-1'): RuntimeSessionRecord {
  return {
    sessionId, userId: 'user-1', username: 'alice', tenantId: 'tenant-1', channel: 'web',
    cwd: '/data/workspaces/tenant-1/user-1', transcriptPath: `/tmp/${sessionId}.jsonl`,
    workspaceId: 'workspace-1', createdAt: deletedAt, updatedAt: deletedAt, deletedAt,
  };
}

function hand(id: string) {
  return { id, baseUrl: `http://${id}.test`, authToken: 'token', rollout: { mode: 'all' as const } };
}

function service(store: object, overrides: Record<string, unknown> = {}) {
  const hands = [hand('acs-bad'), hand('acs-good')];
  return new SandboxLifecycleService({
    agentCwd: '/data', store: store as never, runStore: {} as never,
    sessionCatalog: { get: async (sessionId: string) => record(sessionId) },
    tenantRemoteHands: () => hands,
    tenantRemoteHandResolver: {
      resolveForRegister: async (entry: (typeof hands)[number]) => ({ baseUrl: entry.baseUrl, authToken: entry.authToken }),
    },
    ...overrides,
  } as never);
}

function scan(instance: SandboxLifecycleService): Promise<void> {
  return (instance as unknown as { scan(): Promise<void> }).scan();
}

describe('SandboxLifecycleService durable preparation, guarded claims and candidate isolation', () => {
  it('does not make cleanup deliverable until active child cancellation completes and the scope is empty', async () => {
    let phase: 'none' | 'prepared' | 'cancelling' | 'pending' | 'claimed' | 'delivered' = 'none';
    let releaseCancel!: () => void;
    let cancelStarted!: () => void;
    const started = new Promise<void>((resolve) => { cancelStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const claimCleanup = vi.fn(async (_runId: string, claimId: string) => {
      if (phase !== 'pending') return undefined;
      phase = 'claimed'; return { ...baseCleanup, claimId };
    });
    const store = {
      enqueueCleanup: vi.fn(async () => { phase = 'prepared'; return baseCleanup; }),
      listPreparedCleanupCandidates: vi.fn(async () => phase === 'prepared' ? [baseCleanup] : []),
      claimPreparedCleanup: vi.fn(async (_runId: string, claimId: string) => {
        if (phase !== 'prepared') return undefined;
        phase = 'cancelling'; return { ...baseCleanup, claimId, claimGeneration: 1 };
      }),
      isPreparedCleanupClaimCurrent: vi.fn(async () => phase === 'cancelling'),
      runWhilePreparedCleanupClaimCurrent: vi.fn(async (...args: unknown[]) => {
        await (args[5] as () => Promise<void>)(); return true;
      }),
      releasePreparedCleanupClaim: vi.fn(async () => undefined),
      completePreparedCleanup: vi.fn(async () => { phase = 'pending'; return baseCleanup; }),
      listActiveScopeRuns: vi.fn()
        .mockResolvedValueOnce([{
          runId: 'child-run', sessionId: 'child-session', tenantId: 'tenant-1', userId: 'user-1',
        }])
        .mockResolvedValue([]),
      listCleanupCandidates: vi.fn(async () => phase === 'pending' ? [baseCleanup] : []),
      claimCleanup,
      isCleanupClaimCurrent: vi.fn(async () => phase === 'claimed'),
      releaseCleanupClaim: vi.fn(async () => undefined),
      markCleanupDelivered: vi.fn(async () => { phase = 'delivered'; }),
    };
    const cancelRun = vi.fn(async () => { cancelStarted(); await blocked; return { targetCancelled: true }; });
    const instance = service(store, {
      runStore: { cancelSteeringBeforeDispatchBySessionWithEvent: cancelRun }, fetchImpl,
    });

    const committing = instance.commitPreparedSessionDeletion('session-1');
    await started;
    expect(phase).toBe('cancelling');
    expect(claimCleanup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    releaseCancel();

    await expect(committing).resolves.toBe('deleted');
    expect(phase).toBe('delivered');
    expect(store.completePreparedCleanup).toHaveBeenCalledBefore(claimCleanup);
  });

  it('guarded cancellation becomes a no-op when restore wins the cleanup claim lock', async () => {
    let claimCurrent = true;
    const cancelRun = vi.fn(async () => {
      claimCurrent = false;
      return { targetCancelled: false };
    });
    const releaseClaim = vi.fn(async () => undefined);
    const complete = vi.fn(async () => baseCleanup);
    const store = {
      listPreparedCleanupCandidates: vi.fn(async () => [baseCleanup]),
      listCleanupCandidates: vi.fn(async () => []),
      claimPreparedCleanup: vi.fn(async (_runId: string, claimId: string) => (
        { ...baseCleanup, claimId, claimGeneration: 1 }
      )),
      isPreparedCleanupClaimCurrent: vi.fn(async () => claimCurrent),
      releasePreparedCleanupClaim: releaseClaim,
      completePreparedCleanup: complete,
      listActiveScopeRuns: vi.fn(async () => [{
        runId: 'child-run', sessionId: 'child-session', tenantId: 'tenant-1', userId: 'user-1',
      }]),
    };
    const instance = service(store, {
      runStore: { cancelSteeringBeforeDispatchBySessionWithEvent: cancelRun },
    });

    await expect(instance.commitPreparedSessionDeletion('session-1')).resolves.toBe('queued');
    expect(cancelRun).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledOnce();
  });

  it('lets a restarted worker take over an expired cancelling lease before delivery', async () => {
    let phase: 'cancelling' | 'pending' | 'claimed' | 'delivered' = 'cancelling';
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const store = {
      listPreparedCleanupCandidates: vi.fn(async () => [
        { ...baseCleanup, claimId: 'crashed-worker', claimGeneration: 1 },
      ]),
      claimPreparedCleanup: vi.fn(async (_runId: string, claimId: string) => {
        phase = 'cancelling'; return { ...baseCleanup, claimId, claimGeneration: 2 };
      }),
      isPreparedCleanupClaimCurrent: vi.fn(async (_runId: string, _claimId: string, generation: number) => (
        phase === 'cancelling' && generation === 2
      )),
      runWhilePreparedCleanupClaimCurrent: vi.fn(async (...args: unknown[]) => {
        await (args[5] as () => Promise<void>)(); return true;
      }),
      releasePreparedCleanupClaim: vi.fn(async () => undefined),
      completePreparedCleanup: vi.fn(async () => { phase = 'pending'; return baseCleanup; }),
      listActiveScopeRuns: vi.fn(async () => []),
      listLegacyCleanupCandidates: vi.fn(async () => []),
      listCleanupCandidates: vi.fn(async () => phase === 'pending' ? [baseCleanup] : []),
      claimCleanup: vi.fn(async (_runId: string, claimId: string) => {
        phase = 'claimed'; return { ...baseCleanup, claimId };
      }),
      isCleanupClaimCurrent: vi.fn(async () => phase === 'claimed'),
      releaseCleanupClaim: vi.fn(async () => undefined),
      markCleanupDelivered: vi.fn(async () => { phase = 'delivered'; }),
      listTerminalCandidates: vi.fn(async () => []),
    };

    await scan(service(store, { fetchImpl }));
    expect(store.claimPreparedCleanup).toHaveBeenCalledOnce();
    expect(store.completePreparedCleanup).toHaveBeenCalledWith('cleanup-run', expect.any(String), 2);
    expect(phase).toBe('delivered');
  });

  it('allows exactly one concurrent scanner generation to own cancellation and delivery', async () => {
    let phase: 'prepared' | 'cancelling' | 'pending' | 'claimed' | 'delivered' = 'prepared';
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const store = {
      listPreparedCleanupCandidates: vi.fn(async () => [baseCleanup]),
      claimPreparedCleanup: vi.fn(async (_runId: string, claimId: string) => {
        if (phase !== 'prepared') return undefined;
        phase = 'cancelling'; return { ...baseCleanup, claimId, claimGeneration: 1 };
      }),
      isPreparedCleanupClaimCurrent: vi.fn(async () => phase === 'cancelling'),
      runWhilePreparedCleanupClaimCurrent: vi.fn(async (...args: unknown[]) => {
        await (args[5] as () => Promise<void>)(); return true;
      }),
      releasePreparedCleanupClaim: vi.fn(async () => undefined),
      completePreparedCleanup: vi.fn(async () => { phase = 'pending'; return baseCleanup; }),
      listActiveScopeRuns: vi.fn(async () => []),
      listLegacyCleanupCandidates: vi.fn(async () => []),
      listCleanupCandidates: vi.fn(async () => phase === 'pending' ? [baseCleanup] : []),
      claimCleanup: vi.fn(async (_runId: string, claimId: string) => {
        if (phase !== 'pending') return undefined;
        phase = 'claimed'; return { ...baseCleanup, claimId };
      }),
      isCleanupClaimCurrent: vi.fn(async () => phase === 'claimed'),
      releaseCleanupClaim: vi.fn(async () => undefined),
      markCleanupDelivered: vi.fn(async () => { phase = 'delivered'; }),
      listTerminalCandidates: vi.fn(async () => []),
    };
    const options = { fetchImpl };
    await Promise.all([scan(service(store, options)), scan(service(store, options))]);

    expect(store.completePreparedCleanup).toHaveBeenCalledTimes(1);
    expect(store.markCleanupDelivered).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('releases a claimed cleanup after resolver rejection and continues with the next candidate', async () => {
    const bad = { ...baseCleanup, runId: 'bad-run', sessionId: 'bad-session', targetHandId: 'acs-bad' };
    const good = { ...baseCleanup, runId: 'good-run', sessionId: 'good-session' };
    const released: string[] = [];
    const delivered: string[] = [];
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const store = {
      listPreparedCleanupCandidates: vi.fn(async () => []), listLegacyCleanupCandidates: vi.fn(async () => []),
      listCleanupCandidates: vi.fn(async () => [bad, good]),
      claimCleanup: vi.fn(async (runId: string, claimId: string) => ({ ...(runId === bad.runId ? bad : good), claimId })),
      isCleanupClaimCurrent: vi.fn(async () => true),
      releaseCleanupClaim: vi.fn(async (runId: string) => { released.push(runId); }),
      markCleanupDelivered: vi.fn(async (runId: string) => { delivered.push(runId); }),
      listTerminalCandidates: vi.fn(async () => []),
    };
    const hands = [hand('acs-bad'), hand('acs-good')];
    const instance = service(store, {
      fetchImpl, tenantRemoteHands: () => hands,
      tenantRemoteHandResolver: {
        resolveForRegister: async (entry: (typeof hands)[number]) => {
          if (entry.id === 'acs-bad') throw new Error('credential unavailable');
          return { baseUrl: entry.baseUrl, authToken: entry.authToken };
        },
      },
    });

    await scan(instance);
    expect(released).toEqual(['bad-run', 'good-run']);
    expect(delivered).toEqual(['good-run']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('isolates legacy and terminal candidate resolver/credential failures', async () => {
    const enqueueCleanup = vi.fn(async () => baseCleanup);
    const markTerminalDelivered = vi.fn(async () => undefined);
    const terminal = (runId: string, targetHandId: string) => ({
      ...baseCleanup, runId, targetHandId, status: 'completed' as const, terminalAt: deletedAt,
      workload: { kind: 'cron' as const },
    });
    const store = {
      listPreparedCleanupCandidates: vi.fn(async () => []),
      listLegacyCleanupCandidates: vi.fn(async () => [
        { ...baseCleanup, runId: 'legacy-bad', sessionId: 'legacy-bad' },
        { ...baseCleanup, runId: 'legacy-good', sessionId: 'legacy-good' },
      ]),
      enqueueCleanup, listCleanupCandidates: vi.fn(async () => []),
      listTerminalCandidates: vi.fn(async () => [terminal('terminal-bad', 'acs-bad'), terminal('terminal-good', 'acs-good')]),
      hasActivity: vi.fn(async () => false), markTerminalDelivered,
    };
    const hands = [hand('acs-bad'), hand('acs-good')];
    const instance = service(store, {
      handStore: {
        get: async (id: string) => ({ metadata: { tenantRemoteHandId: id.startsWith('legacy-good') ? 'acs-good' : 'acs-bad' } }),
        listBySession: async () => [],
      },
      sessionCatalog: {
        get: async (sessionId: string) => {
          if (sessionId === 'legacy-bad') throw new Error('catalog unavailable');
          return record(sessionId);
        },
      },
      tenantRemoteHands: () => hands,
      tenantRemoteHandResolver: {
        resolveForRegister: async (entry: (typeof hands)[number]) => {
          if (entry.id === 'acs-bad') throw new Error('credential unavailable');
          return { baseUrl: entry.baseUrl, authToken: entry.authToken };
        },
      },
      fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });

    await scan(instance);
    expect(enqueueCleanup).toHaveBeenCalledTimes(1);
    expect(enqueueCleanup).toHaveBeenCalledWith(expect.objectContaining({ legacyRunId: 'legacy-good' }));
    expect(markTerminalDelivered).toHaveBeenCalledOnce();
    expect(markTerminalDelivered).toHaveBeenCalledWith('terminal-good', expect.any(String));
  });

  it('continues later scanner queues when an earlier candidate list query fails', async () => {
    const delivered = vi.fn(async () => undefined);
    const pending = { ...baseCleanup, claimId: 'claim-pending' };
    const store = {
      listPreparedCleanupCandidates: vi.fn(async () => { throw new Error('prepared query unavailable'); }),
      listLegacyCleanupCandidates: vi.fn(async () => []),
      listCleanupCandidates: vi.fn(async () => [pending]),
      claimCleanup: vi.fn(async () => pending), isCleanupClaimCurrent: vi.fn(async () => true),
      markCleanupDelivered: delivered, releaseCleanupClaim: vi.fn(async () => undefined),
      listTerminalCandidates: vi.fn(async () => []),
    };
    await scan(service(store, {
      fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    }));
    expect(delivered).toHaveBeenCalledOnce();
  });

  it('expires stale prepared intents without a tombstone so they cannot starve the scanner head', async () => {
    const expire = vi.fn(async () => true);
    const store = {
      listPreparedCleanupCandidates: vi.fn(async () => [baseCleanup]),
      expireUncommittedPreparedCleanup: expire,
      listLegacyCleanupCandidates: vi.fn(async () => []),
      listCleanupCandidates: vi.fn(async () => []),
      listTerminalCandidates: vi.fn(async () => []),
    };
    const instance = service(store, { sessionCatalog: { get: async () => null } });

    await scan(instance);
    expect(expire).toHaveBeenCalledWith(baseCleanup.runId);
  });
});
