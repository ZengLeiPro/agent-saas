import { readFile } from 'node:fs/promises';
import { digestValue, sealSupportSnapshot, sealTelemetrySnapshot } from '../scripts/rollout-contract.mjs';

export const key = 'm70-03-explicit-contract-fixture-key-000000000000000000';
export const sha = 'a'.repeat(40);
export const release = { sha, releaseId: 'fixture-release-1', artifactSetDigest: `sha256:${'b'.repeat(64)}` };
export const policy = JSON.parse(await readFile(new URL('../fixtures/rollout-policy.test-fixture.json', import.meta.url), 'utf8'));
const d = (seed) => `sha256:${seed.repeat(64)}`;
export function prerequisites(boundRelease = release, evidenceKind = 'explicit-non-production-fixture') {
  const common = (kind, seed) => ({ kind, digest: d(seed), releaseSha: boundRelease.sha, releaseId: boundRelease.releaseId, artifactSetDigest: boundRelease.artifactSetDigest, status: 'pass', evidenceKind });
  const m60Build = common('m60-build-evidence', '1');
  return {
    m60Build,
    m60Submit: { ...common('m60-submit-receipt', '2'), buildEvidenceDigest: m60Build.digest },
    telemetryProvider: common('m60-telemetry-provider-contract', '3'),
    telemetryTestReceipt: { ...common('m60-telemetry-test-receipt', '4'), providerContractDigest: d('3') },
    rcPass: common('m70-01-rc-pass', '5'),
    upgradePass: common('m70-02-upgrade-pass', '6'),
  };
}
export function inputFor(stageId = 'employee-dogfood', previousReceipt = null, options = {}) {
  const stage = policy.stages.find((item) => item.id === stageId); const index = policy.stages.indexOf(stage);
  const now = options.now ?? Date.parse('2026-09-01T09:00:00.000Z'); const observedFrom = new Date(now - 90_000).toISOString(); const observedTo = new Date(now - 30_000).toISOString(); const collectedAt = new Date(now - 20_000).toISOString();
  const binding = { releaseSha: release.sha, releaseId: release.releaseId, artifactSetDigest: release.artifactSetDigest, stageId, cohortId: `cohort-${stageId}`, cohortDefinition: stage.cohort.definition, observedFrom, observedTo, collectedAt };
  const metrics = Object.fromEntries(Object.entries(policy.metrics).map(([name, definition]) => { const threshold = policy.thresholds[stageId][name]; return [name, { value: definition.unit === 'count' ? 0 : definition.direction === '>=' ? Math.min(1, threshold + 0.01) : Math.max(0, threshold - 0.01), sampleSize: Math.max(100, stage.minimumSampleSize), partial: false }]; }));
  const telemetrySnapshot = sealTelemetrySnapshot({ ...binding, snapshotId: `telemetry-${stageId}-${options.suffix ?? '1'}`, provider: 'explicit-contract-fixture-provider', dashboardId: 'fixture-dashboard', queryId: `query-${stageId}`, queryDigest: d('7'), metrics, hardStops: { crossAccountIdentityLeak: 0, crossTenantIdentityLeak: 0, wrongAgentExecution: 0, signatureFailure: 0, upgradeFailure: 0, duplicateRunExecution: 0 } }, key);
  const supportSnapshot = sealSupportSnapshot({ ...binding, snapshotId: `support-${stageId}-${options.suffix ?? '1'}`, owner: 'fixture-mobile-oncall', incidentIds: [], supportTicketIds: [] }, key);
  return {
    schemaVersion: '1.0.0', mode: 'contract', release, targetStage: stageId,
    currentState: { lastPassedStage: index === 0 ? null : policy.stages[index - 1].id, lastReceiptDigest: previousReceipt?.receiptDigest ?? null }, previousReceipt,
    prerequisites: prerequisites(), cohortId: binding.cohortId,
    approval: { stageId, environment: stage.manualApproval.environment, approvalId: `approval-${stageId}-${options.suffix ?? '1'}`, deploymentId: `deployment-${stageId}`, approvedAt: new Date(now - 100_000).toISOString(), nonce: `approval-nonce-${stageId}-${options.suffix ?? '1'}` },
    adapterReceipt: { configured: true, provider: 'explicit-contract-fixture-adapter', status: 'accepted', stageId, releaseSha: release.sha, artifactSetDigest: release.artifactSetDigest, rolloutId: `rollout-${stageId}` },
    telemetrySnapshot, supportSnapshot, receiptNonce: `receipt-nonce-${stageId}-${options.suffix ?? '1'}`,
  };
}
export function resealTelemetry(input) { const copy = structuredClone(input.telemetrySnapshot); delete copy.signature; input.telemetrySnapshot = sealTelemetrySnapshot(copy, key); }
export function resealSupport(input) { const copy = structuredClone(input.supportSnapshot); delete copy.signature; input.supportSnapshot = sealSupportSnapshot(copy, key); }
export { digestValue };
