import { describe, expect, it, vi } from 'vitest';

import {
  applyIntegrationV3Repair,
  changeIntegrationLaneOwner,
  requeueFailedIntegrationV3Candidate,
  scanIntegrationV3Invariants,
  type IntegrationV3RepairTables,
} from './integrationV3Repair.js';

const tables: IntegrationV3RepairTables = {
  tasks: 'tasks', executions: 'execs', lanes: 'lanes', candidates: 'candidates',
  providerOperations: 'operations', requestsOutbox: 'outbox',
};

function dbWithRows(...rows: Record<string, unknown>[][]) {
  return { query: vi.fn(async () => ({ rows: rows.shift() ?? [] })) } as any;
}

describe('integration v3 invariant repair', () => {
  it('classifies only provably terminal lane ownership as auto-repairable', async () => {
    const db = dbWithRows(
      [
        { repository_id: 'repo-safe', task_id: 'task-safe', epoch: '4', candidate_id: 'c-safe', candidate_state: 'merged', uncertain_operation: false },
        { repository_id: 'repo-unknown', task_id: 'task-unknown', epoch: '8', candidate_id: 'c-unknown', candidate_state: 'merging', uncertain_operation: true },
      ],
      [{ repository_id: 'repo-missing', task_id: 'task-missing', epoch: '2', task_status: 'in_progress' }],
      [], [], [],
    );

    const findings = await scanIntegrationV3Invariants(db, tables);

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-safe', disposition: 'auto_repair' }),
      expect.objectContaining({ taskId: 'task-unknown', disposition: 'needs_human' }),
      expect.objectContaining({ taskId: 'task-missing', disposition: 'needs_human' }),
    ]));
  });

  it('fences an epoch-mismatched execution without attempting provider work', async () => {
    const db = dbWithRows([{ id: 'execution-1' }]);
    const result = await applyIntegrationV3Repair(db, tables, {
      type: 'active_execution_epoch_mismatch', disposition: 'auto_repair', executionId: 'execution-1', detail: {},
    });

    expect(result.outcome).toBe('repaired');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("terminal_reason_code='integration_v3_epoch_mismatch'"), ['execution-1']);
  });

  it('turns an ambiguous provider result into needs_human and never retries it', async () => {
    const db = dbWithRows([{ id: 'operation-1' }]);
    const result = await applyIntegrationV3Repair(db, tables, {
      type: 'unknown_provider_operation', disposition: 'needs_human', operationId: 'operation-1', detail: { kind: 'merge_pull_request' },
    });

    expect(result.outcome).toBe('needs_human');
    expect(db.query.mock.calls[0]![0]).toContain("state='needs_human'");
    expect(db.query.mock.calls[0]![0]).not.toContain("state='prepared'");
  });

  it('returns only the exact incomplete legacy composition to composing and preserves its failed Work evidence', async () => {
    const db = dbWithRows([{
      id: 'candidate-legacy', integration_task_id: 'task-1',
      previous_error: 'Work request exhausted retries and requires operator recovery',
      recovery_kind: 'composition', outbox_id: 'work-request-legacy', status: 'idle',
    }], []);

    await expect(requeueFailedIntegrationV3Candidate(db, {
      tasks: 'tasks', candidates: 'candidates', revisions: 'revisions', requestsOutbox: 'outbox',
      changes: 'changes', blockEpisodes: 'block_episodes',
    }, {
      taskId: 'task-1', actorId: 'maintainer-1', reason: 'partial composition support deployed',
    })).resolves.toEqual({
      candidateId: 'candidate-legacy', taskId: 'task-1',
      previousError: 'Work request exhausted retries and requires operator recovery',
      recoveryKind: 'composition', outboxId: 'work-request-legacy', status: 'idle',
    });

    const recoverySql = String(db.query.mock.calls[0]![0]);
    expect(recoverySql).toContain("c.state='working' AND c.provider_pull_request_id IS NULL");
    expect(recoverySql).toContain("c.subject_kind='source_seed' AND c.composition_complete=FALSE AND c.tree_oid IS NULL");
    expect(recoverySql).toContain("o.last_error='Candidate execution workspace binding is stale'");
    expect(recoverySql).toContain("SET state='composing',worker_status='idle',worker_error=NULL,worker_attempts=0");
    expect(recoverySql).toContain("SET status='in_progress'");
    expect(recoverySql).toContain('block.closed_at IS NULL');
    expect(recoverySql).toContain('NOT EXISTS (SELECT 1 FROM composition_requeued)');
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining('integration.v3.worker_requeued'), [
      'task-1', 'maintainer-1', JSON.stringify({
        candidateId: 'candidate-legacy', reason: 'partial composition support deployed',
        previousError: 'Work request exhausted retries and requires operator recovery',
        recoveryKind: 'composition', outboxId: 'work-request-legacy',
      }),
    ]);
  });

  it('resumes a blocked pre-provider composition only from its durable composing checkpoint', async () => {
    const db = dbWithRows([{
      id: 'candidate-pre-provider', integration_task_id: 'task-1', previous_error: 'safe Git inspection rejected',
      recovery_kind: 'composition', outbox_id: null, status: 'idle',
    }], []);

    await expect(requeueFailedIntegrationV3Candidate(db, {
      tasks: 'tasks', candidates: 'candidates', revisions: 'revisions', requestsOutbox: 'outbox',
      changes: 'changes', blockEpisodes: 'block_episodes',
    }, {
      taskId: 'task-1', actorId: 'maintainer-1', reason: 'safe inspection fix deployed',
    })).resolves.toMatchObject({
      candidateId: 'candidate-pre-provider', taskId: 'task-1', recoveryKind: 'composition', status: 'idle',
    });

    const recoverySql = String(db.query.mock.calls[0]![0]);
    expect(recoverySql).toContain("current.state='blocked' AND current.provider_pull_request_id IS NULL");
    expect(recoverySql).toContain("current.worker_checkpoint->>'state'='composing'");
    expect(recoverySql).toContain("current.state NOT IN ('blocked','merged','canceled')");
  });

  it('requeues only a permanently failed nonterminal worker and writes the operator audit payload', async () => {
    const db = dbWithRows([{
      id: 'candidate-1', integration_task_id: 'task-1', previous_error: 'provider denied',
      recovery_kind: 'worker', outbox_id: 'work-request-1', status: 'idle',
    }], []);

    await expect(requeueFailedIntegrationV3Candidate(db, {
      tasks: 'tasks', candidates: 'candidates', revisions: 'revisions', requestsOutbox: 'outbox',
      changes: 'changes', blockEpisodes: 'block_episodes',
    }, {
      taskId: 'task-1', actorId: 'maintainer-1', reason: 'credentials repaired',
    })).resolves.toEqual({
      candidateId: 'candidate-1', taskId: 'task-1', previousError: 'provider denied', recoveryKind: 'worker',
      outboxId: 'work-request-1', status: 'idle',
    });

    const recoverySql = String(db.query.mock.calls[0]![0]);
    expect(recoverySql).toContain("current.worker_status='failed'");
    expect(recoverySql).toContain("current.state NOT IN ('blocked','merged','canceled')");
    expect(recoverySql).toContain("o.status='failed' AND o.lease_id IS NULL");
    expect(recoverySql).toContain("o.kind='work' AND c.state='working'");
    expect(recoverySql).toContain("o.kind='review' AND c.state='in_review'");
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining('integration.v3.worker_requeued'), [
      'task-1', 'maintainer-1', JSON.stringify({
        candidateId: 'candidate-1', reason: 'credentials repaired', previousError: 'provider denied', recoveryKind: 'worker',
        outboxId: 'work-request-1',
      }),
    ]);
  });

  it('requeues only the current failed cleanup for a terminal candidate without touching provider operations', async () => {
    const db = dbWithRows([{
      candidate_id: 'candidate-terminal', integration_task_id: 'task-1', previous_error: 'dirty worktree',
      recovery_kind: 'cleanup', outbox_id: 'cleanup-1', status: 'idle',
    }], []);

    await expect(requeueFailedIntegrationV3Candidate(db, {
      tasks: 'tasks', candidates: 'candidates', revisions: 'revisions', requestsOutbox: 'outbox',
      changes: 'changes', blockEpisodes: 'block_episodes',
    }, {
      taskId: 'task-1', actorId: 'maintainer-1', reason: 'worktree repaired',
    })).resolves.toEqual({
      candidateId: 'candidate-terminal', taskId: 'task-1', previousError: 'dirty worktree',
      recoveryKind: 'cleanup', outboxId: 'cleanup-1', status: 'idle',
    });

    const recoverySql = String(db.query.mock.calls[0]![0]);
    expect(recoverySql).toContain("c.state IN ('merged','canceled')");
    expect(recoverySql).toContain("o.kind='cleanup' AND o.status='failed'");
    expect(recoverySql).toContain('o.candidate_revision=c.current_revision');
    expect(recoverySql).toContain('o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch');
    expect(recoverySql).toContain("SET status='pending',attempts=0");
    expect(recoverySql).not.toContain('provider_operations');
    expect(recoverySql).not.toContain('merge_pull_request');
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining('integration.v3.worker_requeued'), [
      'task-1', 'maintainer-1', JSON.stringify({
        candidateId: 'candidate-terminal', reason: 'worktree repaired', previousError: 'dirty worktree',
        recoveryKind: 'cleanup', outboxId: 'cleanup-1',
      }),
    ]);
  });

  it('increments the lane epoch on both acquire and release CAS operations', async () => {
    const db = dbWithRows([{ epoch: '11' }], [{ epoch: '12' }]);
    await expect(changeIntegrationLaneOwner(db, 'lanes', {
      repositoryId: 'repo', expectedOwnerTaskId: null, nextOwnerTaskId: 'task',
    })).resolves.toEqual({ epoch: '11' });
    await expect(changeIntegrationLaneOwner(db, 'lanes', {
      repositoryId: 'repo', expectedOwnerTaskId: 'task', nextOwnerTaskId: null,
    })).resolves.toEqual({ epoch: '12' });
    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining('epoch=epoch+1'), ['repo', null, 'task']);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining('epoch=epoch+1'), ['repo', 'task', null]);
  });

  it('fails closed when a scan query is interrupted', async () => {
    const db = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('injected connection loss')) } as any;
    await expect(scanIntegrationV3Invariants(db, tables)).rejects.toThrow('injected connection loss');
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});
