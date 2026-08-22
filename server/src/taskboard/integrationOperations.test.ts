import { describe, expect, it, vi } from 'vitest';

import type { RepositoryProvider, RepositoryPullRequestSnapshot } from './repositoryProvider.js';
import {
  finalizeMergedSource,
  inspectIntegrationSource,
  linkIntegrationRemediation,
  mergeIntegrationSource,
} from './integrationOperations.js';

const sourceRow = {
  id: 'source-1', integration_task_id: 'integration-1', delivery_task_id: 'delivery-1',
  repository_id: 'repo-1', provider_pull_request_id: '101', reviewed_subject_digest: 'digest-reviewed',
  source_order: 0, state: 'ready', attempt_count: 0, remediation_count: 1,
  created_at: '2026-08-18T00:00:00.000Z', updated_at: '2026-08-18T00:00:00.000Z',
};
const contextRow = {
  ...sourceRow, execution_id: 'execution-1', purpose: 'merge', execution_status: 'running',
  resolved_at: null, superseded_at: null, integration_task_id_actual: 'integration-1',
  integration_status: 'in_progress', tenant_id: 'tenant-1', owner_user_id: 'owner-1',
  repository: { provider: 'github', repositoryId: 'repo-1', owner: 'acme', name: 'repo', baseBranch: 'main', allowForkPullRequest: false },
  integration_policy: {
    revision: 'policy-1', execution: {
      mergeMethod: 'merge', requireGreenChecks: true, maxAutomaticRemediationRounds: 3, maxTransientRetries: 3,
    },
  },
  active_integration_task_id: 'integration-1', epoch: '4', authorization_id: 'auth-1',
  authorization_policy_revision: 'policy-1', revoked_at: null, expires_at: null,
};
const pull: RepositoryPullRequestSnapshot = {
  providerPullRequestId: '101', number: 101, state: 'open', draft: false,
  headRef: 'feature', headOid: 'head-1', baseRef: 'main', baseOid: 'base-1',
  mergeable: true, requiredChecks: [{ name: 'ci', status: 'success' }], requiredChecksKnown: true,
  subjectDigest: 'digest-reviewed',
};
const identity = { tenantId: 'tenant-1', ownerUserId: 'owner-1', username: 'owner' };

function host(client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }, provider?: RepositoryProvider) {
  const guardedClient = {
    ...client,
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("change_type='pull_request.inspected'")) {
        return { rows: [{ payload: {
          receipt: {
            executionId: 'execution-1', taskId: 'integration-1', sourceId: 'source-1',
            providerPullRequestId: '101', headOid: 'head-1',
          },
          snapshot: pull,
        } }] };
      }
      return (client.query as unknown as (
        text: string, parameters?: unknown[],
      ) => Promise<{ rows: Record<string, unknown>[] }>)(sql, values);
    }),
  };
  return {
    pool: { connect: vi.fn(async () => guardedClient) }, boardsTable: 'boards', tasksTable: 'tasks',
    commentsTable: 'comments', executionsTable: 'executions', changesTable: 'changes',
    integrationLanesTable: 'lanes', integrationSourcesTable: 'sources', mergeAuthorizationsTable: 'auths',
    mergeOperationsTable: 'operations', blockEpisodesTable: 'blocks', remediationAttemptsTable: 'attempts',
    resolutionsTable: 'resolutions', cancellationOutboxTable: 'cancellations', repositoryProvider: provider,
  } as unknown as Parameters<typeof mergeIntegrationSource>[0];
}

