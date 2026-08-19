import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardIntegrationCandidate } from '../../../shared/src/types/taskboard.js';
import {
  canonicalJson,
  computeIntegrationCandidateSubjectDigest,
  computeIntegrationSourceSetDigest,
} from './integrationCandidateDigest.js';
import {
  integrationWorkflowVersionFromRow,
  rowToIntegrationCandidate,
  rowToIntegrationCandidateRevision,
  rowToIntegrationCandidateSourceSnapshot,
} from './integrationCandidateMapper.js';
import {
  integrationCandidateTableNames,
  runIntegrationCandidateSchema,
} from './integrationCandidateSchema.js';
import { assertCandidateTransition } from './integrationCandidateStore.js';

const source = {
  order: 0,
  integrationSourceId: 'source-1',
  deliveryTaskId: 'task-1',
  deliveryTaskVersion: 7,
  repositoryId: 'github:tenant:kaiyan/agent-saas',
  providerPullRequestId: '101',
  frozenHeadOid: 'head-source-1',
  frozenBaseOid: 'base-source-1',
  reviewedSubjectDigest: 'sha256:reviewed',
  reviewExecutionId: 'review-source-1',
  reviewReceiptDigest: 'sha256:receipt',
  requirementDigest: 'sha256:requirement',
};

const candidate: TaskBoardIntegrationCandidate = {
  id: 'candidate-1',
  integrationTaskId: 'integration-1',
  repositoryId: source.repositoryId,
  baseBranch: 'main',
  branch: 'integration/integration-1',
  state: 'in_review',
  currentRevision: 1,
  workRound: 1,
  version: 4,
  workflowEpoch: '2',
  laneEpoch: '3',
  policyRevision: 'policy-1',
  mergeMethod: 'squash',
  policySnapshot: { requireGreenChecks: true },
  sourceSetDigest: 'sha256:sources',
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

describe('integration candidate v3 digest', () => {
  it('is canonical across object key insertion order and sensitive to every merge subject boundary', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } }))
      .toBe(canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
    const sourceSetDigest = computeIntegrationSourceSetDigest([source]);
    const base = {
      repository: { repositoryId: source.repositoryId, baseBranch: 'main' },
      baseOid: 'base',
      headOid: 'head',
      treeOid: 'tree',
      sourceSetDigest,
      mergeMethod: 'squash' as const,
      policyRevision: 'policy-1',
      policySnapshot: { checks: [{ context: 'test', appId: 1 }] },
    };
    const digest = computeIntegrationCandidateSubjectDigest(base);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(new Set([
      digest,
      computeIntegrationCandidateSubjectDigest({ ...base, repository: { ...base.repository, repositoryId: 'other' } }),
      computeIntegrationCandidateSubjectDigest({ ...base, baseOid: 'other' }),
      computeIntegrationCandidateSubjectDigest({ ...base, headOid: 'other' }),
      computeIntegrationCandidateSubjectDigest({ ...base, treeOid: 'other' }),
      computeIntegrationCandidateSubjectDigest({ ...base, sourceSetDigest: 'sha256:other' }),
      computeIntegrationCandidateSubjectDigest({ ...base, mergeMethod: 'merge' }),
      computeIntegrationCandidateSubjectDigest({ ...base, policySnapshot: { checks: [] } }),
    ]).size).toBe(8);
  });

  it('rejects an empty, duplicate, or non-contiguous source set', () => {
    expect(() => computeIntegrationSourceSetDigest([])).toThrow('must not be empty');
    expect(() => computeIntegrationSourceSetDigest([source, { ...source, order: 1 }]))
      .toThrow('Duplicate integration source');
    expect(() => computeIntegrationSourceSetDigest([{ ...source, order: 1 }]))
      .toThrow('expected 0');
  });
});

