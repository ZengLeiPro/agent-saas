import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardTask } from '../../../../shared/src/types/taskboard.js';
import type { RepositoryPullRequestSnapshot } from '../repositoryProvider.js';
import { assertCurrentCandidatePullRequestGate, assertCurrentPullRequestGate } from './resolutionService.js';

const task: TaskBoardTask = {
  id: 'task-1', boardId: 'board-1', identifier: 'TASK-1', kind: 'delivery', title: 'CI gate', description: '',
  status: 'in_review', priority: 'high', labels: [], sortOrder: 1, providerPullRequestId: '42',
  reviewedSubjectDigest: 'subject-42', commentCount: 0, version: 4,
  createdAt: '2026-08-22T08:00:00.000Z', updatedAt: '2026-08-22T08:00:00.000Z',
};
const board = {
  owner_user_id: 'owner-1',
  repository: {
    provider: 'github', repositoryId: 'github:acme/repo', owner: 'acme', name: 'repo',
    baseBranch: 'main', allowForkPullRequest: false,
  },
};
const current: RepositoryPullRequestSnapshot = {
  providerPullRequestId: '42', number: 42, state: 'open', draft: false,
  headRef: 'fix/task-1', headOid: 'head-42', baseRef: 'main', baseOid: 'base-42',
  mergeable: true, requiredChecksKnown: true,
  requiredChecks: [{ name: 'Build & Check', status: 'success' }], subjectDigest: 'subject-42',
};
const taskRow = {
  provider_pull_request_id: '42', head_oid: 'head-42', base_oid: 'base-42', reviewed_subject_digest: 'subject-42',
  provider_ci_inspection_id: 'inspection-1', provider_ci_execution_id: 'execution-1',
  provider_ci_purpose: 'review', provider_ci_head_oid: 'head-42', provider_ci_status: 'success',
};
const inspectionPayload = {
  gateStatus: 'success',
  receipt: {
    inspectionId: 'inspection-1', executionId: 'execution-1', taskId: task.id, purpose: 'review',
    providerPullRequestId: '42', headOid: 'head-42',
  },
  snapshot: current,
};

function rig(input: {
  row?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  providerResult?: RepositoryPullRequestSnapshot;
  providerError?: Error;
} = {}) {
  const client = {
    query: vi.fn(async (sql: string) => sql.includes('change_type=')
      ? { rows: input.payload === undefined ? [{ payload: inspectionPayload }] : input.payload ? [{ payload: input.payload }] : [] }
      : { rows: [{ ...taskRow, ...input.row }] }),
  };
  const getPullRequest = input.providerError
    ? vi.fn(async () => { throw input.providerError; })
    : vi.fn(async () => input.providerResult ?? current);
  const options = {
    tasksTable: 'tasks', changesTable: 'changes',
    repositoryProvider: { getPullRequest, mergePullRequest: vi.fn() },
  } as never;
  return { client, options, getPullRequest };
}

describe('Work/Review current-head CI hard gate', () => {
  it('accepts a current-execution receipt and independently re-reads the exact green head', async () => {
    const { client, options, getPullRequest } = rig();
    await expect(assertCurrentPullRequestGate(
      options, client as never, task, board, 'execution-1', 'review',
    )).resolves.toEqual(current);
    expect(getPullRequest).toHaveBeenCalledWith(board.repository, '42', 'owner-1');
  });

  it.each([
    ['missing receipt', { payload: null }, 'TASKBOARD_CI_INSPECTION_REQUIRED'],
    ['old head receipt', { row: { provider_ci_head_oid: 'old-head' } }, 'TASKBOARD_CI_INSPECTION_REQUIRED'],
    ['old execution receipt', { row: { provider_ci_execution_id: 'execution-old' } }, 'TASKBOARD_CI_INSPECTION_REQUIRED'],
    ['provider unavailable', { providerError: new Error('GitHub unavailable') }, 'TASKBOARD_CI_UNAVAILABLE'],
    ['checks pending', { providerResult: { ...current, requiredChecks: [{ name: 'Build & Check', status: 'pending' as const }] } }, 'TASKBOARD_CI_PENDING'],
    ['checks failed', { providerResult: { ...current, requiredChecks: [{ name: 'Build & Check', status: 'failure' as const }] } }, 'TASKBOARD_CI_FAILED'],
    ['unknown gates', { providerResult: { ...current, requiredChecksKnown: false } }, 'TASKBOARD_CI_UNAVAILABLE'],
    ['head drift', { providerResult: { ...current, headOid: 'new-head' } }, 'TASKBOARD_SUBJECT_STALE'],
    ['base drift', { providerResult: { ...current, baseOid: 'new-base' } }, 'TASKBOARD_SUBJECT_STALE'],
    ['subject drift', { providerResult: { ...current, subjectDigest: 'new-subject' } }, 'TASKBOARD_SUBJECT_STALE'],
    ['not mergeable', { providerResult: { ...current, mergeable: false } }, 'TASKBOARD_PR_NOT_MERGEABLE'],
    ['unknown mergeability', { providerResult: { ...current, mergeable: null } }, 'TASKBOARD_MERGEABILITY_UNKNOWN'],
  ] as const)('rejects %s fail-closed', async (_label, config, code) => {
    const { client, options } = rig(config as Parameters<typeof rig>[0]);
    await expect(assertCurrentPullRequestGate(
      options, client as never, task, board, 'execution-1', 'review',
    )).rejects.toMatchObject({ code });
  });
});

