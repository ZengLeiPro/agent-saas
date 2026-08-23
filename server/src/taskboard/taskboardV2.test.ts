import { describe, expect, it, vi } from 'vitest';

import { allowedActionsForRole, normalizeRepositoryConfig } from './boardFields.js';
import { resolveExecutionModelRef } from './executionFields.js';
import { rowToExecution, rowToTask } from './storeHelpers.js';
import { retireTaskboardResolutionSchema, runTaskboardV2Schema } from './v2Schema.js';
import { resolveExecutionContextWorkflowContract } from './executionContextContract.js';
import { resolveWorkflowContract } from './workflowContract.js';

const task = {
  id: 'task-1',
  boardId: 'board-1',
  identifier: 'TASK-1',
  title: '实现能力',
  description: '',
  kind: 'delivery' as const,
  status: 'todo' as const,
  priority: 'none' as const,
  labels: [],
  sortOrder: 1024,
  commentCount: 0,
  version: 1,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
};

describe('taskboard V2 contracts', () => {
  it('keeps role capabilities monotonic and viewer read-only', () => {
    expect(allowedActionsForRole('viewer')).toEqual(['board.read']);
    expect(allowedActionsForRole('editor')).toEqual(expect.arrayContaining(['comment.create', 'execution.trigger']));
    expect(allowedActionsForRole('editor')).not.toContain('task.transition');
    expect(allowedActionsForRole('maintainer')).toEqual(expect.arrayContaining([
      'task.transition',
      'integration.create',
      'integration.authorize',
      'integration.cancel',
    ]));
    expect(allowedActionsForRole('owner')).toEqual(expect.arrayContaining([
      'board.policy.update',
      'board.members.manage',
      'board.archive',
    ]));
  });

  it('normalizes GitHub repository identity on the server', () => {
    const input = {
      provider: 'github',
      repositoryId: 'client-controlled',
      owner: ' KaiYan ',
      name: ' Agent-SaaS ',
      baseBranch: ' main ',
      allowForkPullRequest: true,
    } as never;
    expect(normalizeRepositoryConfig(input)).toMatchObject({
      repositoryId: 'github:kaiyan/agent-saas',
      owner: 'KaiYan',
      name: 'Agent-SaaS',
      baseBranch: 'main',
      allowForkPullRequest: false,
    });
    expect(normalizeRepositoryConfig(input, 'tenant-a')).toMatchObject({
      repositoryId: 'github:tenant-a:kaiyan/agent-saas',
    });
  });

  it('resolves the locked execution model with the same task, stage, board priority', () => {
    const stageModels = { work: 'stage/work', review: 'stage/review' };

    expect(resolveExecutionModelRef(undefined, stageModels, 'board/default', 'work')).toBe('stage/work');
    expect(resolveExecutionModelRef('task/override', stageModels, 'board/default', 'review')).toBe('task/override');
    expect(resolveExecutionModelRef(undefined, stageModels, 'board/default', 'merge')).toBe('board/default');
    expect(resolveExecutionModelRef('task/legacy', stageModels, 'board/default', 'review', {
      review: 'task/review',
    })).toBe('task/review');
  });

  it('derives work, review and merge duties from one structured workflow contract', () => {
    const work = resolveWorkflowContract(task, 'work');
    const review = resolveWorkflowContract({ ...task, status: 'in_review' }, 'review');
    const merge = resolveWorkflowContract({
      ...task,
      kind: 'integration',
      status: 'in_progress',
    }, 'merge');

    expect(work.allowedStatuses).toEqual(['in_review', 'blocked']);
    expect(review.allowedStatuses).toEqual(['ready_to_merge', 'todo', 'in_review', 'blocked']);
    expect(merge.capabilities).toMatchObject({ mergeReviewedSource: true, createRemediation: true });
  });

  it('resolves an Integration v3 execution context contract from the current candidate state', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{ state: 'working' }] }));
    const contract = await resolveExecutionContextWorkflowContract(
      { integrationSourcesTable: 'runtime_taskboard_integration_sources' },
      { query } as never,
      { ...task, kind: 'integration', status: 'in_progress', workflowVersion: 3 },
      'work',
    );

    expect(contract).toMatchObject({ taskKind: 'integration', purpose: 'work' });
    expect(query.mock.calls[0]![0]).toContain('runtime_taskboard_integration_candidates');
  });

  it('treats a canceled integration source as historical and allows delivery reselection', () => {
    expect(rowToTask({
      id: task.id, board_id: task.boardId, identifier: task.identifier, kind: 'delivery',
      title: task.title, description: '', status: 'ready_to_merge', priority: 'none', labels: [],
      sort_order: 1, comment_count: 0, version: 2,
      provider_pull_request_id: '101', reviewed_subject_digest: 'digest-101', head_oid: 'head-101',
      provider_ci_status: 'success', provider_ci_purpose: 'review', provider_ci_head_oid: 'head-101',
      provider_ci_inspected_at: new Date().toISOString(),
      integration_source_id: 'source-old', integration_task_id: 'integration-old', integration_state: 'canceled',
      created_at: task.createdAt, updated_at: task.updatedAt,
    })).toMatchObject({ mergeEligibility: 'eligible', integrationState: 'canceled' });
  });

  it('keeps reviewed deliveries selectable after the stored CI inspection becomes old', () => {
    expect(rowToTask({
      id: task.id, board_id: task.boardId, identifier: task.identifier, kind: 'delivery',
      title: task.title, description: '', status: 'ready_to_merge', priority: 'none', labels: [],
      sort_order: 1, comment_count: 0, version: 2,
      provider_pull_request_id: '101', reviewed_subject_digest: 'digest-101', head_oid: 'head-101',
      provider_ci_status: 'success', provider_ci_purpose: 'review', provider_ci_head_oid: 'head-101',
      provider_ci_inspected_at: '2020-01-01T00:00:00.000Z',
      created_at: task.createdAt, updated_at: task.updatedAt,
    })).toMatchObject({ mergeEligibility: 'eligible' });
  });

  it('installs immutable change log, repository lane, saga and durable trigger schema', async () => {
    const sql: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        sql.push(text);
        return { rows: [] };
      }),
    };
    await runTaskboardV2Schema({
      boardsTable: 'tb_boards',
      tasksTable: 'tb_tasks',
      commentsTable: 'tb_comments',
      executionsTable: 'tb_executions',
      membersTable: 'tb_members',
      changesTable: 'tb_changes',
      attemptsTable: 'tb_attempts',
      integrationLanesTable: 'tb_lanes',
      integrationSourcesTable: 'tb_sources',
      mergeAuthorizationsTable: 'tb_authorizations',
      mergeOperationsTable: 'tb_operations',
      blockEpisodesTable: 'tb_blocks',
      integrationTriggerOutboxTable: 'tb_trigger_outbox',
      remediationAttemptsTable: 'tb_remediation_attempts',
      cancellationOutboxTable: 'tb_cancellation_outbox',
    }, client as never);
    await retireTaskboardResolutionSchema({ executionsTable: 'tb_executions' }, client as never);
    const ddl = sql.join('\n');

    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS resume_context JSONB');
    expect(ddl).toContain('CREATE OR REPLACE RULE tb_changes_no_update');
    expect(ddl).toContain('CREATE OR REPLACE RULE tb_changes_no_delete');
    expect(ddl).toContain('active_integration_task_id');
    expect(ddl).toContain("state IN ('prepared','executing','succeeded','failed','unknown','reconciled')");
    expect(ddl).toContain("trigger_mode IN ('scheduled','on_ready','manual')");
    expect(ddl).toContain("state NOT IN ('merged','canceled')");
    expect(ddl).toContain('provider_receipt JSONB');
    expect(ddl).toContain('TASKBOARD_ACTIVE_PR_DUPLICATES');
    expect(ddl).toContain('apr_uq');
    expect(ddl).toContain("terminal_reason_code=COALESCE(terminal_reason_code,'legacy_resolution_migrated')");
    expect(sql.at(-1)).toBe('COMMIT');
    expect(sql.lastIndexOf('BEGIN')).toBeGreaterThan(sql.findIndex((statement) => statement.includes('TASKBOARD_ACTIVE_PR_DUPLICATES')));
    expect(ddl).toContain('DROP TABLE IF EXISTS tb_resolutions');
    expect(ddl).toContain('DROP COLUMN IF EXISTS resolution_id');
    expect(ddl).toContain('DROP COLUMN IF EXISTS resolved_at');
  });

  it('rolls back retired protocol cleanup when a destructive statement fails', async () => {
    const sql: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        sql.push(text);
        if (text.includes('DROP COLUMN IF EXISTS resolution_id')) throw new Error('injected cleanup failure');
        return { rows: [] };
      }),
    };

    await expect(retireTaskboardResolutionSchema(
      { executionsTable: 'tb_executions' },
      client as never,
    )).rejects.toThrow('injected cleanup failure');
    expect(sql.at(-1)).toBe('ROLLBACK');
  });
});
