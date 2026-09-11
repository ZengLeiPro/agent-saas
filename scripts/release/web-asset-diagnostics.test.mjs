import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectDiagnostics } from './collect-promotion-diagnostics.mjs';
import { collectAssetDiagnostics, ASSET_DIAGNOSTIC_LIMITS as limits } from './web-asset-diagnostics.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'asset-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'web-asset-diagnostics'); await mkdir(directory);
  return { root, directory };
}
const event = (key, phase = 'put', exitCode = 0, durationSeconds = 1) => ({
  key, phase, exitCode, durationSeconds, attempt: 1,
});
const writeEvents = (directory, number, events) => writeFile(
  join(directory, `worker-${String(number).padStart(5, '0')}.jsonl`),
  events.map((value) => JSON.stringify(value)).join('\n') + '\n',
);
async function batch(directory, total, patch = {}) {
  await writeFile(join(directory, 'batch.json'), JSON.stringify({
    schemaVersion: 1, status: 'completed', total, completed: total,
    uploaded: total, reused: 0, concurrency: 4, requestTimeoutSeconds: 60,
    elapsedSeconds: 210, exitCode: 0, ...patch,
  }));
}
const trace = (key, seconds = 1) => [
  event(key, 'put'), event(key, 'readback'), event(key, 'public-head'), event(key, 'verify', 0, seconds),
];
test('H04 226 per-resource files are not mistaken for eight worker slots', async (t) => {
  const { root, directory } = await fixture(t);
  for (let i = 0; i < 226; i++) await writeEvents(directory, i, [
    event(`assets/${i}.js`, 'compress'), event(`assets/${i}.js`),
    event(`assets/${i}.js`, 'readback'), event(`assets/${i}.js`, 'public-head'),
  ]);
  const result = await collectDiagnostics(root, join(root, 'out'));
  assert.equal(result.webAssets.events.length, 904);
  assert.equal(new Set(result.webAssets.events.map((item) => item.key)).size, 226);
  assert.equal(result.webAssets.truncated, false);
  assert.equal(result.webAssets.coverage.status, 'unverified');
  assert.deepEqual(result.webAssets.coverage.reasons, ['batch_receipt_missing']);
  assert.equal(result.webAssets.phaseTimings, null);
});
test('complete batch has terminal and request coverage before publishing all-resource percentiles', async (t) => {
  const { directory } = await fixture(t);
  for (let i = 1; i <= 226; i++) await writeEvents(directory, i, trace(`assets/${i}.js`, i));
  await batch(directory, 226);
  const result = await collectAssetDiagnostics(directory);
  assert.equal(result.coverage.status, 'complete'); assert.equal(result.truncated, false);
  assert.equal(result.coverage.filesRead, 226); assert.equal(result.coverage.terminalSuccesses, 226);
  assert.deepEqual(result.resourceTimings, { samples: 226, p50Seconds: 113, p95Seconds: 215, maxSeconds: 226 });
  assert.equal(result.phaseTimings.put.samples, 226);
});
for (const index of [0, 110, 225]) test(`failure at resource ${index} remains in summary and prevents false completeness`, async (t) => {
  const { directory } = await fixture(t);
  for (let i = 0; i < 226; i++) await writeEvents(directory, i,
    i === index ? [event(`assets/${i}.js`, 'public-head', 124, 60), event(`assets/${i}.js`, 'verify', 124, 120)]
      : trace(`assets/${i}.js`));
  await batch(directory, 226, { status: 'failed', completed: 225, uploaded: 225, exitCode: 124 });
  const result = await collectAssetDiagnostics(directory);
  assert.ok(result.events.some((item) => item.key === `assets/${index}.js` && item.exitCode === 124));
  assert.equal(result.coverage.terminalFailures, 1);
  assert.equal(result.coverage.status, 'partial'); assert.equal(result.resourceTimings, null);
});
test('bounded summary retains late nonzero events instead of a success-only prefix', async (t) => {
  const { directory } = await fixture(t);
  const values = Array.from({ length: 2200 }, (_, i) => event(`assets/${i}.js`));
  values.push(event('assets/LATE.js', 'public-head', 124, 60));
  await writeEvents(directory, 1, values);
  const result = await collectAssetDiagnostics(directory);
  assert.equal(result.events.length, limits.events);
  assert.ok(result.events.some((item) => item.key === 'assets/LATE.js'));
  assert.equal(result.truncated, true); assert.equal(result.coverage.eventsOmitted, 201);
  assert.equal(result.coverage.nonzeroEventsOmitted, 0);
  assert.ok(result.coverage.reasons.includes('event_limit'));
  assert.equal(result.phaseTimings, null);
});
test('even a nonzero-event overflow is counted rather than described as fully retained', async (t) => {
  const { directory } = await fixture(t);
  await writeEvents(directory, 1, Array.from({ length: 2005 }, (_, i) => event(`assets/${i}.js`, 'put', 124)));
  const result = await collectAssetDiagnostics(directory);
  assert.equal(result.coverage.nonzeroEvents, 2005);
  assert.equal(result.coverage.nonzeroEventsOmitted, 5);
  assert.equal(result.truncated, true);
});
test('file count limit explicitly reports omitted resource files', async (t) => {
  const { directory } = await fixture(t);
  for (let i = 0; i < limits.files + 2; i++) await writeEvents(directory, i, [event(`assets/${i}.js`)]);
  const result = await collectAssetDiagnostics(directory);
  assert.equal(result.coverage.filesDiscovered, 1026); assert.equal(result.coverage.filesRead, 1024);
  assert.equal(result.coverage.filesOmitted, 2); assert.ok(result.coverage.reasons.includes('file_count_limit'));
  assert.equal(result.truncated, true);
});
test('per-file and total byte budgets stay bounded near the limit', async (t) => {
  const { directory } = await fixture(t);
  const line = JSON.stringify({ ...event('assets/x.js'), ignored: 'x'.repeat(900) }) + '\n';
  const content = line.repeat(Math.floor(500000 / line.length));
  for (let i = 0; i < 10; i++) await writeFile(join(directory, `worker-${i}.jsonl`), content);
  const result = await collectAssetDiagnostics(directory);
  assert.ok(result.coverage.bytesRead <= limits.totalBytes);
  assert.ok(result.coverage.reasons.includes('total_byte_limit')); assert.equal(result.truncated, true);
  await writeFile(join(directory, 'worker-oversize'), 'ignored');
  await writeFile(join(directory, 'worker-99.jsonl'), 'x'.repeat(limits.fileBytes + 1));
  const oversized = await collectAssetDiagnostics(directory);
  assert.ok(oversized.truncated); assert.ok(oversized.coverage.filesOmitted > 0);
});
test('directory enumeration itself has an explicit limit', async (t) => {
  const { directory } = await fixture(t);
  for (let i = 0; i <= limits.directoryEntries; i++) await writeFile(join(directory, `ignored-${i}`), '');
  const result = await collectAssetDiagnostics(directory);
  assert.equal(result.coverage.discoveryComplete, false);
  assert.ok(result.coverage.reasons.includes('directory_entry_limit'));
  assert.equal(result.truncated, true);
});
test('invalid JSON/UTF-8, symlinks, empty evidence and secret fields never leak', async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(join(root, 'secret'), 'DO_NOT_EXPORT');
  await symlink(join(root, 'secret'), join(directory, 'worker-1.jsonl'));
  await writeFile(join(directory, 'worker-2.jsonl'), '{DO_NOT_EXPORT}\n');
  await writeFile(join(directory, 'worker-3.jsonl'), Buffer.from([0xff]));
  await writeFile(join(directory, 'worker-4.jsonl'), '');
  await writeEvents(directory, 5, [{ ...event('assets/ok.js'), token: 'DO_NOT_EXPORT' },
    event('assets/bad.js?token=DO_NOT_EXPORT')]);
  const result = await collectDiagnostics(root, join(root, 'out'));
  assert.equal(result.webAssets.events.length, 1); assert.equal(result.webAssets.truncated, true);
  assert.doesNotMatch(await readFile(join(root, 'out/summary.json'), 'utf8'), /DO_NOT_EXPORT/u);
  assert.equal(result.webAssets.coverage.invalidLines, 2);
});
test('missing or symlinked diagnostic directory is unavailable, never an empty complete batch', async (t) => {
  const { root, directory } = await fixture(t);
  await symlink(directory, join(root, 'link'));
  for (const path of [join(root, 'missing'), join(root, 'link')]) {
    const result = await collectAssetDiagnostics(path);
    assert.equal(result.truncated, true); assert.equal(result.coverage.status, 'partial');
    assert.ok(result.coverage.reasons.includes('diagnostics_unavailable'));
  }
});
for (const damage of ['missing-terminal', 'missing-readback', 'duplicate-terminal', 'running', 'invalid-batch'])
  test(`batch completeness rejects ${damage}`, async (t) => {
    const { directory } = await fixture(t); let values = trace('assets/x.js');
    if (damage === 'missing-terminal') values.pop();
    if (damage === 'missing-readback') values = values.filter((item) => item.phase !== 'readback');
    if (damage === 'duplicate-terminal') values.push(event('assets/x.js', 'verify'));
    await writeEvents(directory, 1, values);
    await batch(directory, 1, damage === 'running' ? { status: 'running', completed: 0, uploaded: 0 } : {});
    if (damage === 'invalid-batch') await writeFile(join(directory, 'batch.json'), '{"status":"completed"}');
    const result = await collectAssetDiagnostics(directory);
    assert.equal(result.coverage.status, 'partial'); assert.equal(result.resourceTimings, null);
  });
