import { describe, expect, it, vi } from 'vitest';

import {
  loadIntegrationCandidateProjection,
  type IntegrationCandidateProjectionHost,
} from './integrationCandidateProjection.js';

const identity = { tenantId: 'tenant-1', ownerUserId: 'user-1', username: 'owner' };

function hostWith(query: ReturnType<typeof vi.fn>, task: Record<string, unknown>) {
  return {
    pool: { query },
    integrationSourcesTable: 'x_taskboard_integration_sources',
    getTask: vi.fn().mockResolvedValue(task),
  } as unknown as IntegrationCandidateProjectionHost;
}

describe('loadIntegrationCandidateProjection', () => {
  it('rejects tasks outside the v3 integration workflow before querying candidate tables', async () => {
    const query = vi.fn();
    const host = hostWith(query, { kind: 'integration', workflowVersion: 2 });

    await expect(loadIntegrationCandidateProjection(host, identity, 'task-1')).rejects.toMatchObject({
      code: 'TASKBOARD_CANDIDATE_WORKFLOW_VERSION_REQUIRED',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('loads and maps the candidate projection and worker state', async () => {
    const now = new Date('2026-08-19T00:00:00.000Z');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 'candidate-1', integration_task_id: 'task-1', repository_id: 'repo-1',
        base_branch: 'main', branch: 'integration/task-1', state: 'working', current_revision: 1,
        work_round: 2, version: 3, workflow_epoch: '4', lane_epoch: '5', policy_revision: 'policy-1',
        merge_method: 'squash', policy_snapshot: '{"requiredChecks":[]}', created_at: now, updated_at: now,
        worker_status: 'running', worker_checkpoint: '{"step":"compose"}',
      }] })
      .mockResolvedValueOnce({ rows: [{
        candidate_id: 'candidate-1', revision: 1, digest_version: 1, base_oid: 'base', head_oid: 'head', tree_oid: 'tree',
        source_set_digest: 'sources', subject_digest: 'subject', policy_snapshot_digest: 'policy', policy_revision: 'policy-1',
        merge_method: 'squash', work_round: 2, created_at: now,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 'operation-1', operation_key: 'compose:1', kind: 'compose', state: 'succeeded',
        attempt_count: 1, receipt: '{"headOid":"abc"}', updated_at: now,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const host = hostWith(query, { kind: 'integration', workflowVersion: 3 });

    const projection = await loadIntegrationCandidateProjection(host, identity, 'task-1');

    expect(projection.candidate).toMatchObject({ id: 'candidate-1', currentRevision: 1, workRound: 2 });
    expect(projection.operations).toEqual([expect.objectContaining({
      id: 'operation-1', operationKey: 'compose:1', receipt: { headOid: 'abc' },
    })]);
    expect(projection.worker).toEqual({ status: 'running', checkpoint: { step: 'compose' } });
    expect(projection.history).toMatchObject({ includeHistory: false, total: 1, hasMore: false });
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('revision=$2'), ['candidate-1', 1]);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it('defaults to current revision and pages historical revisions only when explicitly requested', async () => {
    const now = new Date('2026-08-19T00:00:00.000Z');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 'candidate-1', integration_task_id: 'task-1', repository_id: 'repo-1', base_branch: 'main', branch: 'integration/task-1',
        state: 'merged', current_revision: 5, work_round: 1, version: 1, workflow_epoch: '1', lane_epoch: '1',
        policy_revision: 'policy', merge_method: 'squash', policy_snapshot: '{}', created_at: now, updated_at: now,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 5 }] })
      .mockResolvedValueOnce({ rows: [{ status: 'completed', last_error: 'skipped-by-policy: cleanup disabled', updated_at: now }] });
    const host = hostWith(query, { kind: 'integration', workflowVersion: 3 });

    const projection = await loadIntegrationCandidateProjection(host, identity, 'task-1', {
      includeHistory: true, page: 2, pageSize: 2,
    });

    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('LIMIT $2 OFFSET $3'), ['candidate-1', 2, 2]);
    expect(projection.history).toEqual({ includeHistory: true, page: 2, pageSize: 2, total: 5, hasMore: true });
    expect(projection.cleanup).toMatchObject({ outcome: 'skipped', reason: 'skipped-by-policy: cleanup disabled' });
  });
});
