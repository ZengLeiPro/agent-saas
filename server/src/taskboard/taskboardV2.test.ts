import { describe, expect, it, vi } from 'vitest';

import { allowedActionsForRole, normalizeRepositoryConfig } from './boardFields.js';
import { resolveExecutionModelRef } from './executionFields.js';
import { rowToExecution, rowToTask } from './storeHelpers.js';
import { runTaskboardV2Schema } from './v2Schema.js';
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
  });

  it('derives work, review and merge duties from one structured workflow contract', () => {
    const work = resolveWorkflowContract(task, 'work');
    const review = resolveWorkflowContract({ ...task, status: 'in_review' }, 'review');
    const merge = resolveWorkflowContract({
      ...task,
      kind: 'integration',
      status: 'in_progress',
    }, 'merge');

    expect(work.allowedOutcomes).toEqual(['ready_for_review', 'blocked']);
    expect(review.allowedOutcomes).toEqual(['approved', 'changes_requested', 'stale_subject', 'blocked']);
    expect(merge.capabilities).toMatchObject({ mergeReviewedSource: true, createRemediation: true, deploy: false });
    expect(new Set([work.digest, review.digest, merge.digest]).size).toBe(3);
  });

  it('treats a canceled integration source as historical and allows delivery reselection', () => {
    expect(rowToTask({
      id: task.id, board_id: task.boardId, identifier: task.identifier, kind: 'delivery',
      title: task.title, description: '', status: 'ready_to_merge', priority: 'none', labels: [],
      sort_order: 1, comment_count: 0, version: 2,
      provider_pull_request_id: '101', reviewed_subject_digest: 'digest-101',
      integration_source_id: 'source-old', integration_task_id: 'integration-old', integration_state: 'canceled',
      created_at: task.createdAt, updated_at: task.updatedAt,
    })).toMatchObject({ mergeEligibility: 'eligible', integrationState: 'canceled' });
  });

  it('projects legacy Resolution anomalies explicitly instead of showing them as missing', () => {
    const base = {
      id: 'execution-1', task_id: task.id, run_id: 'run-1', session_id: 'session-1',
      status: 'succeeded', purpose: 'work', requested_by: 'alice',
      created_at: task.createdAt, updated_at: task.updatedAt,
    };
    expect(rowToExecution({ ...base, legacy_resolution_count: 2, legacy_resolution_valid_count: 2 }))
      .toMatchObject({ resolutionState: 'legacy_ambiguous', resolutionIssue: expect.stringContaining('2 条') });
    expect(rowToExecution({ ...base, legacy_resolution_count: 1, legacy_resolution_valid_count: 0 }))
      .toMatchObject({ resolutionState: 'legacy_incomplete' });
    expect(rowToExecution({
      ...base, has_resolution: true, resolution_historical: true,
      resolution_id: 'historical:1', resolution_outcome: 'completed',
    })).toMatchObject({ resolutionState: 'historical', resolutionOutcome: 'completed' });
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
      resolutionsTable: 'tb_resolutions',
      remediationAttemptsTable: 'tb_remediation_attempts',
      cancellationOutboxTable: 'tb_cancellation_outbox',
    }, client as never);
    const ddl = sql.join('\n');

    expect(ddl).toContain('CREATE OR REPLACE RULE tb_changes_no_update');
    expect(ddl).toContain('CREATE OR REPLACE RULE tb_changes_no_delete');
    expect(ddl).toContain('active_integration_task_id');
    expect(ddl).toContain("state IN ('prepared','executing','succeeded','failed','unknown','reconciled')");
    expect(ddl).toContain("trigger_mode IN ('scheduled','on_ready','manual')");
    expect(ddl).toContain("state NOT IN ('merged','canceled')");
    expect(ddl).toContain('provider_receipt JSONB');
    expect(ddl).toContain('TASKBOARD_ACTIVE_PR_DUPLICATES');
    expect(ddl).toContain('apr_uq');
    expect(ddl).toContain('historical_projection');
  });
});
