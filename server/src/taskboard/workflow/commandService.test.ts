import { describe, expect, it, vi } from 'vitest';

import type {
  TaskBoardExecution,
  TaskBoardExecutionResolutionInput,
  TaskBoardTask,
} from '../../../../shared/src/types/taskboard.js';
import {
  assertReceiptBoundToExecution,
  assertReceiptIdentityBoundToExecution,
  completeRemediationAfterMerge,
  fenceTaskExecutions,
  insertResolution,
  loadWorkflowFacts,
} from './commandService.js';

const host = {
  tasksTable: 'tasks', executionsTable: 'executions', changesTable: 'changes',
  integrationSourcesTable: 'sources', remediationAttemptsTable: 'remediation_attempts', resolutionsTable: 'resolutions',
  cancellationOutboxTable: 'cancellations',
};

const task: TaskBoardTask = {
  id: 'task-1', boardId: 'board-1', identifier: 'TASK-1', kind: 'delivery',
  title: 'Task', description: '', status: 'in_review', priority: 'none', labels: [],
  sortOrder: 1, commentCount: 0, version: 4,
  createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
};
const execution: TaskBoardExecution = {
  id: 'execution-1', taskId: task.id, runId: 'run-1', sessionId: 'session-1',
  status: 'running', purpose: 'review', protocolVersion: 2, attemptId: 'attempt-1',
  requestedBy: 'alice', fenceEpoch: '2',
  createdAt: task.createdAt, updatedAt: task.updatedAt,
};
function resolution(resolutionId = '11111111-1111-4111-8111-111111111111'): TaskBoardExecutionResolutionInput {
  return {
    resolutionId,
    outcome: 'stale_subject',
    summary: 'subject changed',
    evidence: ['digest mismatch'],
    receipt: {
      schemaVersion: 2, taskId: task.id, runId: execution.runId,
      executionId: execution.id, attemptId: execution.attemptId,
      purpose: execution.purpose, workflowEpoch: '7', fenceEpoch: '2', taskVersion: task.version,
      changeSeq: '12', contractDigest: 'a'.repeat(64), policyRevision: 'none',
    },
  };
}

