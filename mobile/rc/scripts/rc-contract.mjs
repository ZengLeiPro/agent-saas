import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateReceiptSet } from '../../e2e/maestro/scripts/validate-evidence.mjs';
import { validateBuildEvidence } from '../../scripts/mobile-release-evidence.mjs';
import {
  providerContractDigest,
  validateProviderContract,
  validateTestEventReceipt,
} from '../../scripts/mobile-telemetry-release-gate.mjs';

export const AUTHORITATIVE_DIMENSIONS = Object.freeze({
  platformSlot: ['ios-minimum', 'ios-latest', 'android-flagship', 'android-low-end-small'],
  network: ['wifi', 'cellular', 'offline', 'rtt-300ms', 'packet-loss-5pct', 'network-switch'],
  account: ['ordinary-a', 'ordinary-b', 'admin', 'disabled'],
  agent: ['personal', 'assigned', 'revoked', 'personal-disabled'],
  session: ['empty', 'normal', 'index-1000', 'messages-500', 'tools-50', 'running'],
  permissionResource: ['microphone', 'camera', 'photos'],
  permissionDecision: ['allow', 'deny', 'once'],
  interaction: ['approval-allow', 'approval-deny', 'ask-user-multi', 'ack-timeout'],
  artifact: ['markdown', 'image', 'pdf', 'audio', 'video', 'html', 'svg', 'expired-url'],
});
export const REQUIRED_SLOTS = AUTHORITATIVE_DIMENSIONS.platformSlot;
export const RELEASE_PROFILES = Object.freeze(['ios-store', 'android-store', 'android-enterprise']);
export const HARD_STOPS = Object.freeze([
  'identityLeak', 'wrongAgentExecution', 'duplicateExecution', 'signatureFailure', 'upgradeFailure',
]);
export const RESULT_STATUSES = Object.freeze(['pass', 'fail', 'blocked', 'skipped']);
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/u;

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digestValue(value) {
  return `sha256:${createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalize(value)).digest('hex')}`;
}
function fail(message) { throw new Error(`[M70-01] ${message}`); }
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function text(value, label, pattern = ID) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}
function exactSet(actual, expected, label) {
  const a = [...actual].sort(); const b = [...expected].sort();
  if (new Set(a).size !== a.length || JSON.stringify(a) !== JSON.stringify(b)) fail(`${label} is incomplete, duplicated, or unsupported`);
}
function iso(value, label) {
  const time = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(time)) fail(`${label} must be an ISO timestamp`);
  return time;
}
function assertDigest(value, label) { text(value, label, DIGEST); }

