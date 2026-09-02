import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeEmergencyCommand, evaluateStage, sealIncidentResolved, validatePolicy, validateProductionPrerequisiteDocuments, validateRecovery, verifyStageReceipt } from '../scripts/rollout-contract.mjs';
import { inputFor, key, policy, prerequisites, release, resealSupport, resealTelemetry, sha } from './fixture-helper.mjs';

const at = Date.parse('2026-09-01T09:00:00.000Z');
const evaluate = (input, extra = {}) => evaluateStage(input, { policy, key, now: at, ...extra });

test('canonical policy fixes authoritative five-stage order and marks production facts pending', () => {
  assert.deepEqual(validatePolicy(policy), { valid: true, stages: 5, metrics: 10 });
  const canonical = structuredClone(policy); canonical.testFixture = false; canonical.status = 'pending_external_approval';
  for (const stage of canonical.stages) stage.approvedThresholdSource = 'pending_external_approval';
  assert.throws(() => validatePolicy(canonical, { production: true }), /pending_external_approval/);
});

test('valid explicit non-production mock contract advances the immutable five-stage chain', () => {
  let previous = null;
  for (const stage of policy.authoritativeOrder) {
    const receipt = evaluate(inputFor(stage, previous, { suffix: stage }));
    assert.equal(receipt.status, 'passed'); assert.equal(receipt.previousReceiptDigest, previous?.receiptDigest ?? 'GENESIS');
    assert.deepEqual(verifyStageReceipt(receipt, { key }).valid, true); previous = receipt;
  }
});

test('stage skip and backward transitions are rejected', () => {
  const skipped = inputFor('small-percentage'); skipped.currentState.lastPassedStage = null; assert.throws(() => evaluate(skipped), /skip\/backward/);
  const dogfood = evaluate(inputFor()); const backward = inputFor('employee-dogfood', dogfood); backward.currentState.lastPassedStage = 'closed-test';
  assert.throws(() => evaluate(backward), /skip\/backward/);
});

test('missing prerequisite and cross-SHA/artifact/release evidence fail closed', () => {
  const missing = inputFor(); delete missing.prerequisites.rcPass; assert.throws(() => evaluate(missing), /keys mismatch/);
  for (const [name, mutate] of [['cross SHA', (v) => v.prerequisites.rcPass.releaseSha = 'c'.repeat(40)], ['artifact', (v) => v.prerequisites.m60Submit.artifactSetDigest = `sha256:${'c'.repeat(64)}`], ['submit/build', (v) => v.prerequisites.m60Submit.buildEvidenceDigest = `sha256:${'c'.repeat(64)}`], ['telemetry binding', (v) => v.prerequisites.telemetryTestReceipt.providerContractDigest = `sha256:${'c'.repeat(64)}`]]) {
    const value = inputFor(); mutate(value); assert.throws(() => evaluate(value), /binding|cross-SHA/, name);
  }
});

for (const hardStop of policy.hardStops) test(`hard stop ${hardStop} is independently zero-tolerant`, () => {
  const input = inputFor(); input.telemetrySnapshot.hardStops[hardStop] = 1; resealTelemetry(input); const receipt = evaluate(input);
  assert.equal(receipt.status, 'stopped'); assert.deepEqual(receipt.stopReason, [hardStop]); assert.equal(receipt.metricResults.length, 0);
  assert.deepEqual(authorizeEmergencyCommand({ receipt, command: 'pause' }, { key }).authorized, true);
});

test('hard-stop override and emergency command without signed stopped receipt are rejected', () => {
  const pass = evaluate(inputFor()); assert.throws(() => authorizeEmergencyCommand({ receipt: pass, command: 'pause' }, { key }), /requires signed stopped receipt/);
  const hard = inputFor(); hard.telemetrySnapshot.hardStops.wrongAgentExecution = 1; resealTelemetry(hard); const stopped = evaluate(hard);
  assert.throws(() => authorizeEmergencyCommand({ receipt: stopped, command: 'resume' }, { key }), /override rejected|requires signed/);
  stopped.stopReason = []; assert.throws(() => authorizeEmergencyCommand({ receipt: stopped, command: 'pause' }, { key }), /tamper/);
});

test('soft metrics pass and a directional breach pauses without averaging hard stops', () => {
  assert.equal(evaluate(inputFor()).status, 'passed'); const input = inputFor(); input.telemetrySnapshot.metrics.loginSuccessRate.value = 0; resealTelemetry(input); const receipt = evaluate(input);
  assert.equal(receipt.status, 'paused'); assert.deepEqual(receipt.stopReason, ['loginSuccessRate']);
});

for (const [name, mutate, pattern, reseal = true] of [
  ['sample', (v) => v.telemetrySnapshot.metrics.crashFreeUsers.sampleSize = 1, /sample too small/],
  ['short window', (v) => v.telemetrySnapshot.observedFrom = '2026-09-01T08:59:20.000Z', /partial\/short/],
  ['partial', (v) => v.telemetrySnapshot.metrics.crashFreeUsers.partial = true, /partial/],
  ['cohort mismatch', (v) => v.telemetrySnapshot.cohortId = 'other-cohort', /cohort mismatch/],
  ['stale', (v) => { v.telemetrySnapshot.observedFrom = '2026-09-01T08:55:00.000Z'; v.telemetrySnapshot.observedTo = '2026-09-01T08:56:00.000Z'; v.telemetrySnapshot.collectedAt = '2026-09-01T08:57:00.000Z'; }, /stale/],
  ['future', (v) => { v.telemetrySnapshot.observedTo = '2026-09-01T09:01:30.000Z'; v.telemetrySnapshot.collectedAt = '2026-09-01T09:02:00.000Z'; }, /future/],
  ['NaN', (v) => v.telemetrySnapshot.metrics.crashFreeUsers.value = Number.NaN, /missing\/NaN/],
  ['tamper', (v) => v.telemetrySnapshot.metrics.crashFreeUsers.value = 0, /tamper/, false],
]) test(`snapshot rejects ${name}`, () => { const input = inputFor(); mutate(input); assert.throws(() => { if (reseal) resealTelemetry(input); evaluate(input); }, pattern); });

