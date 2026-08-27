import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureIntegrationFixture } from './ensure-integration-fixture.mjs';

function fakeClient(options = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT name, to_regclass')) {
        return {
          rows: values[0].map((name, index) => ({
            name,
            relation: options.missingSchema && index === 0 ? null : name,
          })),
        };
      }
      if (sql.includes('SELECT b.tenant_id')) {
        return {
          rows: [
            {
              tenant_id: 'pantheon',
              owner_user_id: 'user-1',
              integration_kind: 'integration',
              integration_status: 'canceled',
              workflow_version: 3,
              source_id: 'staging-e2e-integration-source',
              delivery_task_id: 'staging-e2e-integration-delivery',
              source_state: 'canceled',
              repository_id: 'staging-fixture:none',
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
}

const input = {
  releaseId: 'rc-20260827-01',
  tablePrefix: 'staging_runtime',
  tenantId: 'pantheon',
  userId: 'user-1',
};

test('fails closed until the deployed API has created every Taskboard table', async () => {
  await assert.rejects(
    ensureIntegrationFixture(fakeClient({ missingSchema: true }), input),
    /migrations are incomplete/u,
  );
});

test('creates only canceled Staging fixture rows and reads them back transactionally', async () => {
  const client = fakeClient();
  const result = await ensureIntegrationFixture(client, input);
  const sql = client.queries.map((query) => query.sql).join('\n');

  assert.match(sql, /'canceled'/u);
  assert.doesNotMatch(sql, /'merged'|'succeeded'/u);
  assert.ok(client.queries.some((query) => query.sql === 'BEGIN'));
  assert.ok(client.queries.some((query) => query.sql === 'COMMIT'));
  assert.equal(result.fixture.taskId, 'staging-e2e-integration-task');
  assert.equal(result.fixture.state, 'canceled');
  assert.equal(result.fixture.evidenceScope, 'storage-and-authenticated-readback-only');
  assert.equal(result.migrationReadback.status, 'present');
});
