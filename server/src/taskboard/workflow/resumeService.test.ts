import { describe, expect, it, vi } from 'vitest';

import { resumeBlockedTask } from './resumeService.js';

const identity = { tenantId: 'tenant-1', ownerUserId: 'owner-1', username: 'owner' };

function loadedTask(workflowVersion: 2 | 3, kind: 'integration' | 'advisory' = 'integration') {
  return {
    id: 'task-1', board_id: 'board-1', identifier: 'TASK-1', kind, title: 'Task', description: '',
    attachments: [], status: 'todo', priority: 'none', labels: [], sort_order: 1, stage_models: {}, version: 1,
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
  it('resumes from a locked blocked candidate even when the task projection is still todo', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('JOIN boards b') && sql.includes('FOR UPDATE OF t')) return { rows: [loadedTask(3)] };
      if (sql.includes('SELECT b.*') && sql.includes('FROM boards b')) return { rows: [{ id: 'board-1', board_role: 'owner' }] };
      if (sql.includes('AS merged')) return { rows: [{ merged: false }] };
      if (sql.includes('SELECT * FROM integration_candidates')) return { rows: [{
        id: 'candidate-1', repository_id: 'repo-1', state: 'blocked', current_revision: 1, work_round: 2,
      }] };
      if (sql.includes('UPDATE lanes')) return { rows: [{ epoch: 7 }] };
      if (sql.includes('SELECT purpose FROM blocks')) return { rows: [{ purpose: 'work' }] };
      if (sql.includes('UPDATE integration_candidates')) return { rows: [{
        id: 'candidate-1', state: 'blocked', current_revision: 1, work_round: 2, workflow_epoch: 4, lane_epoch: 7,
      }] };
      if (sql.includes('FROM tasks t WHERE t.id=$1')) return { rows: [loadedTask(3)] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    await expect(resumeBlockedTask(options(client), identity, 'task-1', {
      expectedVersion: 1, decision: 'reconcile workspace',
    })).resolves.toMatchObject({ id: 'task-1', status: 'todo', workflowVersion: 3 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("state IN ('blocked','needs_human') FOR UPDATE"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("'workspace_sync'"))).toBe(true);
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
    expect(query.mock.calls.some(([sql]) => String(sql).includes('SELECT * FROM integration_candidates'))).toBe(false);
  });

  it('retains the legacy requirement that the task projection itself is blocked', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('JOIN boards b') && sql.includes('FOR UPDATE OF t')) return { rows: [loadedTask(2, 'advisory')] };
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