export function validatePlan(plan) {
  record(plan, 'plan');
  if (plan.schemaVersion !== '1.0.0' || plan.planId !== 'M70-01-RC') fail('unsupported plan identity');
  if (plan.coveragePolicy !== 'authoritative-values-plus-high-risk-pairwise') fail('coverage policy is not fail-closed');
  record(plan.dimensions, 'dimensions');
  exactSet(Object.keys(plan.dimensions), Object.keys(AUTHORITATIVE_DIMENSIONS), 'dimension names');
  for (const [dimension, values] of Object.entries(AUTHORITATIVE_DIMENSIONS)) exactSet(plan.dimensions[dimension], values, `dimensions.${dimension}`);
  record(plan.invariants, 'invariants');
  if (!Array.isArray(plan.cases) || plan.cases.length === 0) fail('cases are required');
  const ids = new Set();
  const covered = Object.fromEntries(Object.keys(AUTHORITATIVE_DIMENSIONS).map((key) => [key, new Set()]));
  for (const [index, item] of plan.cases.entries()) {
    record(item, `cases[${index}]`);
    text(item.id, `cases[${index}].id`, /^M70-RC-[0-9]{3}$/u);
    if (ids.has(item.id)) fail(`duplicate case id ${item.id}`);
    ids.add(item.id);
    for (const [dimension, values] of Object.entries(AUTHORITATIVE_DIMENSIONS)) {
      if (!values.includes(item[dimension])) fail(`${item.id} has unsupported ${dimension}`);
      covered[dimension].add(item[dimension]);
    }
    if (!Array.isArray(item.fixtureRefs) || item.fixtureRefs.length === 0) fail(`${item.id} fixtureRefs are required`);
    if (!Array.isArray(item.riskScenarios)) fail(`${item.id} riskScenarios are required`);
    if (!Array.isArray(item.expectedInvariants) || item.expectedInvariants.length === 0) fail(`${item.id} expected invariants are required`);
    for (const invariant of item.expectedInvariants) if (!plan.invariants[invariant]) fail(`${item.id} references unknown invariant ${invariant}`);
  }
  for (const [dimension, values] of Object.entries(AUTHORITATIVE_DIMENSIONS)) exactSet(covered[dimension], values, `case coverage ${dimension}`);
  const permissionPairs = new Set(plan.cases.map((item) => `${item.permissionResource}:${item.permissionDecision}`));
  exactSet(permissionPairs, AUTHORITATIVE_DIMENSIONS.permissionResource.flatMap((resource) => AUTHORITATIVE_DIMENSIONS.permissionDecision.map((decision) => `${resource}:${decision}`)), 'permission resource/decision pairwise coverage');
  if (!Array.isArray(plan.highRiskPairs)) fail('highRiskPairs are required');
  const pairIds = new Set();
  for (const pair of plan.highRiskPairs) {
    text(pair.id, 'highRiskPair.id', /^HR-[A-Z0-9-]+$/u);
    if (pairIds.has(pair.id)) fail(`duplicate high-risk pair ${pair.id}`);
    pairIds.add(pair.id);
    text(pair.scenario, `${pair.id}.scenario`);
    record(pair.requires, `${pair.id}.requires`);
    const matches = plan.cases.filter((item) => item.riskScenarios.includes(pair.scenario)
      && Object.entries(pair.requires).every(([key, value]) => item[key] === value));
    if (matches.length === 0) fail(`high-risk pair ${pair.id} is uncovered`);
    if (pair.id === 'HR-ACCOUNT-A-B-OLD-STATE' && !matches.some((item) => ['account-a', 'account-b', 'old-ws-and-cache'].every((fixture) => item.fixtureRefs.includes(fixture)))) fail(`${pair.id} fixture binding is incomplete`);
    if (pair.id === 'HR-RUNNING-SWITCH-AGENT-QUEUED' && !matches.some((item) => ['queued-message', 'agent-switch'].every((fixture) => item.fixtureRefs.includes(fixture)))) fail(`${pair.id} fixture binding is incomplete`);
    if (pair.id === 'HR-ACTIVE-CONTENT-EXPIRED' && !matches.some((item) => item.fixtureRefs.includes('expired-url') && (item.fixtureRefs.includes('active-html') || item.fixtureRefs.includes('active-svg')))) fail(`${pair.id} fixture binding is incomplete`);
  }
  exactSet(pairIds, [
    'HR-ACCOUNT-A-B-OLD-STATE', 'HR-RUNNING-SWITCH-AGENT-QUEUED', 'HR-OFFLINE-ACK',
    'HR-PACKET-LOSS-ACK', 'HR-ACTIVE-CONTENT-EXPIRED', 'HR-PERMISSION-DENY-VOICE',
    'HR-PERMISSION-DENY-SHARE',
  ], 'high-risk pair ids');
  return { caseCount: plan.cases.length, planDigest: digestValue(plan), covered };
}

