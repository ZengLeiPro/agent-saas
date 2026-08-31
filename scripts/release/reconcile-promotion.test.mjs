import assert from 'node:assert/strict';
import test from 'node:test';
import {
  componentIdentityMatrix,
  reconcilePromotion,
  summarizeRollbackReceipts,
} from './reconcile-promotion.mjs';

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

test('classifies complete, before-change failure and proven rollback', () => {
  assert.equal(reconcilePromotion({ ...base, observed: target }).outcome, 'completed');
  assert.equal(reconcilePromotion({ ...base, observed: before }).outcome, 'failed_before_change');
  assert.equal(
    reconcilePromotion({
      ...base,
      observed: before,
      rollbackAttempted: true,
      rollbackSucceeded: true,
    }).outcome,
    'rolled_back',
  );
  assert.equal(
    reconcilePromotion({
      ...base,
      observed: before,
      rollbackAttempted: true,
      rollbackSucceeded: false,
    }).outcome,
    'needs_human',
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

test('compares only authoritative component identities, not observation metadata', () => {
  const observed = Object.fromEntries(
    Object.entries(target).map(([name, value]) => [
      name,
      { ...value, deployedAt: '2026-08-26T00:00:00.000Z' },
    ]),
  );
  assert.deepEqual(componentIdentityMatrix(observed), target);
  assert.equal(reconcilePromotion({ ...base, observed }).outcome, 'completed');
});

test('never completes after a forbidden contract migration even when components match', () => {
  assert.equal(
    reconcilePromotion({ ...base, observed: target, databaseChange: 'contract_started' }).outcome,
    'needs_human',
  );
});

test('requires succeeded evidence for every attempted ACS/App/Web rollback', () => {
  for (const componentName of ['acs', 'app', 'web']) {
    const rollbackReceipts = {
      acs: { attempted: false, succeeded: false },
      app: { attempted: false, succeeded: false },
      web: { attempted: false, succeeded: false },
      [componentName]: { attempted: true, succeeded: false },
    };
    assert.deepEqual(summarizeRollbackReceipts(rollbackReceipts), {
      attempted: true,
      succeeded: false,
    });
    assert.equal(
      reconcilePromotion({ ...base, observed: before, rollbackReceipts }).outcome,
      'needs_human',
      `${componentName} restoration failed after its attempted receipt`,
    );
    assert.equal(
      reconcilePromotion({ ...base, observed: target, rollbackReceipts }).outcome,
      'needs_human',
      `${componentName} incomplete rollback cannot be hidden by a target-shaped readback`,
    );
    rollbackReceipts[componentName].succeeded = true;
    assert.equal(
      reconcilePromotion({ ...base, observed: before, rollbackReceipts }).outcome,
      'rolled_back',
      `${componentName} restoration has matching succeeded evidence`,
    );
  }
});
