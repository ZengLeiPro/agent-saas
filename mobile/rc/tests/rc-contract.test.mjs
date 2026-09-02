import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AUTHORITATIVE_DIMENSIONS, HARD_STOPS, digestValue, sealBundle, validatePlan, validateRcEvidence,
} from '../scripts/rc-contract.mjs';
import { runCase } from '../scripts/run-rc-case.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = JSON.parse(await readFile(path.join(root, 'rc-plan.json'), 'utf8'));
const key = 'm70-contract-fixture-hmac-key-0000000000000000';
const sha = '1'.repeat(40);
const digest = (seed) => `sha256:${seed.repeat(64)}`;

function m60Fixture() {
  return {
    nativeReceipts: AUTHORITATIVE_DIMENSIONS.platformSlot.map((slot, index) => ({
      slot, path: `m60/native/${slot}/receipt.json`, digest: digest(String(index + 1)),
      evidenceKind: 'deterministic-mock', buildSha: sha,
      receiptId: String(index + 1).repeat(64), testRunId: `m60-02-contract-${slot}`,
    })),
    releaseEvidence: {
      path: 'm60/release/build-evidence.json', digest: digest('5'), evidenceKind: 'deterministic-mock', commitSha: sha,
      artifacts: ['ios-store', 'android-store', 'android-enterprise'].map((profile, index) => ({
        profile, artifactDigest: digest(String(index + 6)), verified: true,
      })),
    },
    telemetry: {
      evidenceKind: 'deterministic-mock', release: sha, contractDigest: digest('9'),
      contract: { path: 'm60/telemetry/contract.json', digest: digest('a') },
      receipt: { path: 'm60/telemetry/receipt.json', digest: digest('b') },
    },
  };
}
function resultFixture(item, index) {
  const native = m60Fixture().nativeReceipts.find((entry) => entry.slot === item.platformSlot);
  return {
    caseId: item.id, testRunId: `contract-run-${item.id}`, attempt: 1, priorFailureReceiptIds: [], flowHash: String((index % 8) + 1).repeat(64), status: 'pass',
    startedAt: '2026-09-01T06:00:00.000Z', endedAt: '2026-09-01T06:01:00.000Z',
    evidenceKind: 'mock', explicitContractMock: true,
    source: { commitSha: sha, buildId: `contract-build-${item.platformSlot}`, profile: 'contract', artifactDigest: digest('6') },
    deviceReceipt: { slot: item.platformSlot, receiptId: (index + 10).toString(16).padStart(64, '0'), digest: digest('d'), path: 'provider-receipt.json', m60ReceiptId: native.receiptId },
    assertions: item.expectedInvariants.map((invariant) => ({ invariant, passed: true })),
    screenshots: [{ path: `${item.id}/screen.png`, digest: digest('e') }],
    log: { path: `${item.id}/limited.log`, digest: digest('f') }, defects: [],
    hardStops: Object.fromEntries(HARD_STOPS.map((name) => [name, 0])),
  };
}
function bundleFixture() {
  const caseResults = plan.cases.map(resultFixture);
  return sealBundle({
    schemaVersion: '1.0.0', mode: 'contract', explicitContractMock: true, planId: plan.planId,
    planDigest: digestValue(plan), commitSha: sha, profile: 'contract', expiresAt: '2099-01-01T00:00:00.000Z',
    m60: m60Fixture(), caseResults,
    summary: { pass: caseResults.length, fail: 0, blocked: 0, skipped: 0, openP0: 0, openP1: 0 },
  }, key);
}
function reseal(bundle) { return sealBundle(structuredClone((({ integrity: _i, ...rest }) => rest)(bundle)), key); }
async function rejectsMutation(name, mutate, pattern) {
  await test(name, async () => {
    const value = bundleFixture(); mutate(value); const sealed = reseal(value);
    await assert.rejects(() => validateRcEvidence(sealed, { plan, hmacKey: key, now: Date.parse('2026-09-01T08:00:00Z') }), pattern);
  });
}

test('M70-01 plan covers every authoritative value, permission pair and declared high-risk pair', () => {
  const result = validatePlan(plan);
  assert.equal(result.caseCount, 24);
  for (const [dimension, values] of Object.entries(AUTHORITATIVE_DIMENSIONS)) assert.deepEqual([...result.covered[dimension]].sort(), [...values].sort());
  const permissionPairs = new Set(plan.cases.map((item) => `${item.permissionResource}:${item.permissionDecision}`));
  assert.equal(permissionPairs.size, 9);
  assert.equal(plan.highRiskPairs.length, 7);
});