describe('workflow command service', () => {
  it('loads merge facts through a remediation attempt relation', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        expect(sql).toContain('FROM remediation_attempts');
        expect(sql).toContain('a.remediation_task_id=$1');
        return { rows: [{ merged: true }] };
      }),
    };
    await expect(loadWorkflowFacts(host, client as never, {
      id: 'remediation-1', mergedCommitOid: undefined,
    })).resolves.toEqual({ hasMergeFact: true });
  });

  it('merge-first remediation completion is a workflow command and idempotent', async () => {
    let taskStatus = 'ready_to_merge';
    let completedAt: string | null = null;
    let attemptState = 'active';
    let attemptResolvedAt: string | null = null;
    const changes: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT id,kind,status,completed_at')) {
          return { rows: [{ id: 'remediation-1', kind: 'remediation', status: taskStatus, completed_at: completedAt }] };
        }
        if (sql.includes('SELECT id,state')) {
          return { rows: [{ id: 'attempt-1', state: attemptState }] };
        }
        if (sql.includes('UPDATE tasks')) {
          if (taskStatus === 'done' && completedAt) return { rows: [] };
          taskStatus = 'done';
          completedAt = '2026-08-18T01:00:00.000Z';
          return { rows: [{ id: 'remediation-1' }] };
        }
        if (sql.includes('UPDATE remediation_attempts')) {
          if (attemptState === 'resolved' && attemptResolvedAt) return { rows: [] };
          attemptState = 'resolved';
          attemptResolvedAt = '2026-08-18T01:00:00.000Z';
          return { rows: [{ id: 'attempt-1' }] };
        }
        if (sql.includes('INSERT INTO changes')) changes.push(sql);
        return { rows: [], rowCount: 1 };
      }),
    };
    const input = {
      remediationTaskId: 'remediation-1', sourceId: 'source-1', attemptId: 'attempt-1',
      commandId: 'merge:source-1:remediation-1:merge-1', mergedCommitOid: 'merge-1',
    };
    await expect(completeRemediationAfterMerge(host, client as never, input)).resolves.toBe(true);
    await expect(completeRemediationAfterMerge(host, client as never, input)).resolves.toBe(false);
    expect(taskStatus).toBe('done');
    expect(completedAt).toBeTruthy();
    expect(attemptState).toBe('resolved');
    expect(attemptResolvedAt).toBeTruthy();
    expect(changes).toHaveLength(1);
  });

  it('stores one canonical Resolution, replays the same idempotency key, and rejects a second id', async () => {
    let stored: Record<string, unknown> | undefined;
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT execution_id,resolution_id,payload_digest')) return { rows: stored ? [stored] : [] };
        if (sql.includes('INSERT INTO resolutions')) {
          stored = { execution_id: execution.id, resolution_id: params?.[2], payload_digest: params?.[3] };
          return { rows: [{ resolution_id: params?.[2] }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    await expect(insertResolution(host, client as never, task, execution, resolution(), {
      applied: true, toStatus: 'in_review',
    })).resolves.toMatchObject({ replay: false });
    const reordered = resolution();
    reordered.receipt = {
      policyRevision: reordered.receipt.policyRevision,
      contractDigest: reordered.receipt.contractDigest,
      changeSeq: reordered.receipt.changeSeq,
      taskVersion: reordered.receipt.taskVersion,
      fenceEpoch: reordered.receipt.fenceEpoch,
      workflowEpoch: reordered.receipt.workflowEpoch,
      purpose: reordered.receipt.purpose,
      attemptId: reordered.receipt.attemptId,
      executionId: reordered.receipt.executionId,
      runId: reordered.receipt.runId,
      taskId: reordered.receipt.taskId,
      schemaVersion: reordered.receipt.schemaVersion,
    };
    await expect(insertResolution(host, client as never, task, execution, reordered, {
      applied: true, toStatus: 'in_review',
    })).resolves.toMatchObject({ replay: true });
    await expect(insertResolution(host, client as never, task, execution,
      resolution('22222222-2222-4222-8222-222222222222'), { applied: false }))
      .rejects.toMatchObject({ code: 'TASKBOARD_RESOLUTION_CONFLICT' });
  });

  it('accepts an older bound fence only for late-receipt audit, not for a current write', () => {
    const late = resolution();
    late.receipt.fenceEpoch = '1';
    expect(() => assertReceiptIdentityBoundToExecution(execution, late)).not.toThrow();
    expect(() => assertReceiptBoundToExecution(execution, late, '7')).toThrowError(
      expect.objectContaining({ code: 'TASKBOARD_CONTEXT_EXECUTION_MISMATCH' }),
    );
    late.receipt.runId = 'another-run';
    expect(() => assertReceiptIdentityBoundToExecution(execution, late)).toThrowError(
      expect.objectContaining({ code: 'TASKBOARD_CONTEXT_EXECUTION_MISMATCH' }),
    );
    late.receipt.runId = execution.runId;
    late.receipt.executionId = 'another-execution';
    expect(() => assertReceiptIdentityBoundToExecution(execution, late)).toThrowError(
      expect.objectContaining({ code: 'TASKBOARD_CONTEXT_EXECUTION_MISMATCH' }),
    );
  });

  it('fences terminal executions immediately and enqueues durable runtime cancellation', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('UPDATE executions')) {
          return { rows: [{ id: execution.id, run_id: execution.runId, task_id: task.id, fence_epoch: '3' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    await expect(fenceTaskExecutions(host, client as never, [task.id], 'merge_confirmed')).resolves.toBe(1);
    expect(statements[0]).toContain("SET status='cancelled'");
    expect(statements.some((sql) => sql.includes('INSERT INTO cancellations'))).toBe(true);
    expect(statements.some((sql) => sql.includes("'execution.superseded'"))).toBe(true);
  });
});
