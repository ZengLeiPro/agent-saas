import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { KubeApi } from './kubeApi.js';
import { OwnedOperations } from './ownedOperations.js';
import {
  OwnershipBlockedError,
  type OwnershipRecord,
  type WritableScope,
} from './ownershipState.js';
import type { OwnershipJournal } from './ownershipJournal.js';
import { queryRemoteAttemptEvidence } from './remoteAttemptClient.js';
import { reconcileRemoteOwnership } from './remoteOwnershipReconciler.js';
import type { SandboxManager } from './sandboxManager.js';
import type { RemoteAttemptFence } from './remoteAttemptProtocol.js';

vi.mock('./remoteAttemptClient.js', () => ({
  queryRemoteAttemptEvidence: vi.fn(async () => null),
}));

const scope: WritableScope = {
  storageId: 'storage',
  mountSubPath: 'workspaces/a',
  sandboxName: 'sb-1',
  workspaceId: 'ws-1',
  sessionId: 'session-1',
  sandboxScopeId: 'scope-1',
};
const config = {
  sandboxKind: 'Sandbox',
  namespace: 'unit',
  authToken: 'token',
} as AcsOrchestratorConfig;
const sleep = async () => undefined;
const logger = { info: vi.fn(), warn: vi.fn() };

afterEach(() => {
  vi.clearAllMocks();
  logger.info.mockReset();
  logger.warn.mockReset();
});

function journalFixture(initial: OwnershipRecord[] = []) {
  const records = new Map<string, OwnershipRecord>(
    initial.map((record) => [record.operationId, structuredClone(record)]),
  );
  const journal = {
    reserve: vi.fn(async (record: OwnershipRecord) => {
      records.set(record.operationId, structuredClone(record));
      return record;
    }),
    update: vi.fn(async (record: OwnershipRecord) => {
      records.set(record.operationId, structuredClone(record));
      return record;
    }),
    read: async () => [...records.values()].map((record) => structuredClone(record)),
    snapshot: () => ({
      available: true,
      records: [...records.values()].map((record) => structuredClone(record)),
    }),
  } as unknown as OwnershipJournal;
  return { journal, records };
}

function kubectlNotFound(): Kubectl {
  return {
    run: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null })),
  } as unknown as Kubectl;
}

function kubeApiItems(items: Array<Record<string, unknown>>): KubeApi {
  return { listSandboxItems: vi.fn(async () => items) } as unknown as KubeApi;
}

async function dispatchedLocal() {
  const { journal } = journalFixture();
  const operations = new OwnedOperations(journal, { receiptKey: () => 'receipt-key' });
  const operation = await operations.begin({
    kind: 'invocation',
    invocationId: 'inv-1',
    attemptId: 'attempt-1',
    scope,
  });
  const fence: RemoteAttemptFence = {
    protocolVersion: 1,
    operationId: operation.record.operationId,
    attemptId: operation.record.attemptId,
    ownerId: operation.record.ownerId,
    sandboxUid: 'uid-1',
    podUid: 'pod-1',
    startBeforeMs: Date.now() + 60_000,
  };
  await operation.bindRemoteFence(fence);
  await operation.dispatch('uid-1');
  return { journal, operations, operation, fence };
}

function sandboxManager(): SandboxManager {
  return {
    setBackgroundShellProtection: vi.fn(),
    completeInvocation: vi.fn(),
    setActiveInvocationLease: vi.fn(),
  } as unknown as SandboxManager;
}

