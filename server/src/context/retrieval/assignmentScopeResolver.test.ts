import { describe, expect, it, vi } from 'vitest';

import {
  AssignmentContextRecallScopeResolver,
  ContextRecallScopeDriftError,
  type ContextCollectionAssignmentReader,
} from './assignmentScopeResolver.js';

const subject = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
  orgAgentId: 'agent-a',
};

function reader(assignments = [{ resourceId: 'collection-a', assignmentVersion: 7 }]) {
  return {
    listEffectiveResourceIds: vi.fn(async () => assignments),
  } satisfies ContextCollectionAssignmentReader;
}

describe('AssignmentContextRecallScopeResolver', () => {
  it('uses fresh deny-overrides-allow assignment authority for a legacy session without a pin', async () => {
    const assignments = reader();
    const resolver = new AssignmentContextRecallScopeResolver(assignments, {
      resolveSessionPin: async () => ({
        tenantId: 'tenant-a', userId: 'user-a', orgAgentId: 'agent-a',
      }),
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    await expect(resolver.resolve(subject, { operation: 'search' })).resolves.toEqual({
      collections: [{
        collectionId: 'collection-a', assignmentVersion: 7, resourceType: 'org_knowledge',
      }],
      resolvedAt: '2026-08-22T12:00:00.000Z',
      degraded: false,
      degradationReasons: [],
    });
    expect(assignments.listEffectiveResourceIds).toHaveBeenCalledWith(
      'tenant-a', 'user-a', 'org_knowledge', 'agent-a',
    );
  });

  it('accepts an exact immutable session pin', async () => {
    const resolver = new AssignmentContextRecallScopeResolver(reader(), {
      resolveSessionPin: async () => ({
        tenantId: 'tenant-a', userId: 'user-a', orgAgentId: 'agent-a',
        collectionAssignments: [{
          collectionId: 'collection-a', assignmentVersion: 7, resourceType: 'org_knowledge',
        }],
      }),
    });

    await expect(resolver.resolve(subject, { operation: 'get', recallId: 'hit-a' }))
      .resolves.toMatchObject({ collections: [{ collectionId: 'collection-a', assignmentVersion: 7 }] });
  });

  it.each([
    { current: [{ resourceId: 'collection-a', assignmentVersion: 8 }] },
    { current: [
      { resourceId: 'collection-a', assignmentVersion: 7 },
      { resourceId: 'collection-b', assignmentVersion: 1 },
    ] },
    { current: [] },
  ])('fails closed when a pinned assignment is changed, expanded, or revoked', async ({ current }) => {
    const resolver = new AssignmentContextRecallScopeResolver(reader(current), {
      resolveSessionPin: async () => ({
        tenantId: 'tenant-a', userId: 'user-a', orgAgentId: 'agent-a',
        collectionAssignments: [{
          collectionId: 'collection-a', assignmentVersion: 7, resourceType: 'org_knowledge',
        }],
      }),
    });

    await expect(resolver.resolve(subject, { operation: 'search' }))
      .rejects.toMatchObject({
        code: 'CONTEXT_RECALL_ASSIGNMENT_PIN_DRIFT',
      } satisfies Partial<ContextRecallScopeDriftError>);
  });

  it('rejects a session pin owned by another tenant or user before assignment lookup', async () => {
    const assignments = reader();
    const resolver = new AssignmentContextRecallScopeResolver(assignments, {
      resolveSessionPin: async () => ({ tenantId: 'tenant-b', userId: 'user-a' }),
    });

    await expect(resolver.resolve(subject, { operation: 'search' }))
      .rejects.toMatchObject({ code: 'CONTEXT_RECALL_SESSION_SUBJECT_MISMATCH' });
    expect(assignments.listEffectiveResourceIds).not.toHaveBeenCalled();
  });
});
