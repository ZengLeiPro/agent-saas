import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { integrationCandidateTableNames } from '../taskboard/integrationCandidateSchema.js';
import { PostgresIntegrationV3ActivationStore } from '../taskboard/integrationV3ActivationStore.js';
import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';
import { seedSuccessfulReviewCi } from './taskboardCiPgTestHelpers.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;
const identity: TaskboardIdentity = {
  tenantId: 'tenant-v3-provider', ownerUserId: 'v3-provider-owner', username: 'v3-provider-owner',
};

describePg('Workflow v3 Provider admission (PostgreSQL)', () => {
  const prefix = `tbv3p_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
    const tables = integrationCandidateTableNames(store.integrationSourcesTable);
    await new PostgresIntegrationV3ActivationStore(pool, tables.activationHeartbeatsTable).heartbeat({
      processIdentity: `test:${randomUUID()}`, releaseIdentity: 'test-release',
      processRole: 'runtime-worker', status: 'healthy',
    });
    store.setIntegrationV3RepositoryProbe(async () => true);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      const tables = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE $1`, [`${prefix}%`],
      );
      for (const row of tables.rows) await pool.query(`DROP TABLE IF EXISTS ${String(row.tablename)} CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('uses the dedicated v3 Provider instead of legacy OAuth for source admission', async () => {
    const board = await store.createBoard(identity, {
      name: 'V3 dedicated Provider',
      repository: {
        provider: 'github', repositoryId: 'github:acme/v3-provider', owner: 'acme', name: 'v3-provider',
        baseBranch: 'main', allowForkPullRequest: false,
      },
      integrationPolicy: {
        schemaVersion: 1, enabled: true, revision: 'normalized-by-server', workflowVersion: 3,
        featureFlags: { engineV3: true, compose: true, review: true, merge: true, cleanup: true, workspaceSync: true },
        trigger: { mode: 'manual', allowedRoles: ['owner'] },
        batch: { maxTasks: 5, selection: 'priority_then_ready_at' },
        execution: {
          mergeMethod: 'merge', continueIndependentSources: true, autoResolveConflicts: true,
          maxAutomaticRemediationRounds: 1, maxTransientRetries: 1, requireGreenChecks: true,
          deleteRemoteBranch: false, deploy: false,
        },
      },
    });
    const legacyGetPullRequest = vi.fn(async () => { throw new Error('legacy OAuth Provider must not be used'); });
    const v3GetPullRequest = vi.fn(async () => ({
      providerPullRequestId: '99', number: 99, state: 'open' as const, draft: false,
      headRef: 'feature/99', headOid: 'head-99', baseRef: 'main', baseOid: 'base-99', mergeable: true,
      requiredChecks: [{ name: 'ci', status: 'success' as const }], requiredChecksKnown: true,
      subjectDigest: 'digest-99',
    }));
    store.setRepositoryProvider({
      getPullRequest: legacyGetPullRequest, mergePullRequest: async () => { throw new Error('not used'); },
    });
    store.setIntegrationV3RepositoryProvider({
      getPullRequest: v3GetPullRequest, mergePullRequest: async () => { throw new Error('not used'); },
    });
    const delivery = await store.createTask(identity, board.id, { title: 'v3 source', status: 'todo' });
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='ready_to_merge',provider_pull_request_id='99',
              head_oid='head-99',base_oid='base-99',reviewed_subject_digest='digest-99',version=version+1 WHERE id=$1`,
      [delivery.id],
    );
    await seedSuccessfulReviewCi(pool, store, delivery.id, 'head-99');

    const integration = await store.createIntegrationBatch(identity, board.id, {
      deliveryTaskIds: [delivery.id], expectedBoardVersion: (await store.getBoard(identity, board.id)).version,
    });

    expect(integration.workflowVersion).toBe(3);
    expect(v3GetPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', name: 'v3-provider' }), '99', identity.ownerUserId,
    );
    expect(legacyGetPullRequest).not.toHaveBeenCalled();
  });
});
