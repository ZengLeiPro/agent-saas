import { describe, expect, it, vi } from 'vitest';

import type { TaskBoard } from '../../../shared/src/types/taskboard.js';
import { discoverBoardCiPolicy } from './ciPolicyDiscovery.js';
import type { TaskboardIdentity } from './types.js';

const identity: TaskboardIdentity = { tenantId: 'tenant-1', ownerUserId: 'user-1', username: 'user' };
const board: TaskBoard = {
  id: 'board-1', name: 'Board', visibility: 'personal', ownerUserId: 'owner-1', canManage: true, prompt: '',
  repository: { provider: 'github', repositoryId: 'github:tenant-1:acme/app', owner: 'acme', name: 'app', baseBranch: 'main', allowForkPullRequest: false },
  integrationPolicy: {
    schemaVersion: 1, enabled: true, revision: 'r1',
    ciPolicy: { requiredChecks: [{ name: 'board-ci', appId: 9 }] },
    trigger: { mode: 'manual', allowedRoles: ['owner'] },
    batch: { maxTasks: 10, selection: 'priority_then_ready_at' },
    execution: { mergeMethod: 'squash', continueIndependentSources: true, autoResolveConflicts: true, maxAutomaticRemediationRounds: 2, maxTransientRetries: 3, requireGreenChecks: true, deleteRemoteBranch: false, deploy: false },
  },
  version: 1, createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
};

function host(githubRequiredChecks: Array<{ name: string; appId?: number }>) {
  return {
    pool: { query: vi.fn(async () => ({ rows: [{ provider_pull_request_id: '42' }] })) },
    tasksTable: 'tasks',
    getBoard: vi.fn(async () => board),
    repositoryProvider: {
      getRequiredGateCapabilities: vi.fn(async () => ({ known: true, requiredChecks: githubRequiredChecks, mergeQueueRequired: false, unsupportedRules: [] })),
      getPullRequest: vi.fn(async () => ({
        providerPullRequestId: '42', number: 42, state: 'open' as const, draft: false,
        headRef: 'feat/x', headOid: 'head-42', baseRef: 'main', baseOid: 'base-42', mergeable: true,
        requiredChecks: [], requiredChecksKnown: true, subjectDigest: 'subject-42',
        observedChecks: [{ name: 'optional', appId: 7, appName: 'Optional App', status: 'success' as const }],
      })),
      mergePullRequest: vi.fn(),
    },
  };
}

describe('discoverBoardCiPolicy', () => {
  it('keeps GitHub required checks authoritative and exposes observed checks separately', async () => {
    const result = await discoverBoardCiPolicy(host([{ name: 'github-ci' }]), identity, board.id);
    expect(result).toMatchObject({
      effectiveSource: 'github', githubRequiredChecks: [{ name: 'github-ci' }],
      boardRequiredChecks: [{ name: 'board-ci', appId: 9 }],
      effectiveRequiredChecks: [{ name: 'github-ci' }],
      observedChecks: [{ name: 'optional', appId: 7, appName: 'Optional App', status: 'success' }],
      providerPullRequestId: '42', headOid: 'head-42',
    });
  });

  it('uses only this board fallback when GitHub required checks are empty', async () => {
    const result = await discoverBoardCiPolicy(host([]), identity, board.id);
    expect(result).toMatchObject({ effectiveSource: 'board', effectiveRequiredChecks: [{ name: 'board-ci', appId: 9 }] });
  });
});
