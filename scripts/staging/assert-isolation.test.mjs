import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIsolationEvidence, REQUIRED_ISOLATION_PROBES } from './assert-isolation.mjs';

const NOW = Date.parse('2026-08-26T10:00:00.000Z');

function evidence() {
  return {
    schemaVersion: 1,
    environment: 'staging',
    probes: REQUIRED_ISOLATION_PROBES.map((id) => ({
      id,
      status: 'denied',
      sourceEnvironment: 'staging',
      targetEnvironment: 'production',
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      observedAt: '2026-08-26T09:59:00.000Z',
    })),
  };
}

test('accepts only fresh observed denials for every reverse-isolation boundary', () => {
  assert.equal(assertIsolationEvidence(evidence(), { now: NOW }).status, 'verified');
});

test('rejects a missing, allowed, or stale probe', () => {
  const missing = evidence();
  missing.probes.pop();
  assert.throws(() => assertIsolationEvidence(missing, { now: NOW }), /Missing isolation probe/u);
  const allowed = evidence();
  allowed.probes[0].status = 'allowed';
  assert.throws(() => assertIsolationEvidence(allowed, { now: NOW }), /did not prove/u);
  assert.throws(
    () => assertIsolationEvidence(evidence(), { now: NOW + 2 * 60 * 60_000 }),
    /did not prove/u,
  );
});
