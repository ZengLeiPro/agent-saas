import { describe, expect, it, vi } from 'vitest';

import { allowedActionsForRole, normalizeRepositoryConfig } from './boardFields.js';
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
    }, client as never);
    const ddl = sql.join('\n');

    expect(ddl).toContain('CREATE OR REPLACE RULE tb_changes_no_update');
    expect(ddl).toContain('CREATE OR REPLACE RULE tb_changes_no_delete');
    expect(ddl).toContain('active_integration_task_id');
    expect(ddl).toContain("state IN ('prepared','executing','succeeded','failed','unknown','reconciled')");
    expect(ddl).toContain("trigger_mode IN ('scheduled','on_ready','manual')");
    expect(ddl).toContain("state NOT IN ('merged','canceled')");
    expect(ddl).toContain('provider_receipt JSONB');
  });
});
