import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardIntegrationCandidate } from '../../../shared/src/types/taskboard.js';
import {
  canonicalJson,
  computeIntegrationCandidateSubjectDigest,
  computeIntegrationRequirementDigest,
  computeIntegrationReviewReceiptDigest,
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
import { assertCandidateTransition, IntegrationCandidateStore } from './integrationCandidateStore.js';

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
    expect(rowToIntegrationCandidateRevision({
      candidate_id: candidate.id, revision: 1, digest_version: 1, subject_kind: 'source_seed',
      base_oid: 'base', head_oid: 'head', tree_oid: null, source_set_digest: 'sources',
      subject_digest: 'seed-subject', policy_snapshot_digest: 'policy', policy_revision: 'policy-1',
      merge_method: 'squash', work_round: 0, created_at: candidate.createdAt,
    })).toEqual(expect.objectContaining({ subjectKind: 'source_seed' }));
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

  it('rejects a source snapshot whose durable source belongs to another integration task', async () => {
    const candidateRow = {
      id: candidate.id, integration_task_id: candidate.integrationTaskId, repository_id: candidate.repositoryId,
      base_branch: candidate.baseBranch, branch: candidate.branch, state: 'composing', current_revision: 1,
      work_round: 0, version: 4, workflow_epoch: 2, lane_epoch: 3, policy_revision: candidate.policyRevision,
      merge_method: candidate.mergeMethod, policy_snapshot: candidate.policySnapshot, created_at: candidate.createdAt, updated_at: candidate.updatedAt,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM') && sql.includes('FOR UPDATE')) return { rows: [candidateRow] };
      if (sql.includes('SELECT s.integration_task_id')) return { rows: [{
        integration_task_id: 'another-integration', delivery_task_id: source.deliveryTaskId,
        repository_id: source.repositoryId, provider_pull_request_id: source.providerPullRequestId,
        reviewed_subject_digest: source.reviewedSubjectDigest, delivery_task_version: source.deliveryTaskVersion,
        board_id: 'board-1', integration_board_id: 'board-1', head_oid: source.frozenHeadOid, base_oid: source.frozenBaseOid,
      }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new IntegrationCandidateStore({
      pool: { connect: vi.fn(async () => client) }, tasksTable: 'tasks', integrationSourcesTable: 'integration_sources',
    } as never);
    await expect(store.appendRevision(candidate.id, {
      expectedVersion: 4, expectedCurrentRevision: 1, baseOid: 'base', headOid: 'head', treeOid: 'tree', sources: [source],
    })).rejects.toMatchObject({ code: 'TASKBOARD_CANDIDATE_SOURCE_OWNERSHIP_MISMATCH' });
  });

  it.each([
    ['cross-task review execution', { review_task_id: 'task-attacker' }, {}],
    ['forged canonical review receipt', {}, { reviewReceiptDigest: 'sha256:forged' }],
    ['forged requirement digest', {}, { requirementDigest: 'sha256:forged' }],
  ])('rejects %s even when caller-provided snapshot identities otherwise match', async (_name, rowPatch, sourcePatch) => {
    const candidateRow = {
      id: candidate.id, integration_task_id: candidate.integrationTaskId, repository_id: candidate.repositoryId,
      base_branch: candidate.baseBranch, branch: candidate.branch, state: 'composing', current_revision: 1,
      work_round: 0, version: 4, workflow_epoch: 2, lane_epoch: 3, policy_revision: candidate.policyRevision,
      merge_method: candidate.mergeMethod, policy_snapshot: candidate.policySnapshot,
      created_at: candidate.createdAt, updated_at: candidate.updatedAt,
    };
    const title = 'Authoritative delivery';
    const description = 'Authoritative requirement';
    const authoritativeSource = {
      ...source,
      reviewReceiptDigest: computeIntegrationReviewReceiptDigest(source.reviewExecutionId, source.reviewedSubjectDigest),
      requirementDigest: computeIntegrationRequirementDigest(title, description),
      ...sourcePatch,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM') && sql.includes('FOR UPDATE')) return { rows: [candidateRow] };
      if (sql.includes('SELECT s.integration_task_id')) return { rows: [{
        integration_task_id: candidate.integrationTaskId, delivery_task_id: source.deliveryTaskId,
        repository_id: source.repositoryId, provider_pull_request_id: source.providerPullRequestId,
        reviewed_subject_digest: source.reviewedSubjectDigest, delivery_task_version: source.deliveryTaskVersion,
        board_id: 'board-1', integration_board_id: 'board-1', head_oid: source.frozenHeadOid,
        base_oid: source.frozenBaseOid, title, description,
        review_execution_id: source.reviewExecutionId, review_task_id: source.deliveryTaskId,
        review_purpose: 'review', review_status: 'succeeded', ...rowPatch,
      }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new IntegrationCandidateStore({
      pool: { connect: vi.fn(async () => client) }, tasksTable: 'tasks', executionsTable: 'executions',
      integrationSourcesTable: 'integration_sources',
    } as never);
    await expect(store.appendRevision(candidate.id, {
      expectedVersion: 4, expectedCurrentRevision: 1, baseOid: 'base', headOid: 'head', treeOid: 'tree',
      sources: [authoritativeSource],
    })).rejects.toMatchObject({ code: 'TASKBOARD_CANDIDATE_SOURCE_OWNERSHIP_MISMATCH' });
  });

  it('atomically projects blocked candidates to the task and one open block episode', async () => {
    const candidateRow = {
      id: candidate.id, integration_task_id: candidate.integrationTaskId, repository_id: candidate.repositoryId,
      base_branch: candidate.baseBranch, branch: candidate.branch, state: 'in_review', current_revision: 1,
      work_round: 1, version: 4, workflow_epoch: 2, lane_epoch: 3, policy_revision: candidate.policyRevision,
      merge_method: candidate.mergeMethod, policy_snapshot: candidate.policySnapshot,
      source_set_digest: candidate.sourceSetDigest, created_at: candidate.createdAt, updated_at: candidate.updatedAt,
    };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('SELECT * FROM') && sql.includes('FOR UPDATE')) return { rows: [candidateRow] };
      if (sql.includes('UPDATE ky_taskboard_integration_candidates')) return { rows: [{ ...candidateRow, state: 'needs_human', version: 5, last_error: 'invalid work receipt' }] };
      if (sql.includes('UPDATE tasks')) return { rows: [{ id: candidate.integrationTaskId }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new IntegrationCandidateStore({
      pool: { connect: vi.fn(async () => client) }, tasksTable: 'tasks', executionsTable: 'executions',
      integrationSourcesTable: 'ky_taskboard_integration_sources', blockEpisodesTable: 'blocks',
    } as never);
    await store.transition(candidate.id, {
      expectedVersion: 4, expectedRevision: 1, to: 'needs_human', lastError: 'invalid work receipt',
    });
    const sql = query.mock.calls.map(([text]) => String(text));
    expect(sql).toContainEqual(expect.stringContaining("SET status='blocked'"));
    const episode = sql.find((text) => text.includes('INSERT INTO blocks'))!;
    expect(episode).toContain('WHERE NOT EXISTS');
    expect(query.mock.calls.find(([text]) => String(text).includes('INSERT INTO blocks'))?.[1])
      .toEqual([expect.any(String), 'integration-1', 'review', 'integration_candidate_needs_human', 'invalid work receipt']);
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it('atomically returns a merge-stage task to in_progress when safe recomposition is required', async () => {
    const candidateRow = {
      id: candidate.id, integration_task_id: candidate.integrationTaskId, repository_id: candidate.repositoryId,
      base_branch: candidate.baseBranch, branch: candidate.branch, provider_pull_request_id: '42', state: 'merging',
      current_revision: 1, work_round: 1, version: 4, workflow_epoch: 2, lane_epoch: 3,
      policy_revision: candidate.policyRevision, merge_method: candidate.mergeMethod, policy_snapshot: candidate.policySnapshot,
      source_set_digest: candidate.sourceSetDigest, approved_revision: 1, approved_review_execution_id: 'review-1',
      created_at: candidate.createdAt, updated_at: candidate.updatedAt,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM') && sql.includes('FOR UPDATE')) return { rows: [candidateRow] };
      if (sql.includes('UPDATE ky_taskboard_integration_candidates')) {
        return { rows: [{ ...candidateRow, state: 'composing', version: 5, approved_revision: null, approved_review_execution_id: null }] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new IntegrationCandidateStore({
      pool: { connect: vi.fn(async () => client) }, tasksTable: 'tasks', executionsTable: 'executions',
      integrationSourcesTable: 'ky_taskboard_integration_sources', blockEpisodesTable: 'blocks',
    } as never);

    const result = await store.transition(candidate.id, {
      expectedVersion: 4, expectedRevision: 1, to: 'composing',
    });

    expect(result.state).toBe('composing');
    expect(result.approvedRevision).toBeUndefined();
    expect(query.mock.calls.map(([text]) => String(text))).toContainEqual(expect.stringContaining("SET status='in_progress'"));
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
    expect(() => assertCandidateTransition({ ...candidate, state: 'merging' }, {
      expectedVersion: 4, expectedRevision: 1, to: 'composing',
    })).not.toThrow();
    expect(() => assertCandidateTransition({ ...candidate, state: 'merging' }, {
      expectedVersion: 4, expectedRevision: 1, to: 'canceled',
    })).toThrow('Invalid candidate transition');
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
      requestsOutboxTable: 'ky_taskboard_integration_requests_outbox_v3',
      activationHeartbeatsTable: 'ky_taskboard_integration_activation_heartbeats_v3',
    });
    expect(ddl.match(/ADD COLUMN IF NOT EXISTS workflow_version/g)).toHaveLength(2);
    expect(ddl).toContain('DEFAULT 2');
    expect(ddl).toContain('TASKBOARD_WORKFLOW_VERSION_IMMUTABLE');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ky_taskboard_integration_candidates');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ky_taskboard_integration_candidate_revisions');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ky_taskboard_integration_candidate_source_snapshots');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ky_taskboard_integration_provider_operations_v3');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ky_taskboard_integration_requests_outbox_v3');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ky_taskboard_integration_activation_heartbeats_v3');
    expect(ddl).toContain("status IN ('healthy','unhealthy','inactive')");
    expect(ddl).toContain("WHERE state IN ('executing','unknown')");
    expect(ddl).toContain('TASKBOARD_CANDIDATE_SNAPSHOT_IMMUTABLE');
    expect(ddl).toContain('TASKBOARD_CANDIDATE_SOURCE_REVIEW_OWNERSHIP_INVALID');
    expect(ddl).toContain("e.task_id=NEW.delivery_task_id");
    expect(ddl).toContain("e.purpose='review' AND e.status='succeeded'");
    expect(ddl).toContain('current_revision INTEGER NOT NULL DEFAULT 0');
    expect(ddl).toContain('work_round INTEGER NOT NULL DEFAULT 0');
    expect(ddl).toContain("subject_kind TEXT NOT NULL DEFAULT 'provider_subject'");
    expect(ddl).toContain('ALTER COLUMN tree_oid DROP NOT NULL');
    expect(ddl).toContain('TASKBOARD_CANDIDATE_MERGE_RECONCILIATION_REQUIRED');
    expect(ddl).toContain('worker_attempts INTEGER NOT NULL DEFAULT 0');
  });
});
