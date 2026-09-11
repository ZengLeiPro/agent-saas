import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticateChild } from './automatic-release-child.mjs';
import { seal } from './automatic-release-contract.mjs';
import { context, repository, sha } from './fixtures/automatic-release-fixture.mjs';

function setup() {
  const c = context();
  const inputs = {
    reason: 'release latest',
    automation_id: '602',
    automation_key: 'auto:501:refresh',
  };
  const client = {
    repository,
    api: async (path) => {
      const values = {
        'deployments/602': c.stepRecord,
        'deployments/601': c.requestRecord,
        'actions/runs/501': c.parentRun,
        'actions/runs/701': c.run,
      };
      assert(path in values, `Unexpected endpoint ${path}`);
      return structuredClone(values[path]);
    },
  };
  const check = () =>
    authenticateChild(client, {
      inputs,
      workflow: 'deploy-staging.yml',
      runId: '701',
      runAttempt: '1',
    });
  return { c, inputs, client, check };
}
test('child source is independently authenticated from exact immutable parent reservation', async () => {
  const s = setup();
  const result = await s.check();
  assert.equal(result.stepRecord.payload.sourceSha, sha(10));
  assert.equal(result.run.head_sha, sha(15));
});
for (const [name, change] of Object.entries({
  'cancelled parent': (s) => {
    s.c.parentRun.status = 'completed';
    s.c.parentRun.conclusion = 'cancelled';
  },
  'new parent attempt': (s) => {
    s.c.parentRun.run_attempt = 2;
  },
  'changed engine': (s) => {
    s.c.run.head_sha = sha(14);
  },
  fork: (s) => {
    s.c.run.head_repository.full_name = 'fork/repo';
  },
  'child rerun': (s) => {
    s.c.run.run_attempt = 2;
  },
  'different run name': (s) => {
    s.c.run.display_title = 'auto:501:publish';
  },
  'new source input': (s) => {
    s.inputs.source_sha = sha(11);
  },
  'different reason': (s) => {
    s.inputs.reason = 'changed';
  },
  'manual force repair': (s) => {
    s.inputs.recovery_mode = 'repair';
  },
  'missing reservation': (s) => {
    delete s.inputs.automation_id;
  },
  'new request target': (s) => {
    s.c.requestRecord.payload.target.sourceSha = sha(11);
  },
  'changed step target': (s) => {
    s.c.stepRecord.payload.sourceSha = sha(11);
  },
  'step before request': (s) => {
    s.c.stepRecord.created_at = '2000-01-01T00:00:00Z';
  },
  'record after child': (s) => {
    s.c.stepRecord.created_at = '2099-01-01T00:00:00Z';
  },
  'fake historic request time': (s) => {
    s.c.requestRecord.payload = seal({
      ...s.c.requestRecord.payload,
      requestedAt: '2000-01-01T00:00:00Z',
    });
  },
}))
  test(`reject ${name}`, async () => {
    const s = setup();
    change(s);
    await assert.rejects(s.check);
  });