describe('integration candidate v3 mapper and invariants', () => {
  it('maps candidate, revision, source snapshot and defaults legacy workflow rows to v2', () => {
    expect(integrationWorkflowVersionFromRow({})).toBe(2);
    expect(integrationWorkflowVersionFromRow({ workflow_version: 3 })).toBe(3);
    expect(rowToIntegrationCandidate({
      id: candidate.id,
      integration_task_id: candidate.integrationTaskId,
      repository_id: candidate.repositoryId,
      base_branch: candidate.baseBranch,
      branch: candidate.branch,
      state: candidate.state,
      current_revision: 1,
      work_round: 1,
      version: 4,
      workflow_epoch: 2,
      lane_epoch: 3,
      policy_revision: candidate.policyRevision,
      merge_method: candidate.mergeMethod,
      policy_snapshot: JSON.stringify(candidate.policySnapshot),
      source_set_digest: candidate.sourceSetDigest,
      created_at: candidate.createdAt,
      updated_at: candidate.updatedAt,
    })).toMatchObject(candidate);
    expect(rowToIntegrationCandidateRevision({
      candidate_id: candidate.id, revision: 1, digest_version: 1,
      base_oid: 'base', head_oid: 'head', tree_oid: 'tree', source_set_digest: 'sources',
      subject_digest: 'subject', policy_snapshot_digest: 'policy', policy_revision: 'policy-1',
      merge_method: 'squash', work_round: 1, created_at: candidate.createdAt,
    })).toMatchObject({ candidateId: candidate.id, revision: 1, workRound: 1 });
    expect(rowToIntegrationCandidateSourceSnapshot({
      candidate_id: candidate.id, revision: 1, source_order: 0,
      integration_source_id: source.integrationSourceId, delivery_task_id: source.deliveryTaskId,
      delivery_task_version: source.deliveryTaskVersion, repository_id: source.repositoryId,
      provider_pull_request_id: source.providerPullRequestId, frozen_head_oid: source.frozenHeadOid,
      frozen_base_oid: source.frozenBaseOid, reviewed_subject_digest: source.reviewedSubjectDigest,
      review_execution_id: source.reviewExecutionId, review_receipt_digest: source.reviewReceiptDigest,
      requirement_digest: source.requirementDigest, created_at: candidate.createdAt,
    })).toMatchObject({ candidateId: candidate.id, revision: 1, order: 0 });
  });

  it('requires current revision approval before merging and a receipt before merged', () => {
    expect(() => assertCandidateTransition(candidate, {
      expectedVersion: 4, expectedRevision: 1, to: 'approved',
    })).toThrow('bind the current revision');
    expect(() => assertCandidateTransition({
      ...candidate, state: 'approved', approvedRevision: 0, approvedReviewExecutionId: 'review-1',
    }, { expectedVersion: 4, expectedRevision: 1, to: 'merging' })).toThrow('currently approved');
    expect(() => assertCandidateTransition({ ...candidate, state: 'merging' }, {
      expectedVersion: 4, expectedRevision: 1, to: 'merged',
    })).toThrow('provider commit OID');
    expect(() => assertCandidateTransition(candidate, {
      expectedVersion: 4, expectedRevision: 1, to: 'approved', approvedReviewExecutionId: 'review-1',
    })).not.toThrow();
  });
});

describe('integration candidate v3 schema', () => {
  it('is expand-only and can be installed repeatedly with stable table names', async () => {
    const sql: string[] = [];
    const client = { query: vi.fn(async (text: string) => {
      sql.push(text);
      return { rows: [] };
    }) };
    const options = {
      tasksTable: 'ky_taskboard_tasks',
      executionsTable: 'ky_taskboard_executions',
      integrationSourcesTable: 'ky_taskboard_integration_sources',
    };
    await runIntegrationCandidateSchema(options, client as never);
    await runIntegrationCandidateSchema(options, client as never);
    const ddl = sql.join('\n');
    expect(integrationCandidateTableNames(options.integrationSourcesTable)).toEqual({
      candidatesTable: 'ky_taskboard_integration_candidates',
      revisionsTable: 'ky_taskboard_integration_candidate_revisions',
      sourceSnapshotsTable: 'ky_taskboard_integration_candidate_source_snapshots',
      providerOperationsTable: 'ky_taskboard_integration_provider_operations_v3',
    });
    expect(ddl.match(/ADD COLUMN IF NOT EXISTS workflow_version/g)).toHaveLength(2);
    expect(ddl).toContain('DEFAULT 2');
    expect(ddl).toContain('TASKBOARD_WORKFLOW_VERSION_IMMUTABLE');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ky_taskboard_integration_candidates');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ky_taskboard_integration_candidate_revisions');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ky_taskboard_integration_candidate_source_snapshots');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ky_taskboard_integration_provider_operations_v3');
    expect(ddl).toContain("WHERE state IN ('executing','unknown')");
    expect(ddl).toContain('TASKBOARD_CANDIDATE_SNAPSHOT_IMMUTABLE');
    expect(ddl).toContain('current_revision INTEGER NOT NULL DEFAULT 0');
    expect(ddl).toContain('work_round INTEGER NOT NULL DEFAULT 0');
  });
});