test('M70-01 plan/schema and evidence/schema are machine-readable JSON schemas', async () => {
  for (const name of ['rc-plan.schema.json', 'rc-evidence.schema.json']) {
    const schema = JSON.parse(await readFile(path.join(root, 'schema', name), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
  }
});

test('M70-01 accepts an explicitly labeled mock only in contract mode', async () => {
  const result = await validateRcEvidence(bundleFixture(), { plan, hmacKey: key, now: Date.parse('2026-09-01T08:00:00Z') });
  assert.deepEqual(result.statuses, { pass: 24, fail: 0, blocked: 0, skipped: 0 });
});

test('M70-01 runner binds build/profile/device receipt/flow/time/screenshots/logs in explicit contract mode', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'm70-runner-')); const outputDir = path.join(temp, 'case');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir));
  await writeFile(path.join(outputDir, 'shot.png'), Buffer.from('contract screenshot'));
  await writeFile(path.join(outputDir, 'provider.log'), 'bounded redacted contract log\n');
  const item = plan.cases[0];
  const raw = {
    schemaVersion: '1.0.0', caseId: item.id, evidenceKind: 'mock', status: 'pass',
    startedAt: '2026-09-01T06:00:00.000Z', endedAt: '2026-09-01T06:01:00.000Z',
    flowHash: 'a'.repeat(64), providerReceiptId: 'b'.repeat(64), device: { slot: item.platformSlot },
    assertions: item.expectedInvariants.map((invariant) => ({ invariant, passed: true })),
    screenshotPaths: ['shot.png'], logPath: 'provider.log', defects: [],
    hardStops: Object.fromEntries(HARD_STOPS.map((name) => [name, 0])),
  };
  const fixture = path.join(temp, 'provider-fixture.json'); await writeFile(fixture, JSON.stringify(raw));
  const result = await runCase({ plan: path.join(root, 'rc-plan.json'), caseId: item.id, mode: 'contract', fixture,
    buildSha: sha, buildId: 'contract-build-ios', profile: 'contract', artifactDigest: digest('6'),
    m60ReceiptId: '1'.repeat(64), testRunId: 'contract-runner-001', attempt: '1', outputDir });
  assert.equal(result.deviceReceipt.digest, digestValue(JSON.stringify(raw)));
  assert.equal(result.source.buildId, 'contract-build-ios'); assert.equal(result.screenshots.length, 1);
});

test('M70-01 rejects a tampered sealed bundle', async () => {
  const value = bundleFixture(); value.caseResults[0].status = 'fail';
  await assert.rejects(() => validateRcEvidence(value, { plan, hmacKey: key }), /tampered/);
});

