import { describe, expect, it, vi } from 'vitest';

import { createIntegrationBatch, type TaskboardV2StoreOptions } from './v2Store.js';

const identity = {
  tenantId: 'tenant-1',
  ownerUserId: 'owner-1',
  username: 'owner',
};

const repository = {
  provider: 'github' as const,
  repositoryId: 'github:acme/app',
  owner: 'acme',
  name: 'app',
  baseBranch: 'main',
  allowForkPullRequest: false,
};

describe('createIntegrationBatch', () => {
  it('creates integration tasks at the in-progress column tail', async () => {
    let tailQuery = '';
    let taskInsert = '';
    let taskInsertValues: unknown[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('FROM boards')) {
          return { rows: [{
            id: 'board-1',
            owner_user_id: identity.ownerUserId,
            version: 1,
            board_role: 'owner',
            repository,
            integration_policy: {
              enabled: true,
              revision: 'policy-1',
              workflowVersion: 2,
              trigger: { mode: 'manual', allowedRoles: ['owner'] },
            },
          }] };
        }
        if (sql.includes('FROM integration_lanes')) return { rows: [{ epoch: '0' }] };
        if (sql.includes('FROM tasks') && sql.includes('review.id AS review_execution_id')) {
          return { rows: [{
            id: 'delivery-1',
            identifier: 'TASK-1',
            kind: 'delivery',
            status: 'ready_to_merge',
            provider_pull_request_id: '42',
            reviewed_subject_digest: 'subject-1',
            provider_ci_status: 'success',
            provider_ci_purpose: 'review',
            provider_ci_head_oid: 'head-1',
            provider_ci_execution_id: 'review-1',
            head_oid: 'head-1',
            base_oid: 'base-1',
            review_execution_id: 'review-1',
          }] };
        }
        if (sql.includes('WHERE s.state NOT IN')) return { rows: [] };
        if (sql.includes('SET next_task_number=next_task_number+1')) return { rows: [{ task_number: 2 }] };
        if (sql.includes('MAX(sort_order)')) {
          tailQuery = sql;
          return { rows: [{ max_sort_order: 4096 }] };
        }
        if (sql.includes('INSERT INTO tasks')) {
          taskInsert = sql;
          taskInsertValues = values ?? [];
          throw new Error('stop after task insert');
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const options: TaskboardV2StoreOptions = {
      pool: { connect: async () => client as never, query: client.query },
      boardsTable: 'boards', tasksTable: 'tasks', commentsTable: 'comments', executionsTable: 'executions',
      membersTable: 'members', changesTable: 'changes', integrationLanesTable: 'integration_lanes',
      integrationSourcesTable: 'integration_sources', mergeAuthorizationsTable: 'merge_authorizations',
      mergeOperationsTable: 'merge_operations', blockEpisodesTable: 'block_episodes',
      integrationTriggerOutboxTable: 'integration_triggers', remediationAttemptsTable: 'remediation_attempts',
      cancellationOutboxTable: 'cancellation_outbox',
      repositoryProvider: {
        getPullRequest: vi.fn(async () => ({
          providerPullRequestId: '42', headOid: 'head-1', baseOid: 'base-1', subjectDigest: 'subject-1',
          state: 'open', draft: false, requiredChecksKnown: true, requiredChecks: [{ name: 'ci', status: 'success' }],
        })),
      } as never,
    };

    await expect(createIntegrationBatch(options, identity, 'board-1', {
      deliveryTaskIds: ['delivery-1'], expectedBoardVersion: 1,
    })).rejects.toThrow('stop after task insert');

    expect(tailQuery).toContain("status='in_progress'");
    expect(taskInsert).toContain("'in_progress'");
    expect(taskInsertValues[5]).toBe(5120);
  });
});
