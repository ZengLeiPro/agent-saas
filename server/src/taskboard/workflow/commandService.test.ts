import { describe, expect, it, vi } from 'vitest';
import { fenceTaskExecutions, loadWorkflowFacts } from './commandService.js';

describe('workflow command service', () => {
  it('loads merge facts from task/source state', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ merged: true }] })) };
    await expect(loadWorkflowFacts({ integrationSourcesTable: 'sources', remediationAttemptsTable: 'attempts' }, client as never, { id: 'task', mergedCommitOid: undefined })).resolves.toEqual({ hasMergeFact: true });
  });
  it('fences active executions and writes cancellation audit', async () => {
    const client = { query: vi.fn(async (sql: string) => sql.startsWith('UPDATE executions')
      ? { rows: [{ id: 'e1', run_id: 'r1', task_id: 't1', fence_epoch: 2 }], rowCount: 1 }
      : { rows: [], rowCount: 1 }) };
    await expect(fenceTaskExecutions({ tasksTable: 'tasks', executionsTable: 'executions', changesTable: 'changes', integrationSourcesTable: 'sources', remediationAttemptsTable: 'attempts', cancellationOutboxTable: 'outbox' }, client as never, ['t1'], 'superseded')).resolves.toBe(1);
  });
});
