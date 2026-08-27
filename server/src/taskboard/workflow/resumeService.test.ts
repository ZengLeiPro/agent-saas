import { describe, expect, it, vi } from 'vitest';

import { resumeBlockedTask } from './resumeService.js';

const identity = { tenantId: 'tenant-1', ownerUserId: 'owner-1', username: 'owner' };

function loadedTask(
  workflowVersion: 2 | 3,
  kind: 'integration' | 'advisory' = 'integration',
  status: 'blocked' | 'todo' | 'in_progress' = 'blocked',
) {
  return {
    id: 'task-1', board_id: 'board-1', identifier: 'TASK-1', kind, title: 'Task', description: '',
    attachments: [], status, priority: 'none', labels: [], sort_order: 1, stage_models: {}, version: 1,
    workflow_version: workflowVersion, workflow_epoch: 1, next_action: 'none', next_action_revision: 0,
    created_at: new Date(), updated_at: new Date(), comment_count: 0,
    actual_board_id: 'board-1', board_owner_user_id: 'owner-1', board_name: 'Board', board_description: '',
    board_visibility: 'private', board_prompt: '', board_stage_prompts: {}, board_stage_models: {},
    board_version: 1, board_role: 'owner', board_created_at: new Date(), board_updated_at: new Date(),
  };
}

function options(client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }) {
  return {
    pool: { connect: vi.fn(async () => client) }, tasksTable: 'tasks', boardsTable: 'boards', membersTable: 'members',
    commentsTable: 'comments', changesTable: 'changes', executionsTable: 'executions', integrationSourcesTable: 'integration',
    remediationAttemptsTable: 'remediation', integrationLanesTable: 'lanes', blockEpisodesTable: 'blocks',
  } as never;
}

describe('Workflow v3 blocked resume authority', () => {
  it('fails closed for v2 integration before workflow/source/task mutations', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('JOIN boards b') && sql.includes('FOR UPDATE OF t')) return { rows: [loadedTask(2)] };
      if (sql.includes('SELECT b.*') && sql.includes('FROM boards b')) return { rows: [{ id: 'board-1', board_role: 'owner' }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };

    await expect(resumeBlockedTask(options(client), identity, 'task-1', {
      expectedVersion: 1, decision: 'must migrate first', sourceIds: ['legacy-source'],
    })).rejects.toMatchObject({ code: 'TASKBOARD_INTEGRATION_MIGRATION_REQUIRED' });
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toEqual(expect.arrayContaining([
      expect.stringContaining('UPDATE integration'),
      expect.stringContaining('UPDATE tasks'),
      expect.stringContaining('INSERT INTO changes'),
    ]));
  });
  it('still rejects a v3 resume when a merge fact exists', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('JOIN boards b') && sql.includes('FOR UPDATE OF t')) return { rows: [loadedTask(3)] };
      if (sql.includes('SELECT b.*') && sql.includes('FROM boards b')) return { rows: [{ id: 'board-1', board_role: 'owner' }] };
      if (sql.includes('AS merged')) return { rows: [{ merged: true }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    await expect(resumeBlockedTask(options(client), identity, 'task-1', {
      expectedVersion: 1, decision: 'must not resume merged work',
    })).rejects.toMatchObject({ code: 'TASKBOARD_RESUME_INVALID' });
  });

  it('clears obsolete merge-in-flight fields and resumes the same durable Agent', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('JOIN boards b') && sql.includes('FOR UPDATE OF t')) return { rows: [loadedTask(3)] };
      if (sql.includes('SELECT b.*') && sql.includes('FROM boards b')) return { rows: [{ id: 'board-1', board_role: 'owner' }] };
      if (sql.includes('AS merged')) return { rows: [{ merged: false }] };
      if (sql.includes('UPDATE integration_agents')) return { rows: [{ integration_task_id: 'task-1' }] };
      if (sql.includes('FROM tasks t WHERE')) return { rows: [{ ...loadedTask(3, 'integration', 'in_progress'), comment_count: 0 }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };

    await expect(resumeBlockedTask(options(client), identity, 'task-1', {
      expectedVersion: 1, decision: '保留有未合并提交的分支并继续',
    })).resolves.toMatchObject({ status: 'in_progress' });
    const resumeSql = query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('UPDATE integration_agents'))!;
    expect(resumeSql).toContain('merge_in_flight_execution_id=NULL');
    expect(resumeSql).not.toContain('merge_in_flight_execution_id IS NULL');
    const taskSql = query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes("SET status='in_progress'"))!;
    expect(taskSql).toContain('resume_context=jsonb_build_object');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE blocks SET closed_at=now()'))).toBe(true);
  });

  it('retains the legacy requirement that the task projection itself is blocked', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('JOIN boards b') && sql.includes('FOR UPDATE OF t')) return { rows: [loadedTask(2, 'advisory', 'todo')] };
      if (sql.includes('SELECT b.*') && sql.includes('FROM boards b')) return { rows: [{ id: 'board-1', board_role: 'owner' }] };
      if (sql.includes('AS merged')) return { rows: [{ merged: false }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    await expect(resumeBlockedTask(options(client), identity, 'task-1', {
      expectedVersion: 1, decision: 'legacy task is not blocked',
    })).rejects.toMatchObject({ code: 'TASKBOARD_RESUME_INVALID' });
  });
});
