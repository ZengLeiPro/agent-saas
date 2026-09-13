import { describe, expect, it, vi } from 'vitest';
import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import { OwnedOperations } from './ownedOperations.js';
import type { OwnershipJournal } from './ownershipJournal.js';
import { SandboxOwnershipReaders } from './sandboxOwnershipReaders.js';
import { OwnershipBlockedError, admissionScopeConflicts, type OwnershipRecord, type WritableScope } from './ownershipState.js';
import type { SandboxRef } from './sandboxManagerTypes.js';

vi.mock('./sandboxInventoryReader.js', () => ({ readManagedSandboxes: vi.fn(async () => inventory) }));
let inventory: unknown[] = [];

// One user, one NAS directory, two sandboxes (the production per-session layout).
const shared = { storageId: 'isolated-test-storage', mountSubPath: 'workspaces/kaiyan/user', workspaceId: 'ws_kaiyan__user' };
const scopeA: WritableScope = { ...shared, sandboxName: 'as-user--a', sessionId: 'taskboard-a', sandboxScopeId: 'scope-a' };
const scopeB: WritableScope = { ...shared, sandboxName: 'as-user--b', sessionId: 'sub-b', sandboxScopeId: 'scope-b' };
const foreign = (scope: WritableScope, kind: OwnershipRecord['kind'] = 'provision', resource: OwnershipRecord['resource'] = 'running'): OwnershipRecord => ({
  protocolVersion: 1, operationId: `foreign:${scope.sandboxName}:${kind}`, attemptId: 'foreign-attempt', invocationId: 'foreign-invocation',
  ownerId: 'previous-generation', revision: 3, kind, scope, resource, outcome: 'pending', phase: 'dispatch',
  createdAt: '2026-09-13T03:00:00Z', updatedAt: '2026-09-13T03:00:00Z',
});

describe('ownership admission is exclusive per sandbox, not per shared workspace directory', () => {
  it('a sibling sandbox in-flight provision or ensure does not reject a new session', async () => {
    const provisioning = new OwnedOperations();
    await provisioning.begin({ kind: 'provision', invocationId: 'provision:a', attemptId: 'provision:a:1', scope: scopeA });
    await expect(provisioning.begin({ kind: 'provision', invocationId: 'provision:b', attemptId: 'provision:b:1', scope: scopeB })).resolves.toBeDefined();
    const ensuring = new OwnedOperations();
    await ensuring.begin({ kind: 'ensure', invocationId: 'ensure:a', attemptId: 'ensure:a:1', scope: scopeA });
    await expect(ensuring.begin({ kind: 'ensure', invocationId: 'ensure:b', attemptId: 'ensure:b:1', scope: scopeB })).resolves.toBeDefined();
    await expect(ensuring.begin({ kind: 'provision', invocationId: 'provision:b', attemptId: 'provision:b:2', scope: { ...scopeB, sandboxName: 'as-user--c' } })).resolves.toBeDefined();
  });

  it('the same sandbox still serializes provision against an in-flight ensure', async () => {
    const operations = new OwnedOperations();
    await operations.begin({ kind: 'ensure', invocationId: 'ensure:a', attemptId: 'ensure:a:1', scope: scopeA });
    await expect(operations.begin({ kind: 'provision', invocationId: 'provision:a', attemptId: 'provision:a:1', scope: scopeA }))
      .rejects.toBeInstanceOf(OwnershipBlockedError);
  });

  it('an unresolved sibling owner blocks only its own sandbox', async () => {
    const operations = new OwnedOperations();
    const stuck = await operations.begin({ kind: 'ensure', invocationId: 'ensure:a', attemptId: 'ensure:a:1', scope: scopeA });
    await stuck.unknown('shared_work_unconfirmed');
    await expect(operations.begin({ kind: 'provision', invocationId: 'provision:b', attemptId: 'provision:b:1', scope: scopeB })).resolves.toBeDefined();
    await expect(operations.begin({ kind: 'provision', invocationId: 'provision:a', attemptId: 'provision:a:1', scope: scopeA }))
      .rejects.toBeInstanceOf(OwnershipBlockedError);
  });

  it('foreign-generation records gate their own sandbox; only a receiver claims the whole scope', () => {
    const operations = new OwnedOperations();
    expect(operations.blocksAdmission(foreign(scopeA), scopeB)).toBe(false);
    expect(operations.blocksAdmission(foreign(scopeA), scopeA)).toBe(true);
    expect(operations.blocksAdmission(foreign(scopeA, 'invocation', 'unknown'), scopeB)).toBe(false);
    expect(operations.blocksAdmission(foreign(scopeA, 'receiver'), scopeB)).toBe(true);
    expect(admissionScopeConflicts(foreign({ ...scopeA, mountSubPath: 'workspaces/kaiyan/other' }), scopeB)).toBe(false);
  });

  it('a stale invocation lease on a sibling sandbox does not block, the same sandbox still does', async () => {
    const config = { namespace: 'unit', pvcName: 'pvc' } as AcsOrchestratorConfig;
    const operations = new OwnedOperations();
    const journal = { read: vi.fn(async () => []) } as unknown as OwnershipJournal;
    const readers = new SandboxOwnershipReaders(config, {} as Kubectl, operations, journal, null);
    const lease = { annotationKey: 'k', raw: '{}', invocationKey: 'gone-attempt', state: 'executing', malformed: false };
    const refB: SandboxRef = { name: 'as-user--b', workspaceId: shared.workspaceId, sessionId: 'sub-b', sandboxScopeId: 'scope-b', mountSubPath: shared.mountSubPath };
    inventory = [{ name: 'as-user--a', workspaceId: shared.workspaceId, sessionId: 'taskboard-a', sandboxScopeId: 'scope-a',
      mountSubPath: shared.mountSubPath, activeInvocationLeases: [lease] }];
    await expect(readers.assertWritable(refB)).resolves.toBeUndefined();
    inventory = [{ ...(inventory[0] as object), name: 'as-user--b' }];
    await expect(readers.assertWritable(refB)).rejects.toBeInstanceOf(OwnershipBlockedError);
  });
});