function unsignedBundle(bundle) { const { integrity: _integrity, ...payload } = bundle; return payload; }
export function sealBundle(payload, key) {
  if (typeof key !== 'string' || key.length < 32) fail('RC evidence HMAC key must contain at least 32 characters');
  const canonical = canonicalize(payload);
  return { ...payload, integrity: {
    algorithm: 'HMAC-SHA256',
    payloadSha256: createHash('sha256').update(canonical).digest('hex'),
    hmacSha256: createHmac('sha256', key).update(canonical).digest('hex'),
  } };
}
function verifySeal(bundle, key) {
  if (typeof key !== 'string' || key.length < 32 || bundle.integrity?.algorithm !== 'HMAC-SHA256') fail('RC evidence seal is missing');
  const canonical = canonicalize(unsignedBundle(bundle));
  const payload = createHash('sha256').update(canonical).digest('hex');
  if (payload !== bundle.integrity.payloadSha256) fail('RC evidence payload was tampered');
  const expected = createHmac('sha256', key).update(canonical).digest();
  const actualHex = bundle.integrity.hmacSha256;
  if (!/^[0-9a-f]{64}$/.test(actualHex ?? '')) fail('RC evidence HMAC is malformed');
  const actual = Buffer.from(actualHex, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('RC evidence signature mismatch');
}
function resolveInside(root, relative, label) {
  text(relative, label, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) fail(`${label} escapes evidence root`);
  return resolved;
}
async function readBoundFile(root, ref, label) {
  record(ref, label); assertDigest(ref.digest, `${label}.digest`);
  const file = resolveInside(root, ref.path, `${label}.path`);
  const info = await stat(file);
  if (!info.isFile()) fail(`${label} is not a file`);
  const bytes = await readFile(file);
  if (digestValue(bytes) !== ref.digest) fail(`${label} digest mismatch`);
  return { file, bytes };
}

function validateM60Metadata(m60, commitSha, mode) {
  record(m60, 'm60');
  if (!Array.isArray(m60.nativeReceipts)) fail('M60-02 native receipts are required');
  exactSet(m60.nativeReceipts.map((entry) => entry.slot), REQUIRED_SLOTS, 'M60-02 four-slot binding');
  const receiptIds = new Set(); const runIds = new Set();
  for (const item of m60.nativeReceipts) {
    text(item.receiptId, 'M60-02 receiptId', /^[0-9a-f]{64}$/u); text(item.testRunId, 'M60-02 testRunId');
    assertDigest(item.digest, 'M60-02 digest'); text(item.buildSha, 'M60-02 buildSha', SHA);
    if (item.buildSha !== commitSha) fail('M60-02 cross-SHA receipt rejected');
    if (receiptIds.has(item.receiptId) || runIds.has(item.testRunId)) fail('M60-02 replayed receipt/testRunId rejected');
    receiptIds.add(item.receiptId); runIds.add(item.testRunId);
    const expectedKind = mode === 'production' ? 'real-device' : 'deterministic-mock';
    if (item.evidenceKind !== expectedKind) fail(`M60-02 ${item.slot} ${item.evidenceKind} cannot satisfy ${mode}`);
  }
  const release = record(m60.releaseEvidence, 'M60-04 release evidence');
  assertDigest(release.digest, 'M60-04 digest'); text(release.commitSha, 'M60-04 commitSha', SHA);
  if (release.evidenceKind !== (mode === 'production' ? 'verified-artifacts' : 'deterministic-mock')) fail(`M60-04 release evidence cannot satisfy ${mode}`);
  if (release.commitSha !== commitSha) fail('M60-04 cross-SHA evidence rejected');
  if (!Array.isArray(release.artifacts)) fail('M60-04 three-artifact evidence is required');
  exactSet(release.artifacts.map((entry) => entry.profile), RELEASE_PROFILES, 'M60-04 three-artifact binding');
  const artifactDigests = new Set();
  for (const artifact of release.artifacts) {
    assertDigest(artifact.artifactDigest, 'M60-04 artifact digest');
    if (artifact.verified !== true) fail(`M60-04 ${artifact.profile} artifact is not verified`);
    if (artifactDigests.has(artifact.artifactDigest)) fail('M60-04 artifact digest replay rejected');
    artifactDigests.add(artifact.artifactDigest);
  }
  const telemetry = record(m60.telemetry, 'M60-05 telemetry');
  text(telemetry.release, 'M60-05 release', SHA); assertDigest(telemetry.contractDigest, 'M60-05 contract digest');
  if (telemetry.release !== commitSha) fail('M60-05 cross-SHA evidence rejected');
  if (telemetry.evidenceKind !== (mode === 'production' ? 'production-provider' : 'deterministic-mock')) fail(`M60-05 telemetry cannot satisfy ${mode}`);
  return { nativeBySlot: new Map(m60.nativeReceipts.map((item) => [item.slot, item])), release };
}

async function validateProductionM60(m60, options, commitSha) {
  if (!options.evidenceRoot) fail('production evidenceRoot is required');
  const root = path.resolve(options.evidenceRoot);
  const nativePaths = [];
  for (const [index, ref] of m60.nativeReceipts.entries()) {
    const loaded = await readBoundFile(root, ref, `m60.nativeReceipts[${index}]`);
    nativePaths.push(loaded.file);
    const document = JSON.parse(loaded.bytes.toString('utf8'));
    if (document.receiptId !== ref.receiptId || document.contract?.testRunId !== ref.testRunId || document.contract?.slot !== ref.slot) fail(`M60-02 ${ref.slot} metadata mismatch`);
  }
  await validateReceiptSet({ receiptPaths: nativePaths, expectedBuildSha: commitSha, hmacKey: options.nativeHmacKey, mode: 'real', verifyFiles: true });
  const releaseLoaded = await readBoundFile(root, m60.releaseEvidence, 'm60.releaseEvidence');
  const releaseDocument = JSON.parse(releaseLoaded.bytes.toString('utf8'));
  validateBuildEvidence(releaseDocument, { publicKeys: options.releasePublicKeys });
  if (releaseDocument.commitOid !== commitSha) fail('M60-04 document cross-SHA rejected');
  const byProfile = new Map(releaseDocument.profiles.map((item) => [item.profile, item]));
  for (const item of m60.releaseEvidence.artifacts) if (byProfile.get(item.profile)?.artifactSha256 !== item.artifactDigest) fail(`M60-04 ${item.profile} digest binding mismatch`);
  const contractLoaded = await readBoundFile(root, m60.telemetry.contract, 'm60.telemetry.contract');
  const receiptLoaded = await readBoundFile(root, m60.telemetry.receipt, 'm60.telemetry.receipt');
  const contract = JSON.parse(contractLoaded.bytes.toString('utf8'));
  const receipt = JSON.parse(receiptLoaded.bytes.toString('utf8'));
  validateProviderContract(contract, { production: true, release: commitSha });
  if (providerContractDigest(contract) !== m60.telemetry.contractDigest) fail('M60-05 contract digest binding mismatch');
  validateTestEventReceipt(receipt, contract, { release: commitSha, key: options.telemetryHmacKey });
}

function validateCaseResult(result, item, context) {
  record(result, `${item.id} result`);
  if (result.caseId !== item.id) fail(`${item.id} case binding mismatch`);
  text(result.testRunId, `${item.id}.testRunId`); text(result.flowHash, `${item.id}.flowHash`, /^[0-9a-f]{64}$/u);
  if (!Number.isInteger(result.attempt) || result.attempt < 1) fail(`${item.id} attempt is invalid`);
  if (!Array.isArray(result.priorFailureReceiptIds)) fail(`${item.id} prior failure ledger is required`);
  for (const receiptId of result.priorFailureReceiptIds) text(receiptId, `${item.id}.priorFailureReceiptId`);
  if (!RESULT_STATUSES.includes(result.status)) fail(`${item.id} result status is invalid`);
  if (context.mode === 'production' && result.status !== 'pass') fail(`${item.id} production result cannot be ${result.status}`);
  const started = iso(result.startedAt, `${item.id}.startedAt`); const ended = iso(result.endedAt, `${item.id}.endedAt`);
  if (ended < started) fail(`${item.id} timestamps are reversed`);
  record(result.source, `${item.id}.source`);
  text(result.source.buildId, `${item.id}.source.buildId`);
  if (result.source.commitSha !== context.commitSha || result.source.profile !== context.profile) fail(`${item.id} source commit/profile mismatch`);
  assertDigest(result.source.artifactDigest, `${item.id}.source.artifactDigest`);
  if (!context.releaseArtifactDigests.has(result.source.artifactDigest)) fail(`${item.id} artifact digest is not one of the M60-04 verified artifacts`);
  const expectedKind = context.mode === 'production' ? 'real-device' : 'mock';
  if (result.evidenceKind !== expectedKind) fail(`${item.id} simulator/mock/native evidence label cannot satisfy ${context.mode}`);
  if (context.mode === 'contract' && result.explicitContractMock !== true) fail(`${item.id} mock is not explicitly contract-only`);
  if (context.mode === 'production' && result.explicitContractMock !== false) fail(`${item.id} production evidence is mislabeled`);
  const native = context.nativeBySlot.get(item.platformSlot);
  if (result.deviceReceipt?.slot !== item.platformSlot || result.deviceReceipt?.m60ReceiptId !== native.receiptId) fail(`${item.id} device/M60-02 receipt binding mismatch`);
  text(result.deviceReceipt.receiptId, `${item.id}.deviceReceipt.receiptId`); assertDigest(result.deviceReceipt.digest, `${item.id}.deviceReceipt.digest`);
  if (!Array.isArray(result.assertions)) fail(`${item.id} assertions are required`);
  exactSet(result.assertions.map((assertion) => assertion.invariant), item.expectedInvariants, `${item.id} expected invariant results`);
  if (result.assertions.some((assertion) => assertion.passed !== true) && result.status === 'pass') fail(`${item.id} pass contains failed invariant`);
  if (!Array.isArray(result.screenshots) || result.screenshots.length === 0) fail(`${item.id} screenshot evidence is required`);
  for (const screenshot of result.screenshots) { assertDigest(screenshot.digest, `${item.id} screenshot digest`); text(screenshot.path, `${item.id} screenshot path`, /^[A-Za-z0-9][A-Za-z0-9._/-]+$/u); }
  record(result.log, `${item.id}.log`); assertDigest(result.log.digest, `${item.id} log digest`); text(result.log.path, `${item.id} log path`, /^[A-Za-z0-9][A-Za-z0-9._/-]+$/u);
  if (!Array.isArray(result.defects)) fail(`${item.id} defects must be an array`);
  for (const defect of result.defects) {
    if (!['P0', 'P1', 'P2', 'P3'].includes(defect.severity) || !['open', 'fixed', 'verified'].includes(defect.status)) fail(`${item.id} defect classification is invalid`);
    text(defect.url, `${item.id} defect URL`, /^https:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$/u);
  }
  record(result.hardStops, `${item.id}.hardStops`); exactSet(Object.keys(result.hardStops), HARD_STOPS, `${item.id} hard-stop counters`);
  for (const name of HARD_STOPS) {
    if (!Number.isInteger(result.hardStops[name]) || result.hardStops[name] < 0) fail(`${item.id} hard-stop ${name} is invalid`);
    if (result.hardStops[name] !== 0) fail(`${item.id} hard-stop ${name} is non-zero`);
  }
  if (result.attempt > 1 || result.priorFailureReceiptIds.length > 0) {
    if (!result.retryOf) fail(`${item.id} rerun cannot clear failure without retryOf fix lineage`);
  }
  if (result.retryOf) {
    text(result.retryOf.testRunId, `${item.id}.retryOf.testRunId`); text(result.retryOf.failedReceiptId, `${item.id}.retryOf.failedReceiptId`);
    text(result.retryOf.fixCommitSha, `${item.id}.retryOf.fixCommitSha`, SHA);
    if (result.retryOf.fixCommitSha !== context.commitSha || result.retryOf.failedReceiptId === result.deviceReceipt.receiptId) fail(`${item.id} retry must bind the current fix commit and a new receipt`);
    if (result.priorFailureReceiptIds.length > 0 && !result.priorFailureReceiptIds.includes(result.retryOf.failedReceiptId)) fail(`${item.id} retryOf is absent from provider failure ledger`);
  }
}

async function verifyCaseEvidenceFiles(result, resultsRoot) {
  if (!resultsRoot) fail('production resultsRoot is required');
  text(result.evidenceBase, `${result.caseId}.evidenceBase`, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/u);
  const ref = (entry) => ({ path: path.posix.join(result.evidenceBase, entry.path), digest: entry.digest });
  const provider = await readBoundFile(path.resolve(resultsRoot), ref(result.deviceReceipt), `${result.caseId}.deviceReceipt`);
  const providerDocument = JSON.parse(provider.bytes.toString('utf8'));
  if (providerDocument.evidenceKind !== 'real-device' || providerDocument.providerReceiptId !== result.deviceReceipt.receiptId || providerDocument.flowHash !== result.flowHash) fail(`${result.caseId} provider receipt binding mismatch`);
  if (providerDocument.device?.physical !== true || providerDocument.device?.virtual !== false || providerDocument.device?.simulator !== false) fail(`${result.caseId} provider receipt is not physical-device evidence`);
  for (const [index, screenshot] of result.screenshots.entries()) await readBoundFile(path.resolve(resultsRoot), ref(screenshot), `${result.caseId}.screenshots[${index}]`);
  const log = await readBoundFile(path.resolve(resultsRoot), ref(result.log), `${result.caseId}.log`);
  if (log.bytes.length > 65536 || /authorization:\s*bearer\s+\S+|https?:\/\/[^\s<]+|password[=:]\s*[^<\s]+|(?:token|secret)[=:]\s*[^<\s]+/i.test(log.bytes.toString('utf8'))) fail(`${result.caseId} log is unbounded or unredacted`);
}

export async function validateRcEvidence(bundle, options) {
  const planInfo = validatePlan(options.plan);
  record(bundle, 'bundle'); verifySeal(bundle, options.hmacKey);
  if (bundle.schemaVersion !== '1.0.0' || bundle.planId !== 'M70-01-RC') fail('unsupported RC evidence schema');
  if (!['production', 'contract'].includes(bundle.mode)) fail('RC mode is invalid');
  if (bundle.mode === 'production' && bundle.explicitContractMock !== false) fail('production RC cannot be explicit mock');
  if (bundle.mode === 'contract' && bundle.explicitContractMock !== true) fail('contract mock must be explicit');
  text(bundle.commitSha, 'commitSha', SHA); text(bundle.profile, 'profile'); assertDigest(bundle.planDigest, 'planDigest');
  if (bundle.planDigest !== planInfo.planDigest) fail('plan digest mismatch');
  const expires = iso(bundle.expiresAt, 'expiresAt');
  if (expires <= (options.now ?? Date.now())) fail('RC evidence is expired');
  const m60 = validateM60Metadata(bundle.m60, bundle.commitSha, bundle.mode);
  if (!Array.isArray(bundle.caseResults)) fail('caseResults are required');
  exactSet(bundle.caseResults.map((item) => item.caseId), options.plan.cases.map((item) => item.id), 'RC case result coverage');
  const testRunIds = new Set(); const deviceReceiptIds = new Set();
  for (const item of options.plan.cases) {
    const result = bundle.caseResults.find((candidate) => candidate.caseId === item.id);
    validateCaseResult(result, item, {
      mode: bundle.mode, commitSha: bundle.commitSha, profile: bundle.profile, nativeBySlot: m60.nativeBySlot,
      releaseArtifactDigests: new Set(m60.release.artifacts.map((artifact) => artifact.artifactDigest)),
    });
    if (bundle.mode === 'production') await verifyCaseEvidenceFiles(result, options.resultsRoot);
    if (testRunIds.has(result.testRunId) || deviceReceiptIds.has(result.deviceReceipt.receiptId)) fail(`${item.id} replayed testRunId/device receipt rejected`);
    testRunIds.add(result.testRunId); deviceReceiptIds.add(result.deviceReceipt.receiptId);
  }
  record(bundle.summary, 'summary');
  const statuses = Object.fromEntries(RESULT_STATUSES.map((status) => [status, bundle.caseResults.filter((item) => item.status === status).length]));
  for (const status of RESULT_STATUSES) if (bundle.summary[status] !== statuses[status]) fail(`summary.${status} mismatch`);
  const openP0 = bundle.caseResults.flatMap((item) => item.defects).filter((item) => item.status === 'open' && item.severity === 'P0').length;
  const openP1 = bundle.caseResults.flatMap((item) => item.defects).filter((item) => item.status === 'open' && item.severity === 'P1').length;
  if (bundle.summary.openP0 !== openP0 || bundle.summary.openP1 !== openP1) fail('P0/P1 summary mismatch');
  if (openP0 !== 0 || openP1 !== 0) fail('production acceptance requires P0/P1 open count = 0');
  if (bundle.mode === 'production' && (statuses.blocked !== 0 || statuses.skipped !== 0 || statuses.fail !== 0)) fail('production RC requires every case to pass');
  if (bundle.mode === 'production') await validateProductionM60(bundle.m60, options, bundle.commitSha);
  return { valid: true, mode: bundle.mode, commitSha: bundle.commitSha, caseCount: planInfo.caseCount, statuses };
}
