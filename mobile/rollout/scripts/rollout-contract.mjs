import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateBuildEvidence, validateSubmitReceipt } from '../../scripts/mobile-release-evidence.mjs';
import { providerContractDigest, validateProviderContract, validateTestEventReceipt } from '../../scripts/mobile-telemetry-release-gate.mjs';
import { validateRcEvidence } from '../../rc/scripts/rc-contract.mjs';
import { validateRehearsalEvidence } from '../../rehearsal/scripts/rehearsal-contract.mjs';

export const STAGES = Object.freeze(['employee-dogfood', 'closed-test', 'small-percentage', 'expanded', 'full']);
export const HARD_STOPS = Object.freeze(['crossAccountIdentityLeak', 'crossTenantIdentityLeak', 'wrongAgentExecution', 'signatureFailure', 'upgradeFailure', 'duplicateRunExecution']);
export const PREREQUISITES = Object.freeze(['m60Build', 'm60Submit', 'telemetryProvider', 'telemetryTestReceipt', 'rcPass', 'upgradePass']);
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const PURPOSES = Object.freeze({ telemetry: 'm70-03-telemetry-snapshot-v1', support: 'm70-03-support-snapshot-v1', receipt: 'm70-03-stage-receipt-v1', incident: 'm70-03-incident-resolved-v1' });

function fail(message) { throw new Error(`[M70-03] ${message}`); }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be object`); return value; }
function text(value, label, pattern = ID) { if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} invalid`); return value; }
function finite(value, label) { if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} missing/NaN`); return value; }
function positiveInteger(value, label) { if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be positive integer`); return value; }
function instant(value, label) { const time = Date.parse(value); if (typeof value !== 'string' || !Number.isFinite(time) || new Date(time).toISOString() !== value) fail(`${label} invalid`); return time; }
function exactKeys(value, keys, label) { object(value, label); const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.join('\0') !== expected.join('\0')) fail(`${label} keys mismatch`); }

