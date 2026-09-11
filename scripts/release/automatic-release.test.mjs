import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeAutomaticRelease } from './automatic-release.mjs';
import { verifyProductionResult } from './automatic-release-result.mjs';
import {
  release,
  run,
  sha,
  ancestor,
  repository,
  checkpointFor,
} from './fixtures/automatic-release-fixture.mjs';

async function scenario(mode = 'recovery') {
  const now = Date.now();
  const directory = await mkdtemp(join(tmpdir(), 'automatic-e2e-'));
  const rootRun = run(501, 'promote-release.yml', now);
  const records = [],
    statuses = [],
    steps = [];
  const baseline = release(116, sha(8), sha(8), 'completed', now - 900000, now);
  const old = release(117, sha(9), sha(8), 'needs_human', now - 800000, now);
  const target = release(118, sha(10), sha(8), 'verified', now - 700000, now);
  const refreshed = release(119, sha(10), sha(9), 'verified', now - 6000, now);
  let releases = ['direct', 'completed'].includes(mode)
    ? [baseline, target]
    : [baseline, old, target];
  if (mode === 'completed') {
    target.state = 'completed';
    target.completedAt = now - 5000;
  }
  const client = {
    repository,
    pages: async (path) => records.filter((r) => path.includes(`task=${r.task}`)),
    api: async (path, body) => {
      if (path === 'actions/runs/501') return rootRun;
      if (path === 'deployments' && body) {
        const record = {
          id: 600 + records.length,
          ...body,
          sha: body.ref,
          created_at: new Date(now).toISOString(),
        };
        records.push(record);
        return record;
      }
      if (/^deployments\/\d+\/statuses$/u.test(path)) {
        statuses.push(body.state);
        return {};
      }
      if (/^deployments\/\d+$/u.test(path))
        return records.find((r) => r.id === Number(path.split('/')[1]));
      throw new Error(`Unexpected ${path}`);
    },
  };
  const child = async (options) => {
    const { stage, sourceSha, workflow, inputs } = options;
    steps.push({ stage, sourceSha, workflow, inputs });
    const childRun = {
      ...run(stage === 'refresh' ? 119 : 800 + steps.length, workflow, now),
      status: 'completed',
      conclusion: 'success',
      stage,
    };
    if (stage === 'recover') {
      assert.equal(inputs.release_id, old.manifest.releaseId);
      assert.equal(sourceSha, sha(9));
      old.state = 'completed';
      old.completedAt = now - 3000;
      if (mode === 'newer-main')
        releases.push(release(130, sha(11), sha(9), 'verified', now - 1000, now + 5000));
      if (mode === 'recovery-only') target.state = 'revoked';
    } else if (stage === 'refresh') {
      assert.equal(sourceSha, sha(10));
      releases.push(refreshed);
    } else if (stage === 'publish') {
      if (mode === 'publish-failed')
        throw Object.assign(new Error('worker failed'), { code: 'child_failed' });
      const c = releases.find((r) => r.manifest.releaseId === inputs.release_id);
      c.state = 'completed';
      c.completedAt = now;
      if (mode === 'cancelled') rootRun.status = 'completed';
    }
    return { run: childRun };
  };
  const execute = () =>
    executeAutomaticRelease({
      client,
      run: rootRun,
      reason: 'publish latest',
      directory,
      ancestor,
      now: () => now,
      catalog: async () => releases,
      child,
      readCandidate: async (_c, id) => releases.find((r) => r.manifest.releaseId === id),
      readStaging: async () => {
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(refreshed.manifest));
        return directory;
      },
      readProduction: async (_c, childRun, _d, source, id) => {
        if (mode === 'checkpoint-warning' && childRun.stage === 'publish')
          return { checkpointPending: true };
        let c = releases.find((r) => r.manifest.releaseId === id);
        if (mode === 'wrong-final-target' && childRun.stage.startsWith('verify-')) c = old;
        const proof = checkpointFor(c.manifest, childRun.id, now);
        return {
          ...verifyProductionResult(proof, source, id, { checkpoint: 'success' }),
          checkpointPending: false,
        };
      },
    });
  return { directory, steps, statuses, execute, records, target };
}
for (const mode of ['recovery', 'direct', 'completed', 'newer-main', 'checkpoint-warning']) {
  test(`orchestration reaches exact requested source, not just recovery: ${mode}`, async () => {
    const f = await scenario(mode);
    try {
      const result = await f.execute();
      assert.equal(result.status, 'completed');
      assert.equal(result.sourceSha, sha(10));
      assert.equal(result.targetSourceSha, sha(10));
      assert.equal(f.statuses.at(-1), 'success');
      const expected =
        mode === 'direct'
          ? ['publish', 'verify-1']
          : mode === 'completed'
            ? ['verify-1']
            : ['recover', 'refresh', 'publish', 'verify-1'];
      assert.deepEqual(
        f.steps.map((s) => s.stage),
        expected,
      );
      for (const s of f.steps.filter((s) => s.stage !== 'recover'))
        assert.equal(s.sourceSha, sha(10));
      assert.equal(f.records[0].payload.target.sourceSha, sha(10));
      assert.equal(f.records[0].payload.target.releaseId, 'rc-20260911-118');
      if (!['direct', 'completed'].includes(mode)) {
        assert.equal(result.releaseId, 'rc-20260911-119');
        assert.equal(f.target.manifest.productionBaseline.api.sourceSha, sha(8));
      }
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}
for (const mode of ['recovery-only', 'publish-failed', 'wrong-final-target', 'cancelled']) {
  test(`not fulfilled: ${mode}`, async () => {
    const f = await scenario(mode);
    try {
      await assert.rejects(f.execute);
      const result = JSON.parse(await readFile(join(f.directory, 'result.json'), 'utf8'));
      assert.equal(result.status, 'blocked');
      assert.equal(result.targetSourceSha, sha(10));
      assert(!f.statuses.includes('success'));
      if (mode === 'recovery-only')
        assert.deepEqual(
          f.steps.map((s) => s.stage),
          ['recover'],
        );
      if (mode === 'publish-failed' || mode === 'cancelled')
        assert(!f.steps.some((s) => s.stage.startsWith('verify-')));
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}
test('final proof rejects mere process health, partial matrix, old target and checkpoint warnings', () => {
  const m = release(118, sha(10), sha(8)).manifest;
  const p = checkpointFor(m);
  for (const mutation of [
    (c) => {
      c.completed.state = 'needs_human';
    },
    (c) => {
      c.productionState.components.acs.gitSha = sha(9);
    },
    (c) => {
      c.productionState.configIdentity.status = 'unverifiable';
    },
  ]) {
    const c = structuredClone(p);
    mutation(c);
    assert.throws(() => verifyProductionResult(c, sha(10), m.releaseId, { checkpoint: 'success' }));
  }
  assert.throws(() => verifyProductionResult(p, sha(11), m.releaseId, { checkpoint: 'success' }));
  assert.throws(() => verifyProductionResult(p, sha(10), m.releaseId, { checkpoint: 'failure' }));
});