describe('sandbox_absent ownership proof', () => {
  it('settles a local running owner when the CR is NotFound twice and drops drainBlockers', async () => {
    const { journal, operations, operation } = await dispatchedLocal();
    expect(operations.drainBlockers()).toBe(1);
    const reconciled = await reconcileRemoteOwnership({
      config,
      kubectl: kubectlNotFound(),
      kubeApi: kubeApiItems([]),
      journal,
      sandboxManager: sandboxManager(),
      operations,
      logger,
      sleep,
    });
    expect(reconciled).toEqual({ checked: 1, reconciled: 1 });
    expect(operation.record.resource).toBe('stopped');
    expect(operation.record.outcome).toBe('failed');
    expect(operation.record.reasonCode).toBeUndefined();
    expect(operations.drainBlockers()).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('proof=sandbox_absent'));
  });

  it('settles a foreign journal record when the CR uid has been replaced', async () => {
    const fence: RemoteAttemptFence = {
      protocolVersion: 1,
      operationId: 'op-foreign',
      attemptId: 'attempt-f',
      ownerId: 'owner-f',
      sandboxUid: 'uid-1',
      podUid: 'pod-1',
      startBeforeMs: Date.now() + 60_000,
    };
    const record: OwnershipRecord = {
      protocolVersion: 1,
      operationId: 'op-foreign',
      attemptId: 'attempt-f',
      invocationId: 'inv-f',
      ownerId: 'owner-f',
      revision: 2,
      kind: 'ensure',
      scope,
      resource: 'running',
      outcome: 'pending',
      phase: 'dispatch',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:01.000Z',
      sandboxUid: 'uid-1',
      dispatchedAt: '2026-09-14T00:00:01.000Z',
      remoteFence: fence,
    };
    const { journal, records } = journalFixture([record]);
    const operations = new OwnedOperations(journal, { receiptKey: () => 'receipt-key' });
    expect(operations.drainBlockers()).toBe(1);
    await reconcileRemoteOwnership({
      config,
      kubectl: kubectlNotFound(),
      kubeApi: kubeApiItems([{ metadata: { name: 'sb-1', uid: 'uid-rebuilt' } }]),
      journal,
      sandboxManager: sandboxManager(),
      operations,
      logger,
      sleep,
    });
    expect(records.get('op-foreign')?.resource).toBe('stopped');
    expect(records.get('op-foreign')?.reasonCode).toBe('sandbox_absent');
    expect(operations.drainBlockers()).toBe(0);
  });

  it('retains the owner when the CR is still present with the same uid', async () => {
    const { journal, operations, operation } = await dispatchedLocal();
    await reconcileRemoteOwnership({
      config,
      kubectl: kubectlNotFound(),
      kubeApi: kubeApiItems([
        { metadata: { name: 'sb-1', uid: 'uid-1' }, status: { phase: 'Running' } },
      ]),
      journal,
      sandboxManager: sandboxManager(),
      operations,
      logger,
      sleep,
    });
    expect(operation.record.resource).toBe('running');
    expect(operations.drainBlockers()).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('reason=sandbox_present'));
  });

  it('retains the owner when the CR is Paused with the same uid', async () => {
    const { journal, operations, operation } = await dispatchedLocal();
    await reconcileRemoteOwnership({
      config,
      kubectl: kubectlNotFound(),
      kubeApi: kubeApiItems([
        { metadata: { name: 'sb-1', uid: 'uid-1' }, status: { phase: 'Paused' } },
      ]),
      journal,
      sandboxManager: sandboxManager(),
      operations,
      logger,
      sleep,
    });
    expect(operation.record.resource).toBe('running');
    expect(operations.drainBlockers()).toBe(1);
  });

  it('retains the owner when the first observation is NotFound and the second finds the CR', async () => {
    const { journal, operations, operation } = await dispatchedLocal();
    const list = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ metadata: { name: 'sb-1', uid: 'uid-1' } }]);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, signal: null })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ metadata: { name: 'sb-1', uid: 'uid-1' } }),
        stderr: '',
        exitCode: 0,
        signal: null,
      });
    await reconcileRemoteOwnership({
      config,
      kubectl: { run } as unknown as Kubectl,
      kubeApi: { listSandboxItems: list } as unknown as KubeApi,
      journal,
      sandboxManager: sandboxManager(),
      operations,
      logger,
      sleep,
    });
    expect(operation.record.resource).toBe('running');
    expect(operations.drainBlockers()).toBe(1);
  });

  it('retains the owner when kubectl times out', async () => {
    const { journal, operations, operation } = await dispatchedLocal();
    await reconcileRemoteOwnership({
      config,
      kubectl: {
        run: vi.fn(async () => ({
          stdout: '',
          stderr: 'timeout',
          exitCode: -1,
          signal: null,
          remoteState: 'unknown',
        })),
      } as unknown as Kubectl,
      kubeApi: null,
      journal,
      sandboxManager: sandboxManager(),
      operations,
      logger,
      sleep,
    });
    expect(operation.record.resource).toBe('running');
    expect(operations.drainBlockers()).toBe(1);
  });

  it('retains a fenced record that never dispatched and has no dispatchedAt', async () => {
    const fence: RemoteAttemptFence = {
      protocolVersion: 1,
      operationId: 'op-reserved',
      attemptId: 'attempt-r',
      ownerId: 'owner-r',
      sandboxUid: 'uid-1',
      podUid: 'pod-1',
      startBeforeMs: Date.now() + 60_000,
    };
    const record: OwnershipRecord = {
      protocolVersion: 1,
      operationId: 'op-reserved',
      attemptId: 'attempt-r',
      invocationId: 'inv-r',
      ownerId: 'owner-r',
      revision: 1,
      kind: 'ensure',
      scope,
      resource: 'reserved',
      outcome: 'pending',
      phase: 'remote_reserved',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:01.000Z',
      sandboxUid: 'uid-1',
      remoteFence: fence,
    };
    const { journal, records } = journalFixture([record]);
    const list = vi.fn();
    const operations = new OwnedOperations(journal, { receiptKey: () => 'receipt-key' });
    await reconcileRemoteOwnership({
      config,
      kubectl: kubectlNotFound(),
      kubeApi: { listSandboxItems: list } as unknown as KubeApi,
      journal,
      sandboxManager: sandboxManager(),
      operations,
      logger,
      sleep,
    });
    expect(list).not.toHaveBeenCalled();
    expect(records.get('op-reserved')?.resource).toBe('reserved');
    expect(operations.drainBlockers()).toBe(1);
  });

  it('does not observe absence when the record has no sandboxUid', async () => {
    const fence: RemoteAttemptFence = {
      protocolVersion: 1,
      operationId: 'op-nofence-uid',
      attemptId: 'attempt-n',
      ownerId: 'owner-n',
      sandboxUid: 'uid-1',
      podUid: 'pod-1',
      startBeforeMs: Date.now() + 60_000,
    };
    const record: OwnershipRecord = {
      protocolVersion: 1,
      operationId: 'op-nofence-uid',
      attemptId: 'attempt-n',
      invocationId: 'inv-n',
      ownerId: 'owner-n',
      revision: 1,
      kind: 'invocation',
      scope,
      resource: 'running',
      outcome: 'pending',
      phase: 'dispatch',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:01.000Z',
      dispatchedAt: '2026-09-14T00:00:01.000Z',
      remoteFence: fence,
    };
    const { journal } = journalFixture([record]);
    const list = vi.fn();
    const operations = new OwnedOperations(journal, { receiptKey: () => 'receipt-key' });
    await reconcileRemoteOwnership({
      config,
      kubectl: kubectlNotFound(),
      kubeApi: { listSandboxItems: list } as unknown as KubeApi,
      journal,
      sandboxManager: sandboxManager(),
      operations,
      logger,
      sleep,
    });
    expect(list).not.toHaveBeenCalled();
    expect(operations.drainBlockers()).toBe(1);
  });

  it('rejects sandbox_absent proof whose observedAt is not after dispatchedAt', async () => {
    const { operation } = await dispatchedLocal();
    await expect(
      operation.complete(
        'failed',
        {
          kind: 'sandbox_absent',
          attemptId: operation.record.attemptId,
          sandboxUid: 'uid-1',
          observedAt: new Date(Date.parse(operation.record.dispatchedAt!) - 1_000).toISOString(),
        },
        'stopped',
      ),
    ).rejects.toBeInstanceOf(OwnershipBlockedError);
    expect(operation.record.resource).not.toBe('stopped');
  });

  it('does not settle a durable background_owned record via sandbox_absent', async () => {
    const fence: RemoteAttemptFence = {
      protocolVersion: 1,
      operationId: 'op-bg',
      attemptId: 'attempt-bg',
      ownerId: 'owner-bg',
      sandboxUid: 'uid-1',
      podUid: 'pod-1',
      startBeforeMs: Date.now() + 60_000,
    };
    const record: OwnershipRecord = {
      protocolVersion: 1,
      operationId: 'op-bg',
      attemptId: 'attempt-bg',
      invocationId: 'inv-bg',
      ownerId: 'owner-bg',
      revision: 3,
      kind: 'invocation',
      scope,
      resource: 'background_owned',
      outcome: 'success',
      phase: 'background_owned',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:02.000Z',
      sandboxUid: 'uid-1',
      dispatchedAt: '2026-09-14T00:00:01.000Z',
      remoteFence: fence,
    };
    const { journal } = journalFixture([record]);
    const operations = new OwnedOperations(journal, { receiptKey: () => 'receipt-key' });
    expect(operations.drainBlockers()).toBe(0);
    const list = vi.fn();
    await reconcileRemoteOwnership({
      config,
      kubectl: kubectlNotFound(),
      kubeApi: { listSandboxItems: list } as unknown as KubeApi,
      journal,
      sandboxManager: sandboxManager(),
      operations,
      logger,
      sleep,
    });
    expect(list).not.toHaveBeenCalled();
    expect(operations.drainBlockers()).toBe(0);
  });

  it('removes an unresolved executor entry after sandbox_absent settlement', async () => {
    const { journal, operations, operation } = await dispatchedLocal();
    const forget = vi.fn();
    expect(operation.record.sandboxUid).toBe('uid-1');
    await reconcileRemoteOwnership({
      config,
      kubectl: kubectlNotFound(),
      kubeApi: kubeApiItems([]),
      journal,
      sandboxManager: sandboxManager(),
      operations,
      executor: { forgetUnresolvedInvocationsForSandboxUid: forget },
      logger,
      sleep,
    });
    expect(logger.info.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'proof=sandbox_absent',
    );
    expect(forget).toHaveBeenCalledWith('uid-1', operation.record.attemptId);
    expect(operations.drainBlockers()).toBe(0);
  });

  it('does not skip a valid remote receipt in favour of sandbox_absent', async () => {
    const { journal, operations, operation, fence } = await dispatchedLocal();
    vi.mocked(queryRemoteAttemptEvidence).mockResolvedValueOnce({
      receipt: {
        protocolVersion: 1,
        fence,
        resource: 'stopped',
        observedAtMs: Date.now(),
      },
      envelope: { ignored: true },
    });
    await reconcileRemoteOwnership({
      config,
      kubectl: kubectlNotFound(),
      kubeApi: kubeApiItems([]),
      journal,
      sandboxManager: sandboxManager(),
      operations,
      logger,
      sleep,
    });
    expect(operation.record.resource).not.toBe('stopped');
  });
});