await rejectsMutation('M70-01 rejects missing dimension result', (v) => v.caseResults.pop(), /coverage/);
await rejectsMutation('M70-01 rejects duplicate case result', (v) => v.caseResults[1].caseId = v.caseResults[0].caseId, /coverage/);
await rejectsMutation('M70-01 rejects replayed testRunId', (v) => v.caseResults[1].testRunId = v.caseResults[0].testRunId, /replayed testRunId/);
await rejectsMutation('M70-01 rejects replayed device receipt', (v) => v.caseResults[1].deviceReceipt.receiptId = v.caseResults[0].deviceReceipt.receiptId, /replayed testRunId\/device receipt/);
await rejectsMutation('M70-01 rejects cross-SHA case evidence', (v) => v.caseResults[0].source.commitSha = '2'.repeat(40), /source commit\/profile mismatch/);
await rejectsMutation('M70-01 rejects cross-SHA M60-02 evidence', (v) => v.m60.nativeReceipts[0].buildSha = '2'.repeat(40), /cross-SHA/);
await rejectsMutation('M70-01 rejects duplicate M60-02 receipt', (v) => v.m60.nativeReceipts[1].receiptId = v.m60.nativeReceipts[0].receiptId, /replayed receipt/);
await rejectsMutation('M70-01 rejects duplicate M60-02 testRunId', (v) => v.m60.nativeReceipts[1].testRunId = v.m60.nativeReceipts[0].testRunId, /replayed receipt\/testRunId/);
await rejectsMutation('M70-01 rejects incomplete four-slot binding', (v) => v.m60.nativeReceipts.pop(), /four-slot binding/);
await rejectsMutation('M70-01 rejects unsupported device slot', (v) => v.m60.nativeReceipts[0].slot = 'ios-simulator', /four-slot binding/);
await rejectsMutation('M70-01 rejects incomplete three-artifact binding', (v) => v.m60.releaseEvidence.artifacts.pop(), /three-artifact binding/);
await rejectsMutation('M70-01 rejects unverified release artifact', (v) => v.m60.releaseEvidence.artifacts[0].verified = false, /not verified/);
await rejectsMutation('M70-01 rejects mixed real/mock M60-04 label', (v) => v.m60.releaseEvidence.evidenceKind = 'verified-artifacts', /cannot satisfy contract/);
await rejectsMutation('M70-01 rejects case artifact outside M60-04 verified set', (v) => v.caseResults[0].source.artifactDigest = digest('c'), /not one of the M60-04 verified artifacts/);
await rejectsMutation('M70-01 rejects missing build binding', (v) => { delete v.caseResults[0].source.buildId; }, /source.buildId is invalid/);
await rejectsMutation('M70-01 rejects missing screenshot evidence', (v) => v.caseResults[0].screenshots = [], /screenshot evidence is required/);
await rejectsMutation('M70-01 rejects rerun that tries to clear failure without fix lineage', (v) => { v.caseResults[0].attempt = 2; }, /rerun cannot clear failure/);
await rejectsMutation('M70-01 rejects retry lineage without current fix commit', (v) => {
  v.caseResults[0].attempt = 2;
  v.caseResults[0].priorFailureReceiptIds = ['old-failed-receipt'];
  v.caseResults[0].retryOf = { testRunId: 'old-run', failedReceiptId: 'old-failed-receipt', fixCommitSha: '2'.repeat(40) };
}, /retry must bind the current fix commit/);
await rejectsMutation('M70-01 rejects expired evidence', (v) => v.expiresAt = '2026-09-01T07:00:00.000Z', /expired/);
await rejectsMutation('M70-01 rejects simulator label', (v) => v.caseResults[0].evidenceKind = 'simulator', /simulator\/mock\/native/);
await rejectsMutation('M70-01 rejects implicit contract mock', (v) => v.caseResults[0].explicitContractMock = false, /explicitly contract-only/);
await rejectsMutation('M70-01 rejects production use of deterministic M60 mock', (v) => { v.mode = 'production'; v.explicitContractMock = false; }, /cannot satisfy production/);
await rejectsMutation('M70-01 hard-stops identity leak without averaging', (v) => v.caseResults[0].hardStops.identityLeak = 1, /hard-stop identityLeak is non-zero/);
await rejectsMutation('M70-01 hard-stops wrong Agent execution', (v) => v.caseResults[0].hardStops.wrongAgentExecution = 1, /hard-stop wrongAgentExecution is non-zero/);
await rejectsMutation('M70-01 hard-stops duplicate execution', (v) => v.caseResults[0].hardStops.duplicateExecution = 1, /hard-stop duplicateExecution is non-zero/);
await rejectsMutation('M70-01 hard-stops signature failure', (v) => v.caseResults[0].hardStops.signatureFailure = 1, /hard-stop signatureFailure is non-zero/);
await rejectsMutation('M70-01 hard-stops upgrade failure', (v) => v.caseResults[0].hardStops.upgradeFailure = 1, /hard-stop upgradeFailure is non-zero/);
await rejectsMutation('M70-01 rejects open P0', (v) => { v.caseResults[0].defects.push({ severity: 'P0', status: 'open', url: 'https://defects.example/M70-1' }); v.summary.openP0 = 1; }, /P0\/P1 open count = 0/);
await rejectsMutation('M70-01 rejects open P1', (v) => { v.caseResults[0].defects.push({ severity: 'P1', status: 'open', url: 'https://defects.example/M70-2' }); v.summary.openP1 = 1; }, /P0\/P1 open count = 0/);
for (const status of ['blocked', 'skipped']) {
  test(`M70-01 rejects ${status} in production before averaging`, async () => {
    const value = bundleFixture();
    value.mode = 'production'; value.explicitContractMock = false;
    for (const native of value.m60.nativeReceipts) native.evidenceKind = 'real-device';
    value.m60.releaseEvidence.evidenceKind = 'verified-artifacts';
    value.m60.telemetry.evidenceKind = 'production-provider';
    for (const result of value.caseResults) { result.evidenceKind = 'real-device'; result.explicitContractMock = false; }
    value.caseResults[0].status = status; value.summary.pass -= 1; value.summary[status] += 1;
    await assert.rejects(
      () => validateRcEvidence(reseal(value), { plan, hmacKey: key, now: Date.parse('2026-09-01T08:00:00Z') }),
      new RegExp(`production result cannot be ${status}`),
    );
  });
}
