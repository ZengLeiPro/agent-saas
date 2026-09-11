import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { collectDiagnostics } from './collect-promotion-diagnostics.mjs';
import { reconcilePromotion } from './reconcile-promotion.mjs';

const digest = (letter) => 'sha256:' + letter.repeat(64);
const component = (letter) => ({ gitSha: letter.repeat(40), artifactDigest: digest(letter) });
const matrix = (letter) => ({ api: component(letter), runtimeWorker: component(letter), web: component(letter),
  acs: { gitSha: letter.repeat(40), orchestratorArtifactDigest: digest(letter), sandboxImageDigest: digest(letter) } });

// Offline evidence composition, NOT a production/OSS/CDN fault injection.
for (const unknown of [false, true]) {
  test(`T11/F16 detached evidence keeps scoped rollback and ${unknown ? 'unknown effects' : 'partial commit'}`, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), 'detached-failure-evidence-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const input = join(temporary, 'input'), output = join(temporary, 'output');
    await mkdir(join(input, 'operation-receipts'), { recursive: true });
    await mkdir(join(input, 'web-asset-diagnostics'));
    const write = (name, value) => writeFile(join(input, name), JSON.stringify(value) + '\n');
    const before = matrix('a');
    const target = { ...before, acs: matrix('b').acs, web: component('b') };
    const observed = { ...before, acs: target.acs };
    const value = { releaseId: 'rc-20260911-999', before, target, observed,
      observationComplete: true, configIdentityConfirmed: true,
      externalSideEffects: unknown ? 'unknown' : 'none_observed',
      rollbackReceipts: { acs: { attempted: false, succeeded: false },
        app: { attempted: false, succeeded: false }, web: { attempted: true, succeeded: true } } };
    await write('reconcile-input.json', value);
    await write('reconcile.json', reconcilePromotion(value));
    await write('deployment-engine.json', { sourceSha: 'c'.repeat(40), implementationDigest: digest('c'),
      workflow: '.github/workflows/promote-release.yml' });
    await write('web-budget.json', { operationSeconds: 1200, rollbackSeconds: 300,
      lockLeaseSeconds: 1800, elapsedSeconds: 130, deployExitCode: 124, rollbackExitCode: 0 });
    await write('web-rollback.json', { verified: true, objects: [{ key: 'index.html', existed: true,
      digest: digest('a'), targetDigest: digest('b'), private: 'NEVER_EXPORT' }] });
    for (const [componentName, action, outcome] of [['acs', 'deploy', 'succeeded'],
      ['api', 'keep', 'skipped'], ['runtimeWorker', 'keep', 'skipped'], ['web', 'deploy', 'failed']])
      await write(`operation-receipts/operation-${componentName}.json`, { component: componentName,
        action, outcome, releaseId: value.releaseId, manifestDigest: digest('c'),
        operationKey: `test-${componentName}`, digest: digest('d'), token: 'NEVER_EXPORT' });
    const events = [1, 2].map((attempt) => ({ key: 'last.js', phase: 'public-head', attempt,
      exitCode: 124, durationSeconds: 60, token: 'NEVER_EXPORT' }));
    events.push({ key: 'last.js', phase: 'verify', attempt: 0, exitCode: 124, durationSeconds: 121 });
    await writeFile(join(input, 'web-asset-diagnostics/worker-13.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
    await write('web-asset-diagnostics/batch.json', { schemaVersion: 1, status: 'failed', total: 13,
      completed: 12, uploaded: 12, reused: 0, concurrency: 4, requestTimeoutSeconds: 60,
      elapsedSeconds: 130, exitCode: 124 });
    await collectDiagnostics(input, output);
    // Prove the consumer has only the detached serialized artifact, not fixture inputs.
    await rm(input, { recursive: true });
    const bytes = await readFile(join(output, 'summary.json'), 'utf8');
    const report = JSON.parse(bytes);
    assert.doesNotMatch(bytes, /NEVER_EXPORT/);
    assert.equal(report.outcome, unknown ? 'needs_human' : 'partial_failed');
    assert.deepEqual(report.componentResults, {
      acs: { rollbackAttempted: false, rollbackVerified: false, state: 'target' },
      app: { rollbackAttempted: false, rollbackVerified: false, state: 'before' },
      web: { rollbackAttempted: true, rollbackVerified: true, state: 'before' },
    });
    assert.deepEqual(report.matrices.observed.acs, target.acs);
    assert.deepEqual(report.matrices.observed.web, before.web);
    assert.equal(report.operationReceipts.find((r) => r.component === 'acs').outcome, 'succeeded');
    assert.equal(report.operationReceipts.find((r) => r.component === 'api').action, 'keep');
    assert.equal(report.restoration.verified, true);
    assert.equal(report.budget.operationSeconds, 1200);
    assert.deepEqual(report.webAssets.events.filter((event) => event.phase === 'public-head')
      .map(({ attempt, exitCode }) => ({ attempt, exitCode })), [{ attempt: 1, exitCode: 124 }, { attempt: 2, exitCode: 124 }]);
    assert.equal(report.webAssets.batch.requestTimeoutSeconds, 60);
    assert.notEqual(report.webAssets.coverage.status, 'complete');
    assert.equal(report.webAssets.phaseTimings, null);
    assert.equal(report.nextAction, unknown ? 'inspect_external_side_effects_before_resume' : 'resume_uncommitted_components');
  });
}
