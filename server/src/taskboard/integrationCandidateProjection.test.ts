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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 'operation-1', operation_key: 'compose:1', kind: 'compose', state: 'succeeded',
        attempt_count: 1, receipt: '{"headOid":"abc"}', updated_at: now,
      }] });
    const host = hostWith(query, { kind: 'integration', workflowVersion: 3 });

    const projection = await loadIntegrationCandidateProjection(host, identity, 'task-1');

    expect(projection.candidate).toMatchObject({ id: 'candidate-1', currentRevision: 1, workRound: 2 });
    expect(projection.operations).toEqual([expect.objectContaining({
      id: 'operation-1', operationKey: 'compose:1', receipt: { headOid: 'abc' },
    })]);
    expect(projection.worker).toEqual({ status: 'running', checkpoint: { step: 'compose' } });
    expect(query).toHaveBeenCalledTimes(4);
  });
});
