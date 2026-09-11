import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProductionPreflight } from './production-preflight.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'production-preflight-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = {
    reader: 'read-production-state.mjs',
    configIdentityStage: 'steady-state',
    output: join(dir, 'state.json'),
    diagnostics: join(dir, 'report.json'),
    runId: '123',
    runAttempt: '2',
  };
  let time = 0;
  let calls = 0;
  let sleeps = 0;
  const dependencies = {
    clock: () => time,
    deadlineMs: 50,
    intervalMs: 10,
    sleep: async (milliseconds) => {
      sleeps++;
      time += milliseconds;
    },
    observe: () => ({
      retry: { allowed: true, reasonCode: 'config_refresh_slow', identityKey: 'generation-A' },
    }),
    execute: async (candidate) => {
      calls++;
      if (calls >= 2) {
        writeFileSync(
          candidate,
          JSON.stringify({
            environment: 'production',
            components: { api: { source: 'trusted-strict-reader' } },
          }),
        );
        return { exitCode: 0 };
      }
      return { exitCode: 1, workerReadinessFailure: true };
    },
  };
  return {
    dir,
    options,
    dependencies,
    calls: () => calls,
    sleeps: () => sleeps,
    setTime: (value) => {
      time = value;
    },
    report: () => JSON.parse(readFileSync(options.diagnostics, 'utf8')),
  };
}

test('re-observes proven transient state and accepts only the original strict reader success', async (t) => {
  const f = setup(t);
  const result = await runProductionPreflight(f.options, f.dependencies);
  assert.equal(result.ok, true);
  assert.equal(f.calls(), 2);
  assert.equal(f.sleeps(), 1);
  assert.equal(f.report().status, 'passed');
  assert.equal(f.report().attempts[0].exitCode, 1);
  assert.equal(
    JSON.parse(readFileSync(f.options.output)).components.api.source,
    'trusted-strict-reader',
  );
  assert.ok(!readdirSync(f.dir).some((name) => name.includes('.preflight-')));
});

for (const reasonCode of [
  'worker_readiness_reason_unavailable',
  'worker_readyfile_io_error',
  'worker_readyfile_pid_mismatch',
  'worker_config_drifted',
  'worker_draining',
  'runtime_identity_unverifiable',
]) {
  test(`does not retry ${reasonCode} or manufacture a successful output`, async (t) => {
    const f = setup(t);
    f.dependencies.observe = () => ({
      retry: { allowed: false, reasonCode, identityKey: 'generation-A' },
    });
    const result = await runProductionPreflight(f.options, f.dependencies);
    assert.equal(result.ok, false);
    assert.equal(f.calls(), 1);
    assert.equal(f.sleeps(), 0);
    assert.equal(f.report().status, 'failed');
    assert.equal(existsSync(f.options.output), false);
  });
}
test('diagnostic memory state never masks a non-readiness reader failure', async (t) => {
  const f = setup(t);
  f.dependencies.execute = async () => ({ exitCode: 1, workerReadinessFailure: false });
  const result = await runProductionPreflight(f.options, f.dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.report.attempts.length, 1);
});
for (const secondKey of ['generation-B', null]) {
  test(`rejects changed or lost process identity ${secondKey} even when subsequent strict reader succeeds`, async (t) => {
    const f = setup(t);
    let observed = 0;
    f.dependencies.observe = () => ({
      retry: {
        allowed: true,
        reasonCode: 'config_refresh_slow',
        identityKey: ++observed === 1 ? 'generation-A' : secondKey,
      },
    });
    const result = await runProductionPreflight(f.options, f.dependencies);
    assert.equal(result.ok, false);
    assert.equal(result.report.identityChanged, true);
    assert.equal(existsSync(f.options.output), false);
  });
}
test('uses a single finite overall deadline and preserves every failed sample', async (t) => {
  const f = setup(t);
  f.dependencies.execute = async (candidate, remaining) => {
    assert.ok(remaining > 0 && remaining <= 50);
    writeFileSync(candidate, 'partial');
    return { exitCode: 1, workerReadinessFailure: true };
  };
  const result = await runProductionPreflight(f.options, f.dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.report.timedOut, true);
  assert.equal(result.report.attempts.length, 5);
  assert.equal(f.report().status, 'failed');
  assert.deepEqual(readdirSync(f.dir), ['report.json']);
});
test('cannot pass after the deadline even when last child succeeded', async (t) => {
  const f = setup(t);
  f.dependencies.execute = async (candidate) => {
    writeFileSync(candidate, JSON.stringify({ environment: 'production', components: {} }));
    f.setTime(51);
    return { exitCode: 0 };
  };
  assert.equal((await runProductionPreflight(f.options, f.dependencies)).ok, false);
  assert.equal(existsSync(f.options.output), false);
});
test('a diagnostic failure never turns into authorization or leaks the original exception', async (t) => {
  const f = setup(t);
  f.dependencies.observe = () => {
    throw new Error('secret token should not be in artifacts');
  };
  const result = await runProductionPreflight(f.options, f.dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.report.attempts.length, 1);
  assert.doesNotMatch(readFileSync(f.options.diagnostics, 'utf8'), /secret token/u);
});
test('keeps legacy successful strict readers compatible without requiring a new sidecar', async (t) => {
  const f = setup(t);
  f.dependencies.observe = () => ({
    retry: { allowed: false, reasonCode: 'worker_readiness_reason_unavailable', identityKey: null },
  });
  f.dependencies.execute = async (candidate) => {
    writeFileSync(candidate, JSON.stringify({ environment: 'production', components: {} }));
    return { exitCode: 0 };
  };
  assert.equal((await runProductionPreflight(f.options, f.dependencies)).ok, true);
});
test('current preflight failure is not proof a previous promotion made no changes', async (t) => {
  const f = setup(t);
  f.options.retryMode = 'retry_after_change';
  f.dependencies.observe = () => ({ retry: { allowed: false } });
  const result = await runProductionPreflight(f.options, f.dependencies);
  assert.equal(result.report.scope, 'current_attempt_only');
  assert.equal(result.report.priorRecoveryRequired, true);
  assert.equal(result.report.runId, '123');
  assert.equal(result.report.runAttempt, '2');
});
test('refuses existing state atomically rather than replacing a prior observation', async (t) => {
  const f = setup(t);
  writeFileSync(f.options.output, 'preserved');
  await assert.rejects(runProductionPreflight(f.options, f.dependencies), /existing output/u);
  assert.equal(f.calls(), 0);
  assert.equal(readFileSync(f.options.output, 'utf8'), 'preserved');
  assert.equal(f.report().status, 'failed');
});
test('malformed successful reader output still fails and persists diagnostics', async (t) => {
  const f = setup(t);
  f.dependencies.execute = async (candidate) => {
    writeFileSync(candidate, 'not-json');
    return { exitCode: 0 };
  };
  await assert.rejects(runProductionPreflight(f.options, f.dependencies));
  assert.equal(f.report().status, 'failed');
  assert.equal(existsSync(f.options.output), false);
});
for (const invalid of [
  { reader: '../other.mjs' },
  { configIdentityStage: 'legacy-pre-upgrade-baseline' },
  { configIdentityStage: 'candidate-readback' },
  { retryMode: 'ignore-health' },
  { runAttempt: '0' },
]) {
  test(`rejects invalid invocation ${JSON.stringify(invalid)}`, async (t) => {
    const f = setup(t);
    await assert.rejects(runProductionPreflight({ ...f.options, ...invalid }, f.dependencies));
    assert.equal(f.calls(), 0);
  });
}
