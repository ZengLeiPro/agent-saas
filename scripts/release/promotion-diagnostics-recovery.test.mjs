import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectDiagnostics } from './collect-promotion-diagnostics.mjs';

const id = {
  releaseId: 'rc-20260911-01',
  manifestDigest: 'sha256:' + 'a'.repeat(64),
  runId: '12',
  runAttempt: '2',
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'diagnostics-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['operation-receipts', 'web-asset-diagnostics']) await mkdir(join(root, dir));
  const put = (name, value) => writeFile(join(root, name), JSON.stringify(value));
  return { root, put };
}
test('one bounded summary carries object/phase, operation, budget, rollback scope and recovery identity without payloads', async (t) => {
  const { root, put } = await fixture(t);
  await put('operation-receipts/operation-12.json', {
    ...id,
    component: 'web',
    outcome: 'failed',
    action: 'deploy',
    operationKey: '12-2-web',
    privateKey: 'DO_NOT_EXPORT',
  });
  await put('web-budget.json', {
    operationSeconds: 1200,
    rollbackSeconds: 300,
    lockLeaseSeconds: 1700,
    elapsedSeconds: 1220,
    deployExitCode: 124,
    rollbackExitCode: 0,
    shell: 'DO_NOT_EXPORT',
  });
  await put('web-recovery-last.json', {
    identity: id,
    capsuleDigest: 'b'.repeat(64),
    state: 'pending',
    pending: true,
    capsule: 'DO_NOT_EXPORT',
  });
  await put('web-rollback.json', {
    verified: true,
    objects: [
      {
        key: 'sw.js',
        existed: true,
        digest: 'c'.repeat(64),
        targetDigest: 'd'.repeat(64),
        bytes: 'DO_NOT_EXPORT',
      },
    ],
  });
  await put('web-asset-diagnostics/worker-1.jsonl', {
    key: 'assets/app.js',
    phase: 'put',
    attempt: 2,
    exitCode: 124,
    durationSeconds: 60,
    command: 'DO_NOT_EXPORT',
  });
  await put('reconcile.json', {
    outcome: 'needs_human',
    recovery: 'inspect_external_side_effects_before_resume',
    prompt: 'DO_NOT_EXPORT',
  });
  const summary = await collectDiagnostics(root, join(root, 'out'));
  assert.equal(summary.operationReceipts[0].outcome, 'failed');
  assert.equal(summary.budget.elapsedSeconds, 1220);
  assert.equal(summary.webRecovery.runAttempt, '2');
  assert.equal(summary.restoration.objects[0].key, 'sw.js');
  assert.equal(summary.webAssets.events[0].attempt, 2);
  assert.equal(summary.nextAction, 'inspect_external_side_effects_before_resume');
  assert.doesNotMatch(await readFile(join(root, 'out/summary.json'), 'utf8'), /DO_NOT_EXPORT/);
});
test('oversized and linked evidence is rejected rather than exported; unavailable evidence is explicit', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'oversized'), 'x'.repeat(512001));
  await symlink(join(root, 'oversized'), join(root, 'web-budget.json'));
  await symlink(join(root, 'oversized'), join(root, 'web-asset-diagnostics/worker-0.jsonl'));
  const result = await collectDiagnostics(root, join(root, 'out'));
  assert.equal(result.budget, null);
  assert.equal(result.webAssets.truncated, true);
  assert.equal(result.evidencePresent['production-after.json'], false);
  assert.equal(result.outcome, 'unknown');
});
test('structured rollback reader preserves absence vs invalid and excludes unreviewed properties', async (t) => {
  const { root, put } = await fixture(t);
  const path = join(root, 'receipt.json');
  const expected = { schemaVersion: 1, component: 'web', state: 'succeeded', ...id };
  await put('receipt.json', { ...expected, credential: 'DO_NOT_EXPORT' });
  const args = [
    'scripts/release/read-rollback-receipt.mjs',
    path,
    'web',
    'succeeded',
    id.releaseId,
    id.manifestDigest,
    id.runId,
    id.runAttempt,
    '--json',
  ];
  const output = execFileSync(process.execPath, args, { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { readState: 'present', receipt: expected });
  await rm(path);
  assert.equal(
    JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' })).readState,
    'absent',
  );
  await put('receipt.json', { ...expected, runAttempt: '1' });
  assert.throws(
    () => execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.equal(error.status, 1);
      assert.equal(JSON.parse(error.stdout).readState, 'invalid');
      return true;
    },
  );
});
