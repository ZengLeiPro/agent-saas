import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateObservationSamples } from './observe-production.mjs';

const RELEASE = 'rc-20260826-01';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const checks = Object.fromEntries(
  [
    'http',
    'websocket',
    'agentFirstToken',
    'agentCompletion',
    'runRecovery',
    'workerLease',
    'integrationReleaseGate',
    'sandboxLifecycle',
    'cronDeduplication',
    'login',
    'sessionRead',
    'taskboardRead',
  ].map((name) => [name, { status: 'ok' }]),
);

test('requires every operational and core-business check in every sample', () => {
  const sample = {
    releaseId: RELEASE,
    manifestDigest: DIGEST,
    observedAt: '2026-08-26T00:00:00.000Z',
    checks,
    metrics: { httpErrorRate: 0.001, duplicateExecutions: 0 },
  };
  const next = { ...sample, observedAt: '2026-08-26T00:00:30.000Z' };
  assert.equal(evaluateObservationSamples([sample, next], RELEASE, DIGEST).ok, true);
  const failed = structuredClone(sample);
  failed.checks.sandboxLifecycle.status = 'failed';
  assert.equal(evaluateObservationSamples([failed], RELEASE, DIGEST).ok, false);
});

test('rejects cross-release samples and duplicate execution', () => {
  const result = evaluateObservationSamples(
    [
      {
        releaseId: 'other',
        manifestDigest: DIGEST,
        observedAt: '2026-08-26T00:00:00.000Z',
        checks,
        metrics: { httpErrorRate: 0, duplicateExecutions: 1 },
      },
    ],
    RELEASE,
    DIGEST,
  );
  assert.equal(result.ok, false);
  assert.ok(result.blockingReasons.some((reason) => reason.includes('not bound')));
});

test('rejects cached samples and missing quantitative metrics', () => {
  const sample = {
    releaseId: RELEASE,
    manifestDigest: DIGEST,
    observedAt: '2026-08-26T00:00:00.000Z',
    checks,
    metrics: { duplicateExecutions: 0 },
  };
  const result = evaluateObservationSamples([sample, sample], RELEASE, DIGEST);
  assert.equal(result.ok, false);
  assert.ok(result.blockingReasons.some((reason) => reason.includes('fresh increasing')));
  assert.ok(result.blockingReasons.some((reason) => reason.includes('HTTP error rate')));
});