export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('numeric value missing/NaN'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('unsupported canonical value');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}
export function digestValue(value) { return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`; }
function unsigned(value) { const copy = structuredClone(value); delete copy.signature; delete copy.receiptDigest; return copy; }
function signatureValue(value, key, purpose) { return createHmac('sha256', key).update(`${purpose}\0${canonicalize(unsigned(value))}`).digest('hex'); }
export function sealDocument(value, key, purpose) { if (!key || key.length < 32) fail('signing key must contain at least 32 characters'); const sealed = structuredClone(value); sealed.signature = { algorithm: 'HMAC-SHA256', keyId: 'explicit-test-or-protected-key', value: signatureValue(sealed, key, purpose) }; if (purpose === PURPOSES.receipt) sealed.receiptDigest = digestValue(unsigned(sealed)); return sealed; }
function verifyDocument(value, key, purpose, label) {
  object(value, label); exactKeys(value.signature, ['algorithm', 'keyId', 'value'], `${label}.signature`);
  if (value.signature.algorithm !== 'HMAC-SHA256') fail(`${label} signature algorithm invalid`);
  if (!key || key.length < 32) fail(`${label} trusted signing key missing`);
  const expected = Buffer.from(signatureValue(value, key, purpose), 'hex'); const actual = Buffer.from(value.signature.value ?? '', 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail(`${label} signature/tamper verification failed`);
  if (purpose === PURPOSES.receipt && value.receiptDigest !== digestValue(unsigned(value))) fail(`${label} receipt digest/hash chain tampered`);
}

export function validatePolicy(policy, { production = false } = {}) {
  object(policy, 'policy');
  if (policy.schemaVersion !== '1.0.0' || policy.policyId !== 'M70-03') fail('policy schema/id invalid');
  if (JSON.stringify(policy.authoritativeOrder) !== JSON.stringify(STAGES)) fail('authoritative stage order changed');
  if (JSON.stringify(policy.hardStops) !== JSON.stringify(HARD_STOPS)) fail('hard-stop list changed');
  if (!Array.isArray(policy.stages) || policy.stages.length !== STAGES.length) fail('stage definitions incomplete');
  const metricNames = Object.keys(policy.metrics ?? {});
  if (metricNames.length !== 10) fail('soft metric inventory incomplete');
  for (const [name, definition] of Object.entries(policy.metrics)) if (!['>=', '<='].includes(definition.direction) || !['ratio', 'count'].includes(definition.unit)) fail(`metric ${name} definition invalid`);
  for (const [index, stage] of policy.stages.entries()) {
    if (stage.id !== STAGES[index]) fail('stage skip/backward/reorder policy rejected');
    object(stage.cohort, `${stage.id}.cohort`); object(stage.traffic, `${stage.id}.traffic`); object(stage.manualApproval, `${stage.id}.manualApproval`);
    if (stage.traffic.min !== 'pending_external_approval' && (!Number.isFinite(stage.traffic.min) || !Number.isFinite(stage.traffic.max) || stage.traffic.min > stage.traffic.max)) fail(`${stage.id} traffic min/max invalid`);
    if (stage.metricChecks !== 'all' || stage.exitReceipt !== 'signed-stage-receipt-v1' || stage.manualApproval.required !== true || stage.manualApproval.environment !== `mobile-rollout-gate-${stage.id}`) fail(`${stage.id} gate definition invalid`);
    if (!Array.isArray(stage.entryEvidence) || stage.entryEvidence.length === 0) fail(`${stage.id} entry evidence missing`);
    if (production && [stage.cohort.definition, stage.traffic.min, stage.traffic.max, stage.observationWindowSeconds, stage.snapshotFreshnessSeconds, stage.minimumSampleSize, stage.approvedThresholdSource].includes('pending_external_approval')) fail(`${stage.id} thresholds/provider facts pending_external_approval; production fail closed`);
  }
  if (production && (policy.testFixture || policy.status !== 'approved')) fail('production rejects mock/simulator/test fixture/pending policy');
  if (!production && (!policy.testFixture || policy.status !== 'approved_test_fixture')) fail('contract policy must be explicit non-production fixture');
  for (const stage of STAGES) {
    const values = policy.thresholds?.[stage];
    if (!values || Object.keys(values).sort().join() !== [...metricNames].sort().join()) fail(`${stage} thresholds incomplete`);
  }
  return { valid: true, stages: STAGES.length, metrics: metricNames.length };
}

function validateReleaseBinding(value, label, release) {
  object(value, label); text(value.digest, `${label}.digest`, DIGEST); text(value.releaseSha, `${label}.releaseSha`, SHA); text(value.releaseId, `${label}.releaseId`); text(value.artifactSetDigest, `${label}.artifactSetDigest`, DIGEST);
  if (value.releaseSha !== release.sha || value.releaseId !== release.releaseId || value.artifactSetDigest !== release.artifactSetDigest) fail(`${label} cross-SHA/artifact/release binding`);
  if (value.status !== 'pass') fail(`${label} is not pass evidence`);
}
function validatePrerequisites(prerequisites, release, mode) {
  exactKeys(prerequisites, PREREQUISITES, 'prerequisites');
  const kinds = { m60Build: 'm60-build-evidence', m60Submit: 'm60-submit-receipt', telemetryProvider: 'm60-telemetry-provider-contract', telemetryTestReceipt: 'm60-telemetry-test-receipt', rcPass: 'm70-01-rc-pass', upgradePass: 'm70-02-upgrade-pass' };
  for (const name of PREREQUISITES) {
    const item = prerequisites[name]; validateReleaseBinding(item, `prerequisites.${name}`, release);
    if (item.kind !== kinds[name]) fail(`prerequisites.${name} kind invalid`);
    if (mode === 'production' && item.evidenceKind !== 'production') fail(`prerequisites.${name} production rejects mock/simulator`);
    if (mode === 'contract' && item.evidenceKind !== 'explicit-non-production-fixture') fail(`prerequisites.${name} contract fixture must be explicit`);
  }
  if (prerequisites.m60Submit.buildEvidenceDigest !== prerequisites.m60Build.digest) fail('M60 submit/build binding mismatch');
  if (prerequisites.telemetryTestReceipt.providerContractDigest !== prerequisites.telemetryProvider.digest) fail('M60 telemetry provider/test receipt binding mismatch');
}
function validateSnapshotTimes(snapshot, stage, now, label) {
  const from = instant(snapshot.observedFrom, `${label}.observedFrom`); const to = instant(snapshot.observedTo, `${label}.observedTo`); const collected = instant(snapshot.collectedAt, `${label}.collectedAt`);
  if (to < from || to - from < stage.observationWindowSeconds * 1000) fail(`${label} partial/short observation window`);
  if (collected < to) fail(`${label} collected before window ends`);
  if (collected > now + 60_000) fail(`${label} future snapshot`);
  if (now - collected > stage.snapshotFreshnessSeconds * 1000) fail(`${label} stale snapshot`);
}
function validateSnapshotBinding(snapshot, input, stage, label) {
  if (snapshot.releaseSha !== input.release.sha || snapshot.releaseId !== input.release.releaseId || snapshot.artifactSetDigest !== input.release.artifactSetDigest) fail(`${label} release mismatch`);
  if (snapshot.stageId !== stage.id || snapshot.cohortId !== input.cohortId || snapshot.cohortDefinition !== stage.cohort.definition) fail(`${label} cohort mismatch`);
}
function replay(value, ledger, label) { if (ledger?.has(value)) fail(`${label} replayed`); }


async function readBoundJson(root, relative, label) {
  text(relative, `${label}.path`, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/u); const base = path.resolve(root); const file = path.resolve(base, relative);
  if (!file.startsWith(`${base}${path.sep}`)) fail(`${label} path escapes evidence root`);
  return JSON.parse(await readFile(file, 'utf8'));
}
function boundRoot(root, relative, label) { text(relative, label, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/u); const base = path.resolve(root); const target = path.resolve(base, relative); if (target !== base && !target.startsWith(`${base}${path.sep}`)) fail(`${label} escapes evidence root`); return target; }
export async function validateProductionPrerequisiteDocuments(input, { evidenceRoot, releasePublicKeys, telemetryHmacKey, rcHmacKey, nativeHmacKey } = {}) {
  if (input.mode !== 'production') return { valid: true, mode: 'contract' };
  if (!evidenceRoot || !releasePublicKeys || !telemetryHmacKey || !rcHmacKey || !nativeHmacKey) fail('production authoritative validator keys/evidence root missing');
  const refs = object(input.prerequisiteDocuments, 'prerequisiteDocuments');
  const required = ['m60BuildPath', 'm60SubmitPath', 'telemetryProviderPath', 'telemetryTestReceiptPath', 'rcBundlePath', 'rcPlanPath', 'rcResultsRoot', 'rehearsalBundlePath', 'rehearsalPlanPath', 'rehearsalEvidenceRoot'];
  exactKeys(refs, required, 'prerequisiteDocuments');
  const build = await readBoundJson(evidenceRoot, refs.m60BuildPath, 'm60Build'); validateBuildEvidence(build, { publicKeys: releasePublicKeys });
  const submit = await readBoundJson(evidenceRoot, refs.m60SubmitPath, 'm60Submit'); validateSubmitReceipt(submit, { buildEvidence: build, publicKeys: releasePublicKeys });
  const telemetryProvider = await readBoundJson(evidenceRoot, refs.telemetryProviderPath, 'telemetryProvider'); validateProviderContract(telemetryProvider, { production: true, release: input.release.sha });
  const telemetryReceipt = await readBoundJson(evidenceRoot, refs.telemetryTestReceiptPath, 'telemetryTestReceipt'); validateTestEventReceipt(telemetryReceipt, telemetryProvider, { release: input.release.sha, key: telemetryHmacKey });
  const rcBundle = await readBoundJson(evidenceRoot, refs.rcBundlePath, 'rcBundle'); const rcPlan = await readBoundJson(evidenceRoot, refs.rcPlanPath, 'rcPlan');
  await validateRcEvidence(rcBundle, { plan: rcPlan, hmacKey: rcHmacKey, nativeHmacKey, telemetryHmacKey, releasePublicKeys, evidenceRoot: path.resolve(evidenceRoot), resultsRoot: boundRoot(evidenceRoot, refs.rcResultsRoot, 'rcResultsRoot') });
  const rehearsalBundle = await readBoundJson(evidenceRoot, refs.rehearsalBundlePath, 'rehearsalBundle'); const rehearsalPlan = await readBoundJson(evidenceRoot, refs.rehearsalPlanPath, 'rehearsalPlan');
  await validateRehearsalEvidence(rehearsalBundle, { plan: rehearsalPlan, evidenceRoot: boundRoot(evidenceRoot, refs.rehearsalEvidenceRoot, 'rehearsalEvidenceRoot'), releasePublicKeys });
  const actual = { m60Build: build.canonicalDigest, m60Submit: submit.canonicalDigest, telemetryProvider: providerContractDigest(telemetryProvider), telemetryTestReceipt: digestValue(telemetryReceipt), rcPass: digestValue(rcBundle), upgradePass: digestValue(rehearsalBundle) };
  for (const [name, digest] of Object.entries(actual)) if (input.prerequisites[name].digest !== digest) fail(`prerequisites.${name} document digest mismatch`);
  if (build.commitOid !== input.release.sha || rcBundle.commitSha !== input.release.sha || rehearsalBundle.commitSha !== input.release.sha) fail('authoritative prerequisite document cross-SHA');
  return { valid: true, mode: 'production', releaseSha: input.release.sha };
}

export function evaluateStage(input, { policy, key, now = Date.now(), replayLedger = {} } = {}) {
  const production = input.mode === 'production'; if (!production && input.mode !== 'contract') fail('mode invalid'); validatePolicy(policy, { production });
  object(input.release, 'release'); text(input.release.sha, 'release.sha', SHA); text(input.release.releaseId, 'release.releaseId'); text(input.release.artifactSetDigest, 'release.artifactSetDigest', DIGEST);
  const targetIndex = STAGES.indexOf(input.targetStage); if (targetIndex < 0) fail('target stage invalid');
  const expectedPrevious = targetIndex === 0 ? null : STAGES[targetIndex - 1];
  if ((input.currentState?.lastPassedStage ?? null) !== expectedPrevious) fail('stage skip/backward transition rejected');
  const previousDigest = targetIndex === 0 ? 'GENESIS' : input.currentState?.lastReceiptDigest;
  if (targetIndex > 0) { text(previousDigest, 'currentState.lastReceiptDigest', DIGEST); if (input.previousReceipt?.receiptDigest !== previousDigest) fail('previous receipt/hash chain mismatch'); verifyStageReceipt(input.previousReceipt, { key }); if (input.previousReceipt.status !== 'passed' || input.previousReceipt.stageId !== expectedPrevious || input.previousReceipt.release.sha !== input.release.sha || input.previousReceipt.release.artifactSetDigest !== input.release.artifactSetDigest) fail('previous stage pass receipt invalid'); }
  validatePrerequisites(input.prerequisites, input.release, input.mode);
  const stage = policy.stages[targetIndex];
  object(input.approval, 'approval'); if (input.approval.environment !== stage.manualApproval.environment || input.approval.stageId !== stage.id) fail('protected environment approval mismatch');
  for (const field of ['approvalId', 'deploymentId', 'nonce']) text(input.approval[field], `approval.${field}`); instant(input.approval.approvedAt, 'approval.approvedAt'); replay(input.approval.approvalId, replayLedger.approvals, 'approval'); replay(input.approval.nonce, replayLedger.nonces, 'approval nonce');
  object(input.adapterReceipt, 'adapterReceipt'); if (input.adapterReceipt.configured !== true || input.adapterReceipt.status !== 'accepted' || input.adapterReceipt.stageId !== stage.id || input.adapterReceipt.releaseSha !== input.release.sha || input.adapterReceipt.artifactSetDigest !== input.release.artifactSetDigest) fail('provider rollout adapter unconfigured/rejected/mismatched');
  if (production && /mock|fixture|simulator/i.test(input.adapterReceipt.provider ?? '')) fail('production rejects mock/simulator provider');
  const telemetry = input.telemetrySnapshot; verifyDocument(telemetry, key, PURPOSES.telemetry, 'telemetry snapshot'); validateSnapshotBinding(telemetry, input, stage, 'telemetry snapshot'); validateSnapshotTimes(telemetry, stage, now, 'telemetry snapshot');
  for (const field of ['provider', 'dashboardId', 'queryId', 'queryDigest', 'snapshotId']) text(telemetry[field], `telemetry.${field}`, field === 'queryDigest' ? DIGEST : ID);
  if (production && /pending_external_approval|mock|fixture|simulator/i.test(`${telemetry.provider} ${telemetry.dashboardId}`)) fail('production provider/dashboard absent or mock');
  replay(telemetry.snapshotId, replayLedger.snapshots, 'telemetry snapshot');
  const support = input.supportSnapshot; verifyDocument(support, key, PURPOSES.support, 'support/incident snapshot'); validateSnapshotBinding(support, input, stage, 'support/incident snapshot'); validateSnapshotTimes(support, stage, now, 'support/incident snapshot'); text(support.owner, 'support.owner'); text(support.snapshotId, 'support.snapshotId'); replay(support.snapshotId, replayLedger.snapshots, 'support snapshot');
  for (const field of ['incidentIds', 'supportTicketIds']) if (!Array.isArray(support[field]) || new Set(support[field]).size !== support[field].length) fail(`support.${field} invalid/replayed`);
  const hardStops = telemetry.hardStops; exactKeys(hardStops, HARD_STOPS, 'hardStops');
  for (const name of HARD_STOPS) if (!Number.isSafeInteger(hardStops[name]) || hardStops[name] < 0) fail(`hard-stop ${name} invalid`);
  const triggered = HARD_STOPS.filter((name) => hardStops[name] !== 0);
  const receiptBase = { schemaVersion: '1.0.0', policyId: policy.policyId, policyDigest: digestValue(policy), release: structuredClone(input.release), stageId: stage.id, previousReceiptDigest: previousDigest, approvalId: input.approval.approvalId, telemetrySnapshotDigest: digestValue(telemetry), supportSnapshotDigest: digestValue(support), adapterReceiptDigest: digestValue(input.adapterReceipt), evaluatedAt: new Date(now).toISOString(), nonce: input.receiptNonce };
  text(input.receiptNonce, 'receiptNonce'); replay(input.receiptNonce, replayLedger.nonces, 'receipt nonce');
  if (triggered.length) return sealDocument({ ...receiptBase, status: 'stopped', hardStops: structuredClone(hardStops), metricResults: [], stopReason: triggered, commandContract: { allowed: ['pause', 'rollback'], requiresSignedStoppedReceipt: true, provider: input.adapterReceipt.provider }, recommendations: ['pause rollout immediately', 'activate capability kill switch', 'open identity/message integrity incident'] }, key, PURPOSES.receipt);
  exactKeys(telemetry.metrics, Object.keys(policy.metrics), 'telemetry.metrics'); const metricResults = [];
  for (const [name, definition] of Object.entries(policy.metrics)) {
    const metric = object(telemetry.metrics[name], `metrics.${name}`); const value = finite(metric.value, `metrics.${name}.value`); positiveInteger(metric.sampleSize, `metrics.${name}.sampleSize`); if (metric.partial !== false) fail(`metrics.${name} partial`); if (metric.sampleSize < stage.minimumSampleSize) fail(`metrics.${name} sample too small`);
    const threshold = finite(policy.thresholds?.[stage.id]?.[name], `threshold.${stage.id}.${name}`); const passed = definition.direction === '>=' ? value >= threshold : value <= threshold; metricResults.push({ name, direction: definition.direction, value, threshold, sampleSize: metric.sampleSize, passed });
  }
  if (telemetry.metrics.identityTenantAgentIncidentCount.value !== support.incidentIds.length) fail('identity/tenant/Agent incident snapshot count mismatch');
  if (telemetry.metrics.supportTicketCount.value !== support.supportTicketIds.length) fail('support ticket snapshot count mismatch');
  const failed = metricResults.filter((item) => !item.passed).map((item) => item.name);
  return sealDocument({ ...receiptBase, status: failed.length ? 'paused' : 'passed', hardStops: structuredClone(hardStops), metricResults, stopReason: failed, commandContract: null, recommendations: failed.length ? ['hold stage; investigate soft metric breach'] : [] }, key, PURPOSES.receipt);
}

export function verifyStageReceipt(receipt, { key } = {}) { verifyDocument(receipt, key, PURPOSES.receipt, 'stage receipt'); if (!STAGES.includes(receipt.stageId) || !['passed', 'paused', 'stopped'].includes(receipt.status)) fail('stage receipt status/stage invalid'); return { valid: true, status: receipt.status, digest: receipt.receiptDigest }; }
export function authorizeEmergencyCommand({ receipt, command }, { key } = {}) { verifyStageReceipt(receipt, { key }); if (receipt.status !== 'stopped' || !receipt.commandContract?.requiresSignedStoppedReceipt || !receipt.commandContract.allowed.includes(command) || !['pause', 'rollback'].includes(command)) fail('pause/rollback requires signed stopped receipt; override rejected'); return { authorized: true, command, provider: receipt.commandContract.provider, stoppedReceiptDigest: receipt.receiptDigest }; }
export function sealTelemetrySnapshot(value, key) { return sealDocument(value, key, PURPOSES.telemetry); }
export function sealSupportSnapshot(value, key) { return sealDocument(value, key, PURPOSES.support); }
export function sealIncidentResolved(value, key) { return sealDocument(value, key, PURPOSES.incident); }
export function validateRecovery(recovery, { stoppedReceipt, policy, key } = {}) {
  verifyStageReceipt(stoppedReceipt, { key }); if (stoppedReceipt.status !== 'stopped') fail('recovery requires stopped receipt'); verifyDocument(recovery.incidentResolvedReceipt, key, PURPOSES.incident, 'incident resolved receipt');
  const incident = recovery.incidentResolvedReceipt; if (incident.status !== 'resolved' || incident.stoppedReceiptDigest !== stoppedReceipt.receiptDigest) fail('incident not resolved for stopped receipt'); text(recovery.fixSha, 'recovery.fixSha', SHA); if (recovery.fixSha === stoppedReceipt.release.sha) fail('same/original SHA manual recovery forbidden');
  if (recovery.release.sha !== recovery.fixSha || recovery.release.artifactSetDigest === stoppedReceipt.release.artifactSetDigest) fail('recovery requires fix SHA/new artifacts'); validatePrerequisites(recovery.prerequisites, recovery.release, recovery.mode);
  if (recovery.prerequisites.rcPass.releaseSha !== recovery.fixSha || recovery.prerequisites.upgradePass.releaseSha !== recovery.fixSha) fail('recovery must rerun M70-01/02 on fix SHA'); validatePolicy(policy, { production: recovery.mode === 'production' }); return { valid: true, restartAt: STAGES[0], fixSha: recovery.fixSha };
}
