import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomaticLedger } from './automatic-release-ledger.mjs';
import { AutomaticGitHub, ghCommand } from './automatic-release-github.mjs';
import { runChild } from './automatic-release-dispatch.mjs';
import { context, repository, sha } from './fixtures/automatic-release-fixture.mjs';

function fixture(mode = '') {
  const c = context();
  const requests = [];
  const records = [];
  if (mode === 'existing' || mode === 'existing-unknown') records.push(c.stepRecord);
  let dispatched = mode === 'existing';
  let tick = Date.now();
  const child = { ...c.run, status: 'completed', conclusion: 'success' };
  const client = {
    repository,
    pages: async (path) => {
      if (path.startsWith('deployments?')) return records;
      const matches = dispatched ? [child] : [];
      return mode === 'duplicate' ? [child, { ...child, id: 702 }] : matches;
    },
    api: async (path, body) => {
      requests.push({ path, body });
      if (path === 'actions/runs/501')
        return mode === 'cancelled' ? { ...c.parentRun, status: 'completed' } : c.parentRun;
      if (path === 'git/ref/heads/main')
        return { object: { sha: mode === 'main-moved' ? sha(14) : c.parentRun.head_sha } };
      if (path === 'deployments' && body) {
        const value = { id: 602, ...body, sha: body.ref, created_at: c.stepRecord.created_at };
        records.push(value);
        return value;
      }
      if (path === 'deployments/602') return records[0];
      if (path.endsWith('/dispatches')) {
        assert.equal(body.return_run_details, true);
        assert.equal(body.ref, 'main');
        assert.equal(body.inputs.automation_id, '602');
        assert.equal(body.inputs.automation_key, 'auto:501:refresh');
        if (mode !== 'unknown') dispatched = true;
        if (mode === 'lost-ack' || mode === 'unknown')
          throw Object.assign(new Error('timeout'), { code: 'write_acknowledgement_unknown' });
        if (mode === 'empty-ack') return null;
        return { workflow_run_id: 701 };
      }
      if (path === 'actions/runs/701')
        return mode === 'wrong-engine'
          ? { ...child, head_sha: sha(14) }
          : mode === 'failed'
            ? { ...child, conclusion: 'failure' }
            : child;
      throw new Error(`Unexpected API ${path}`);
    },
  };
  const ledger = new AutomaticLedger(client);
  const execute = () =>
    runChild({
      client,
      ledger,
      requestRecord: c.requestRecord,
      parentAttempt: 1,
      stage: 'refresh',
      workflow: 'deploy-staging.yml',
      sourceSha: sha(10),
      inputs: { reason: 'release latest' },
      deadline: tick + 180000,
      now: () => tick,
      pause: async (delay) => {
        tick += delay;
      },
    });
  return { c, records, client, requests, ledger, execute };
}
for (const mode of ['', 'lost-ack', 'empty-ack', 'existing']) {
  test(`bounded dispatch completes without duplicate POST: ${mode || 'normal'}`, async () => {
    const f = fixture(mode);
    const result = await f.execute();
    assert.equal(result.run.id, 701);
    assert.equal(
      f.requests.filter((c) => c.path.endsWith('/dispatches')).length,
      mode === 'existing' ? 0 : 1,
    );
    if (mode !== 'existing')
      assert(
        f.requests.findIndex((c) => c.path === 'deployments' && c.body) <
          f.requests.findIndex((c) => c.path.endsWith('/dispatches')),
      );
  });
}
for (const mode of [
  'unknown',
  'existing-unknown',
  'duplicate',
  'main-moved',
  'cancelled',
  'wrong-engine',
  'failed',
]) {
  test(`refuse uncertain or unsafe child result: ${mode}`, async () => {
    const f = fixture(mode);
    await assert.rejects(f.execute);
    assert(f.requests.filter((c) => c.path.endsWith('/dispatches')).length <= 1);
    if (['existing-unknown', 'duplicate', 'main-moved', 'cancelled'].includes(mode))
      assert.equal(f.requests.filter((c) => c.path.endsWith('/dispatches')).length, 0);
  });
}
test('ambiguous persisted requests and rerun without original request never select a new target', async () => {
  const f = fixture();
  let creations = 0;
  await assert.rejects(() =>
    f.ledger.request(
      { ...f.c.parentRun, run_attempt: 2 },
      () => {
        creations++;
      },
      repository,
    ),
  );
  f.records.push(f.c.requestRecord, { ...f.c.requestRecord, id: 604 });
  await assert.rejects(() =>
    f.ledger.request(
      f.c.parentRun,
      () => {
        creations++;
      },
      repository,
    ),
  );
  assert.equal(creations, 0);
});
test('request retries retain their frozen target and reason', async () => {
  const f = fixture();
  f.records.push(f.c.requestRecord);
  const record = await f.ledger.request(
    { ...f.c.parentRun, run_attempt: 2 },
    () => {
      throw new Error('must not reselect');
    },
    repository,
  );
  assert.equal(record.payload.target.sourceSha, sha(10));
});
test('GitHub writes have one attempt and error messages never expose command/token output', async () => {
  let count = 0;
  const client = new AutomaticGitHub(repository, {
    command: async () => {
      count++;
      throw new Error('secret=redacted-test-token');
    },
  });
  await assert.rejects(
    () => client.api('deployments', { payload: 'safe' }),
    (e) => {
      assert.equal(e.code, 'write_acknowledgement_unknown');
      assert(!e.message.includes('redacted-test-token'));
      return true;
    },
  );
  assert.equal(count, 1);
});
test('GitHub JSON bodies are sent through stdin, not shell argument interpolation', async () => {
  const result = await ghCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    input: '{"reason":"$(touch should-not-exist)"}',
    encoding: 'utf8',
    timeout: 1000,
  });
  assert.equal(JSON.parse(result.stdout).reason, '$(touch should-not-exist)');
});
test('pagination follows all pages and rejects truncated or excessive inventories', async () => {
  const client = new AutomaticGitHub(repository);
  let reads = 0;
  client.api = async () => {
    reads++;
    return { total_count: 101, workflow_runs: reads === 1 ? Array(100).fill({}) : [{}] };
  };
  assert.equal((await client.pages('actions/runs', 'workflow_runs')).length, 101);
  client.api = async () => ({ total_count: 200, workflow_runs: [] });
  await assert.rejects(() => client.pages('actions/runs', 'workflow_runs'), /分页/u);
  client.api = async () => Array(100).fill({});
  await assert.rejects(() => client.pages('releases'), /bounded scan/u);
});