describe('integration operation guards', () => {
  it('revalidates execution/source/authorization/lane after prepare and before provider merge', async () => {
    const statements: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('e.id AS execution_id')) return { rows: [contextRow] };
        if (sql.includes('SELECT state, reviewed_subject_digest')) return { rows: [{ state: 'ready', reviewed_subject_digest: 'digest-reviewed' }] };
        if (sql.includes('SELECT * FROM operations')) return { rows: [] };
        if (sql.includes('INSERT INTO operations')) return { rows: [{
          id: 'operation-1', integration_source_id: 'source-1', authorization_id: 'auth-1',
          state: 'prepared', provider_request_id: 'operation-1',
        }] };
        if (sql.includes('SELECT s.integration_task_id') && sql.includes('FROM operations')) return { rows: [{ integration_task_id: 'integration-1' }] };
        if (sql.includes('SELECT id,state,integration_task_id,repository_id')) return { rows: [{
          id: 'source-1', state: 'merging', integration_task_id: 'integration-1', repository_id: 'repo-1',
        }] };
        if (sql.includes('UPDATE operations o')) return { rows: [] };
        return { rows: [], rowCount: 1 };
      }),
    };
    const provider: RepositoryProvider = {
      getPullRequest: vi.fn(async () => pull),
      mergePullRequest: vi.fn(),
    };

    await expect(mergeIntegrationSource(host(client, provider), identity, 'run-1', 'source-1'))
      .rejects.toMatchObject({ code: 'TASKBOARD_PROVIDER_GUARD_STALE' });
    expect(provider.mergePullRequest).not.toHaveBeenCalled();
    expect(statements.some((sql) => sql.includes("a.revoked_at IS NULL"))).toBe(true);
    expect(statements.some((sql) => sql.includes('l.epoch=$8::bigint'))).toBe(true);
  });

  it('does not move the source pointer when a remediation task belongs to another source', async () => {
    const statements: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT integration_task_id,delivery_task_id')) return { rows: [{
          integration_task_id: 'integration-1', delivery_task_id: 'delivery-1',
        }] };
        if (sql.includes('SELECT s.*, i.board_id')) return { rows: [{
          ...sourceRow, state: 'resolving_conflict', remediation_task_id: null,
          integration_board_id: 'board-1', remediation_board_id: 'board-1', remediation_kind: 'remediation',
          remediation_status: 'todo',
        }] };
        if (sql.includes('SELECT id AS execution_id')) return { rows: [{
          execution_id: 'execution-1', purpose: 'merge', execution_status: 'running',
          resolved_at: null, superseded_at: null,
        }] };
        if (sql.includes('INSERT INTO attempts')) return { rows: [] };
        if (sql.includes('FROM attempts') && sql.includes('remediation_task_id=$1')) return { rows: [{
          id: 'attempt-other', integration_source_id: 'source-other', round: 1,
          remediation_task_id: 'remediation-1',
        }] };
        return { rows: [], rowCount: 1 };
      }),
    };

    await expect(linkIntegrationRemediation(host(client), identity, 'run-1', 'source-1', 'remediation-1'))
      .rejects.toMatchObject({ code: 'TASKBOARD_REMEDIATION_LINK_CONFLICT' });
    expect(statements.some((sql) => sql.includes("SET remediation_task_id=$2"))).toBe(false);
    const sourceLock = statements.findIndex((sql) => sql.includes('SELECT s.*, i.board_id') && sql.includes('FOR UPDATE OF s'));
    const executionLock = statements.findIndex((sql) => sql.includes('SELECT id AS execution_id') && sql.includes('FOR UPDATE'));
    expect(sourceLock).toBeGreaterThanOrEqual(0);
    expect(executionLock).toBeGreaterThan(sourceLock);
  });

  it('does not regress a source when a merge fact appears during provider inspection', async () => {
    const statements: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('e.id AS execution_id')) return { rows: [contextRow] };
        if (sql.includes('SET state=$2')) return { rows: [] };
        if (sql.includes('SELECT * FROM sources WHERE id=$1')) return { rows: [{
          ...sourceRow, state: 'merged', provider_receipt_id: 'receipt-1', merged_commit_oid: 'merge-1',
        }] };
        return { rows: [], rowCount: 1 };
      }),
    };
    const provider: RepositoryProvider = {
      getPullRequest: vi.fn(async () => pull),
      mergePullRequest: vi.fn(),
    };

    await expect(inspectIntegrationSource(host(client, provider), identity, 'run-1', 'source-1'))
      .resolves.toMatchObject({ source: { state: 'merged', mergedCommitOid: 'merge-1' } });
    const guardedUpdate = statements.find((sql) => sql.includes('SET state=$2'));
    expect(guardedUpdate).toContain("state<>'merged'");
    expect(guardedUpdate).toContain('merged_commit_oid IS NULL');
    expect(guardedUpdate).toContain('provider_receipt_id IS NULL');
  });

  it('required checks failure requests remediation without consuming a round', async () => {
    const statements: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('e.id AS execution_id')) return { rows: [contextRow] };
        return { rows: [], rowCount: 1 };
      }),
    };
    const provider: RepositoryProvider = {
      getPullRequest: vi.fn(async () => ({ ...pull, requiredChecks: [{ name: 'ci', status: 'failure' as const }] })),
      mergePullRequest: vi.fn(),
    };

    await expect(mergeIntegrationSource(host(client, provider), identity, 'run-1', 'source-1'))
      .rejects.toMatchObject({ code: 'TASKBOARD_CHECKS_FAILED' });
    const conflictUpdate = statements.find((sql) => sql.includes('UPDATE sources'));
    expect(conflictUpdate).toContain("SET state=$2, remediation_task_id=NULL");
    expect(conflictUpdate).not.toContain('remediation_count=remediation_count+1');
    expect(provider.mergePullRequest).not.toHaveBeenCalled();
  });

  it('acquires the delivery Task lock before changing a stale source', async () => {
    const statements: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('e.id AS execution_id')) return { rows: [contextRow] };
        if (sql.includes('SELECT delivery_task_id FROM sources')) return { rows: [{ delivery_task_id: 'delivery-1' }] };
        if (sql.includes("SET state='re_reviewing'")) return { rows: [{ ...sourceRow, state: 're_reviewing' }] };
        return { rows: [], rowCount: 1 };
      }),
    };
    const provider: RepositoryProvider = {
      getPullRequest: vi.fn(async () => ({ ...pull, subjectDigest: 'digest-new' })),
      mergePullRequest: vi.fn(),
    };

    await expect(mergeIntegrationSource(host(client, provider), identity, 'run-1', 'source-1'))
      .rejects.toMatchObject({ code: 'TASKBOARD_SUBJECT_STALE' });
    const taskLock = statements.findIndex((sql) => sql.includes('SELECT id FROM tasks') && sql.includes('FOR UPDATE'));
    const sourceUpdate = statements.findIndex((sql) => sql.includes("SET state='re_reviewing'"));
    expect(taskLock).toBeGreaterThanOrEqual(0);
    expect(sourceUpdate).toBeGreaterThan(taskLock);
  });

  it('revalidates review binding in Task -> Source -> Execution lock order', async () => {
    const statements: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT delivery_task_id,integration_task_id,remediation_task_id')) {
          return { rows: [{ delivery_task_id: 'delivery-1', integration_task_id: 'integration-1', remediation_task_id: null }] };
        }
        if (sql.includes('SELECT DISTINCT remediation_task_id')) return { rows: [] };
        if (sql.includes('SELECT * FROM sources WHERE id=$1 FOR UPDATE')) return { rows: [sourceRow] };
        if (sql.includes('SELECT provider_pull_request_id FROM tasks')) {
          return { rows: [{ provider_pull_request_id: '101' }] };
        }
        if (sql.includes('SELECT id FROM executions') && sql.includes('FOR UPDATE')) return { rows: [] };
        return { rows: [], rowCount: 1 };
      }),
    };

    await expect(finalizeMergedSource(host(client), 'source-1', {
      providerRequestId: 'external-merge:delivery-1:merge-1',
      mergedCommitOid: 'merge-1',
      raw: { reconciled: true },
      expectedReview: {
        deliveryTaskId: 'delivery-1',
        providerPullRequestId: '101',
        executionId: 'review-1',
      },
    })).rejects.toThrow('Taskboard execution changed');
    const taskLock = statements.findIndex((sql) => sql.includes('SELECT id FROM tasks') && sql.includes('FOR UPDATE'));
    const sourceLock = statements.findIndex((sql) => sql.includes('SELECT * FROM sources') && sql.includes('FOR UPDATE'));
    const executionLock = statements.findIndex((sql) => sql.includes('SELECT id FROM executions') && sql.includes('FOR UPDATE'));
    expect(taskLock).toBeGreaterThanOrEqual(0);
    expect(sourceLock).toBeGreaterThan(taskLock);
    expect(executionLock).toBeGreaterThan(sourceLock);
  });
});