test('create-only conflict is a recorded nonzero attempt, not a failed resource', async (t) => {
  const { directory } = await fixture(t); const values = trace('assets/reused.js');
  values[0].exitCode = 17; values.splice(2, 0, event('assets/reused.js', 'metadata'));
  await writeEvents(directory, 1, values); await batch(directory, 1, { uploaded: 0, reused: 1 });
  const result = await collectAssetDiagnostics(directory);
  assert.equal(result.coverage.status, 'complete'); assert.equal(result.coverage.nonzeroEvents, 1);
  assert.equal(result.coverage.terminalFailures, 0);
});
test('one transferable failure summary preserves phase, retries, budget, component facts and next action', async (t) => {
  const { root, directory } = await fixture(t);
  const put = (name, value) => writeFile(join(root, name), JSON.stringify(value));
  await mkdir(join(root, 'operation-receipts'));
  await writeEvents(directory, 1, [event('assets/failed.js', 'public-head', 124, 60)]);
  await put('operation-receipts/operation-web.json', { releaseId: 'rc-20260911-116',
    manifestDigest: 'sha256:' + 'a'.repeat(64), component: 'web', outcome: 'failed',
    action: 'deploy', operationKey: 'run-1-web', secret: 'DO_NOT_EXPORT' });
  await put('web-budget.json', { operationSeconds: 1200, elapsedSeconds: 1201, deployExitCode: 124 });
  await put('web-rollback.json', { verified: true, objects: [{ key: 'sw.js', existed: true,
    digest: 'c'.repeat(64), targetDigest: 'd'.repeat(64), bytes: 'DO_NOT_EXPORT' }] });
  await put('reconcile.json', { outcome: 'needs_human', recovery: 'inspect_external_side_effects_before_resume' });
  const component = { gitSha: 'a'.repeat(40), artifactDigest: 'sha256:' + 'b'.repeat(64) };
  const matrix = { api: component, runtimeWorker: component, web: component,
    acs: { gitSha: 'a'.repeat(40), orchestratorArtifactDigest: component.artifactDigest,
      sandboxImageDigest: component.artifactDigest } };
  await put('reconcile-input.json', { before: matrix, target: matrix, observed: matrix,
    observationComplete: false, configIdentityConfirmed: true, externalSideEffects: 'unknown' });
  const result = await collectDiagnostics(root, join(root, 'out'));
  assert.equal(result.webAssets.events[0].phase, 'public-head');
  assert.equal(result.operationReceipts[0].outcome, 'failed'); assert.equal(result.budget.deployExitCode, 124);
  assert.equal(result.restoration.objects[0].key, 'sw.js');
  assert.equal(result.matrices.observationComplete, false);
  assert.equal(result.matrices.externalSideEffects, 'unknown');
  assert.equal(result.nextAction, 'inspect_external_side_effects_before_resume');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPORT/u);
});
