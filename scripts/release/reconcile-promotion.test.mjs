import assert from 'node:assert/strict';
import test from 'node:test';
import { componentIdentityMatrix, reconcilePromotion } from './reconcile-promotion.mjs';

const component = (value) => ({ gitSha: value, artifactDigest: `sha256:${value.repeat(64)}` });
const acs = (value) => ({
  gitSha: value,
  orchestratorArtifactDigest: `sha256:${value.repeat(64)}`,
  sandboxImageDigest: `sha256:${value.repeat(64)}`,
});
const before = {
  web: component('a'),
  api: component('a'),
  runtimeWorker: component('a'),
  acs: acs('a'),
};
const target = {
  web: component('b'),
  api: component('b'),
  runtimeWorker: component('b'),
  acs: acs('b'),
};
const base = { releaseId: 'rc-20260826-01', before, target, observationComplete: true };

test('completes target convergence only with explicit ConfigIdentity confirmation', () => {
  const completed = reconcilePromotion({
    ...base,
    observed: target,
    configIdentityConfirmed: true,
  });
  assert.equal(completed.outcome, 'completed');
  assert.match(completed.reason, /confirmed ConfigIdentity/u);

  for (const configIdentityConfirmed of [false, undefined]) {
    const input = { ...base, observed: target };
    if (configIdentityConfirmed !== undefined) {
      input.configIdentityConfirmed = configIdentityConfirmed;
    }
    const result = reconcilePromotion(input);
    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /ConfigIdentity and trusted identity confirmation/u);
  }
});

test('classifies before-change failure and proven rollback without ConfigIdentity confirmation', () => {
  assert.equal(reconcilePromotion({ ...base, observed: before }).outcome, 'failed_before_change');
  assert.equal(
    reconcilePromotion({ ...base, observed: before, rollbackAttempted: true }).outcome,
    'rolled_back',
  );
});

test('keeps mixed or unknown production state explicit', () => {
  const mixed = { ...target, web: before.web };
  assert.equal(reconcilePromotion({ ...base, observed: mixed }).outcome, 'partial_failed');
  assert.equal(
    reconcilePromotion({ ...base, observed: mixed, externalSideEffects: 'unknown' }).outcome,
    'needs_human',
  );
  assert.equal(
    reconcilePromotion({ ...base, observed: null, observationComplete: false }).outcome,
    'needs_human',
  );
});

test('compares only authoritative component identities after confirmation, not metadata', () => {
  const observed = Object.fromEntries(
    Object.entries(target).map(([name, value]) => [
      name,
      { ...value, deployedAt: '2026-08-26T00:00:00.000Z' },
    ]),
  );
  assert.deepEqual(componentIdentityMatrix(observed), target);
  assert.equal(
    reconcilePromotion({ ...base, observed, configIdentityConfirmed: true }).outcome,
    'completed',
  );
});

test('never completes after a forbidden contract migration even when components match', () => {
  assert.equal(
    reconcilePromotion({
      ...base,
      observed: target,
      configIdentityConfirmed: true,
      databaseChange: 'contract_started',
    }).outcome,
    'needs_human',
  );
});
