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

function remote() {
  return {
    id: 'agent-saas-acs', baseUrl: 'http://acs.test', authToken: 'token', rollout: { mode: 'all' as const },
  };
}

describe('AcsSandboxLifecycleClient exact-scope contract', () => {
  it('uses exact lifecycle and scope-delete endpoints with all three identity fields', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })) as unknown as typeof fetch;
    const client = new AcsSandboxLifecycleClient({ baseUrl: 'http://acs.test/', authToken: 'secret', fetchImpl });
    await client.notifyTerminal({ ...identity, terminalState: 'completed', terminalAt: '2026-08-30T00:00:00.000Z' });
    await client.deleteScope(identity);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((call) => [call[0], (call[1] as RequestInit).method])).toEqual([
      ['http://acs.test/sandboxes/lifecycle', 'POST'],
      ['http://acs.test/sandboxes/scope', 'DELETE'],
    ]);
    expect(JSON.parse((calls[1]![1] as RequestInit).body as string)).toEqual(identity);
  });
});

describe('SandboxLifecycleService', () => {
  // The durable outbox covers both forward deletion and restore cancellation.
  it('notifies a terminal top-level workload only after its whole scope is inactive', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })) as unknown as typeof fetch;
    const store = {
      listCleanupCandidates: vi.fn(async () => []),
      listTerminalCandidates: vi.fn(async () => [{
        ...identity, runId: 'run-top', tenantId: 'tenant-1', status: 'completed' as const,
        terminalAt: '2026-08-30T00:00:00.000Z', workload: { kind: 'cron' as const },
      }]),
      hasActivity: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      markTerminalDelivered: vi.fn(async () => undefined),
    };
    const service = new SandboxLifecycleService({
      agentCwd: '/data', store: store as never,
      runStore: {} as never,
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

  it('cancels a pending durable cleanup before a soft-deleted session is restored', async () => {
    const cancelCleanup = vi.fn(async () => undefined);
    const service = new SandboxLifecycleService({
      agentCwd: '/data', store: { cancelCleanup } as never,
      runStore: {} as never,
      sessionCatalog: { get: async () => session() },
      tenantRemoteHands: () => [remote()],
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => [remote()] }),
    });

    await service.cancelSessionDeletion('session-1');
    expect(cancelCleanup).toHaveBeenCalledWith('session-1', 'tenant-1');
  });

  it('cancels active descendants first and retains a durable cleanup retry on ACS busy', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'busy' }), { status: 409 })) as unknown as typeof fetch;
    const cancel = vi.fn(async () => ({ targetCancelled: true }));
    const store = {
      listActiveScopeRuns: vi.fn(async () => [{
        runId: 'run-child', sessionId: 'sub-child', tenantId: 'tenant-1', userId: 'u-1',
      }]),
      enqueueCleanup: vi.fn(async () => true),
    };
    const service = new SandboxLifecycleService({
      agentCwd: '/data', store: store as never,
      runStore: { cancelSteeringBeforeDispatchBySessionWithEvent: cancel } as never,
      sessionCatalog: { get: async () => session() },
      handStore: { get: async () => ({ metadata: { recipe: { sandboxScopeId: 'scope-1' } } }) as never },
      tenantRemoteHands: () => [remote()],
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({ tenantRemoteHands: () => [remote()] }),
      fetchImpl,
    });
    await expect(service.prepareSessionDeletion('session-1')).resolves.toBe('queued');
    expect(cancel).toHaveBeenCalledWith(
      'sub-child', 'session_deleted:session-1', 'run-child',
      expect.objectContaining({ type: 'run_cancel_requested', runId: 'run-child' }), 'tenant-1',
    );
    expect(store.enqueueCleanup).toHaveBeenCalledWith(expect.objectContaining(identity));
  });
});
