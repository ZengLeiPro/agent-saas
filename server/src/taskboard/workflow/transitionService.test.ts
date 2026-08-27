import { describe, expect, it, vi } from 'vitest';

import { finishExecutionV2 } from './transitionService.js';

const identity = { tenantId: 'tenant-1', ownerUserId: 'owner-1', username: 'owner' };
const now = new Date('2026-08-26T06:00:00.000Z');

function taskRow(status: 'in_progress' | 'done' | 'blocked') {
  return {
    id: 'integration-1', board_id: 'board-1', identifier: 'INT-1', kind: 'integration',
    title: 'Integration', description: '', attachments: [], status, priority: 'none', labels: [],
    sort_order: 1, stage_models: {}, workflow_version: 3, workflow_epoch: 1,
    next_action: 'none', next_action_revision: 0, comment_count: 0, version: 1,
    completed_at: status === 'done' ? now : null, created_at: now, updated_at: now,
  };
}

function loadedTaskRow(status: 'in_progress' | 'done' | 'blocked') {
  return {
    ...taskRow(status), actual_board_id: 'board-1', board_owner_user_id: 'owner-1',
    board_name: 'Board', board_description: '', board_visibility: 'personal', board_prompt: '',
    board_stage_prompts: {}, board_stage_models: {}, board_repository: { repositoryId: 'github:acme/app' },
    board_integration_policy: {}, board_version: 1, board_role: 'owner',
    board_created_at: now, board_updated_at: now,
  };
}

function executionRow(purpose: 'work' | 'review' | 'merge' = 'work') {
  return {
    id: 'execution-1', task_id: 'integration-1', run_id: 'run-1', session_id: 'session-1',
    status: 'running', purpose, trigger: 'initial', protocol_version: 2, requested_by: 'owner-1',
    fence_epoch: 0, created_at: now, updated_at: now,
  };
}

function options(client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }) {
  return {
    pool: { connect: vi.fn(async () => client) },
    boardsTable: 'boards', tasksTable: 'tasks', commentsTable: 'comments', executionsTable: 'executions',
    membersTable: 'members', changesTable: 'changes', integrationSourcesTable: 'sources',
    remediationAttemptsTable: 'remediation_attempts', integrationLanesTable: 'lanes',
    mergeAuthorizationsTable: 'authorizations', mergeOperationsTable: 'operations',
    blockEpisodesTable: 'blocks', integrationTriggerOutboxTable: 'triggers',
    cancellationOutboxTable: 'cancellations',
  } as never;
}

describe('single Integration Agent finish transition', () => {
  it('finishes work directly as done and closes sources without Review or Gateway evidence', async () => {
    let status: 'in_progress' | 'done' | 'blocked' = 'in_progress';
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT e.task_id') && sql.includes('JOIN boards')) {
        return { rows: [{ task_id: 'integration-1' }] };
      }
      if (sql.includes('SELECT t.*') && sql.includes('JOIN boards')) {
        return { rows: [loadedTaskRow(status)] };
      }
      if (sql.includes('SELECT e.*') && sql.includes('FOR UPDATE')) {
        return { rows: [executionRow()] };
      }
      if (sql.includes('INSERT INTO comments')) return { rows: [{ id: 'comment-1' }] };
      if (sql.includes('JOIN sources source') && sql.includes('FOR UPDATE OF delivery')) {
        return { rows: [{ id: 'delivery-1' }] };
      }
      if (sql.includes('UPDATE executions') && sql.includes("SET status='cancelled'")) {
        return { rows: [{ id: 'delivery-execution-1', run_id: 'delivery-run-1', task_id: 'delivery-1', fence_epoch: 2 }], rowCount: 1 };
      }
      if (sql.includes('UPDATE tasks') && sql.includes('SET status=$2') && values?.[0] === 'integration-1') {
        status = String(values[1]) as typeof status;
        return { rows: [] };
      }
      if (sql.includes('UPDATE executions') && sql.includes('transitioned_at=now()')) {
        return { rows: [{ id: 'execution-1' }] };
      }
      if (sql.includes('SELECT t.*') && sql.includes('FROM tasks t WHERE')) {
        return { rows: [taskRow(status)] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };

    await expect(finishExecutionV2(options(client), identity, 'run-1', {
      targetStatus: 'done', body: 'GitHub 已合并，本批次资源已安全清理。',
    })).resolves.toMatchObject({ kind: 'integration', status: 'done' });

    const sql = query.mock.calls.map(([text]) => String(text)).join('\n');
    expect(sql).toContain("SET state='merged'");
    expect(sql).toContain("SET status='done'");
    expect(sql).toContain("SET status='cancelled'");
    expect(sql).toContain('FOR UPDATE OF delivery');
    expect(sql.indexOf('FOR UPDATE OF delivery')).toBeLessThan(sql.indexOf("SET status='cancelled'"));
    expect(sql).toContain('INSERT INTO cancellations');
    expect(sql).toContain("change_type");
    expect(sql).not.toContain('reviewed_subject_digest');
    expect(sql).not.toContain('provider_ci_status');
    expect(sql).not.toContain('merge_receipt');
  });

  it('accepts blocked only from the same work execution and records an operator handoff', async () => {
    let status: 'in_progress' | 'done' | 'blocked' = 'in_progress';
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT e.task_id')) return { rows: [{ task_id: 'integration-1' }] };
      if (sql.includes('SELECT t.*') && sql.includes('JOIN boards')) return { rows: [loadedTaskRow(status)] };
      if (sql.includes('SELECT e.*') && sql.includes('FOR UPDATE')) return { rows: [executionRow()] };
      if (sql.includes('INSERT INTO comments')) return { rows: [{ id: 'comment-1' }] };
      if (sql.includes('UPDATE tasks') && sql.includes('SET status=$2') && values?.[0] === 'integration-1') {
        status = String(values[1]) as typeof status;
        return { rows: [] };
      }
      if (sql.includes('UPDATE executions') && sql.includes('transitioned_at=now()')) return { rows: [{ id: 'execution-1' }] };
      if (sql.includes('SELECT t.*') && sql.includes('FROM tasks t WHERE')) return { rows: [taskRow(status)] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };

    await expect(finishExecutionV2(options(client), identity, 'run-1', {
      targetStatus: 'blocked', body: '需要用户决定是否保留存在未合并提交的来源分支。',
    })).resolves.toMatchObject({ status: 'blocked' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO blocks'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET state='merged'"))).toBe(false);
  });
});