const candidateTask: TaskBoardTask = {
  ...task,
  id: 'integration-1',
  identifier: 'INT-1',
  kind: 'integration',
  providerPullRequestId: undefined,
  reviewedSubjectDigest: undefined,
};
const candidateBinding = {
  candidateId: 'candidate-1',
  revision: 3,
  providerPullRequestId: '42',
  headOid: 'head-42',
  baseOid: 'base-42',
  subjectDigest: 'candidate-subject-3',
};
const candidateInspectionPayload = {
  gateStatus: 'success',
  receipt: {
    inspectionId: 'inspection-1', executionId: 'execution-1', taskId: candidateTask.id, purpose: 'review',
    providerPullRequestId: '42', headOid: 'head-42', candidateId: 'candidate-1', candidateRevision: 3,
    candidateSubjectDigest: 'candidate-subject-3',
  },
  snapshot: current,
};

function candidateRig(input: {
  payload?: Record<string, unknown> | null;
  providerResult?: RepositoryPullRequestSnapshot;
} = {}) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('change_type=')) {
        const payload = input.payload === undefined ? candidateInspectionPayload : input.payload;
        return { rows: payload ? [{ payload }] : [] };
      }
      if (sql.includes('SELECT repository,owner_user_id')) return { rows: [board] };
      return { rows: [{
        provider_ci_inspection_id: 'inspection-1', provider_ci_execution_id: 'execution-1',
        provider_ci_purpose: 'review', provider_ci_head_oid: 'head-42', provider_ci_status: 'success',
      }] };
    }),
  };
  const getPullRequest = vi.fn(async () => input.providerResult ?? current);
  const genericGetPullRequest = vi.fn(async () => { throw new Error('generic OAuth provider must not be used'); });
  const options = {
    tasksTable: 'tasks', changesTable: 'changes', boardsTable: 'boards',
    repositoryProvider: { getPullRequest: genericGetPullRequest, mergePullRequest: vi.fn() },
    integrationV3RepositoryProvider: { getPullRequest, mergePullRequest: vi.fn() },
  } as never;
  return { client, options, getPullRequest, genericGetPullRequest };
}

describe('Workflow v3 candidate Review CI hard gate', () => {
  it('accepts only a current-review receipt bound to the exact candidate revision and green head', async () => {
    const { client, options, getPullRequest, genericGetPullRequest } = candidateRig();

    await expect(assertCurrentCandidatePullRequestGate(
      options, client as never, candidateTask, 'execution-1', candidateBinding,
    )).resolves.toEqual(current);
    expect(getPullRequest).toHaveBeenCalledWith(board.repository, '42', 'owner-1');
    expect(genericGetPullRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['missing receipt', { payload: null }, 'TASKBOARD_CI_INSPECTION_REQUIRED'],
    ['old candidate revision', { payload: {
      ...candidateInspectionPayload,
      receipt: { ...candidateInspectionPayload.receipt, candidateRevision: 2 },
    } }, 'TASKBOARD_CI_INSPECTION_REQUIRED'],
    ['checks rerun pending', { providerResult: {
      ...current,
      requiredChecks: [{ name: 'Build & Check', status: 'pending' as const }],
    } }, 'TASKBOARD_CI_PENDING'],
    ['no checks observed', { providerResult: { ...current, requiredChecks: [] } }, 'TASKBOARD_CI_PENDING'],
    ['draft pull request', { providerResult: { ...current, draft: true } }, 'TASKBOARD_PR_NOT_OPEN'],
    ['not mergeable', { providerResult: { ...current, mergeable: false } }, 'TASKBOARD_PR_NOT_MERGEABLE'],
    ['unknown mergeability', { providerResult: { ...current, mergeable: null } }, 'TASKBOARD_MERGEABILITY_UNKNOWN'],
  ] as const)('rejects %s fail-closed', async (_label, config, code) => {
    const { client, options } = candidateRig(config as Parameters<typeof candidateRig>[0]);
    await expect(assertCurrentCandidatePullRequestGate(
      options, client as never, candidateTask, 'execution-1', candidateBinding,
    )).rejects.toMatchObject({ code });
  });
});