test('support/incident snapshot enforces owner, window, cohort, release and signature', () => {
  for (const mutate of [(v) => v.supportSnapshot.owner = '', (v) => v.supportSnapshot.cohortId = 'wrong', (v) => v.supportSnapshot.releaseSha = 'd'.repeat(40)]) {
    const input = inputFor(); mutate(input); resealSupport(input); assert.throws(() => evaluate(input), /owner|cohort mismatch|release mismatch/);
  }
  const tamper = inputFor(); tamper.supportSnapshot.supportTicketIds.push('ticket-x'); assert.throws(() => evaluate(tamper), /tamper/);
});

test('approval reuse, nonce replay and snapshot replay are rejected', () => {
  const approvalLedger = { approvals: new Set(['approval-employee-dogfood-1']) }; assert.throws(() => evaluate(inputFor(), { replayLedger: approvalLedger }), /approval replayed/);
  const nonceLedger = { nonces: new Set(['approval-nonce-employee-dogfood-1']) }; assert.throws(() => evaluate(inputFor(), { replayLedger: nonceLedger }), /nonce.*replayed/);
  const snapshotLedger = { snapshots: new Set(['telemetry-employee-dogfood-1']) }; assert.throws(() => evaluate(inputFor(), { replayLedger: snapshotLedger }), /snapshot replayed/);
});

test('stage approval cannot be reused for another stage and adapter must be configured', () => {
  const previous = evaluate(inputFor()); const next = inputFor('closed-test', previous); next.approval.environment = 'mobile-rollout-gate-employee-dogfood'; assert.throws(() => evaluate(next), /approval mismatch/);
  const missing = inputFor(); missing.adapterReceipt.configured = false; assert.throws(() => evaluate(missing), /adapter unconfigured/);
});

test('hash-chain tamper is rejected', () => {
  const first = evaluate(inputFor()); const next = inputFor('closed-test', first); next.previousReceipt.receiptDigest = `sha256:${'f'.repeat(64)}`; next.currentState.lastReceiptDigest = next.previousReceipt.receiptDigest;
  assert.throws(() => evaluate(next), /tamper|digest\/hash chain/);
});

test('incident recovery requires resolved receipt, fix SHA, new artifacts and rerun M70-01/02', () => {
  const hard = inputFor(); hard.telemetrySnapshot.hardStops.signatureFailure = 1; resealTelemetry(hard); const stopped = evaluate(hard);
  const fixRelease = { sha: 'c'.repeat(40), releaseId: 'fixture-release-2', artifactSetDigest: `sha256:${'d'.repeat(64)}` };
  const incidentResolvedReceipt = sealIncidentResolved({ status: 'resolved', stoppedReceiptDigest: stopped.receiptDigest, incidentId: 'incident-1', owner: 'mobile-oncall', resolvedAt: '2026-09-01T09:05:00.000Z' }, key);
  const recovery = { mode: 'contract', fixSha: fixRelease.sha, release: fixRelease, incidentResolvedReceipt, prerequisites: prerequisites(fixRelease) };
  assert.deepEqual(validateRecovery(recovery, { stoppedReceipt: stopped, policy, key }).restartAt, 'employee-dogfood');
  const original = structuredClone(recovery); original.fixSha = release.sha; original.release.sha = release.sha; assert.throws(() => validateRecovery(original, { stoppedReceipt: stopped, policy, key }), /original SHA/);
  const oldArtifacts = structuredClone(recovery); oldArtifacts.release.artifactSetDigest = stopped.release.artifactSetDigest; oldArtifacts.prerequisites = prerequisites(oldArtifacts.release); assert.throws(() => validateRecovery(oldArtifacts, { stoppedReceipt: stopped, policy, key }), /new artifacts/);
  const cross = structuredClone(recovery); cross.prerequisites.rcPass.releaseSha = sha; assert.throws(() => validateRecovery(cross, { stoppedReceipt: stopped, policy, key }), /cross-SHA/);
});

test('production rejects fixture policy/evidence/provider and missing thresholds/dashboard', () => {
  const input = inputFor(); input.mode = 'production'; assert.throws(() => evaluateStage(input, { policy, key, now: at }), /production rejects|pending_external/);
  const missingThreshold = structuredClone(policy); delete missingThreshold.thresholds['employee-dogfood'].crashFreeUsers; assert.throws(() => validatePolicy(missingThreshold), /thresholds incomplete/);
  const missingDashboard = inputFor(); missingDashboard.telemetrySnapshot.dashboardId = ''; resealTelemetry(missingDashboard); assert.throws(() => evaluate(missingDashboard), /dashboardId invalid/);
});


test('production prerequisite document validation is mandatory while contract fixtures never impersonate it', async () => {
  assert.deepEqual(await validateProductionPrerequisiteDocuments(inputFor()), { valid: true, mode: 'contract' });
  const production = inputFor(); production.mode = 'production';
  await assert.rejects(() => validateProductionPrerequisiteDocuments(production), /validator keys\/evidence root missing/);
});
