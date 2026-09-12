import assert from 'node:assert/strict';
import test from 'node:test';
import {
  componentIdentityMatrix,
  reconcilePromotion,
  summarizePrechangeRecoveryReceipts,
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
    if (configIdentityConfirmed !== undefined) input.configIdentityConfirmed = false;
    const result = reconcilePromotion(input);
    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /ConfigIdentity and trusted identity confirmation/u);
  }
});

test('classifies before-change failure while rejecting legacy rollback flags', () => {
  assert.equal(reconcilePromotion({ ...base, observed: before }).outcome, 'failed_before_change');
  for (const rollbackSucceeded of [true, false]) {
    assert.equal(
      reconcilePromotion({
        ...base,
        observed: before,
        rollbackAttempted: true,
        rollbackSucceeded,
      }).outcome,
      'needs_human',
    );
  }
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

test('requires an exact typed ACS/App/Web rollback receipt schema', () => {
  const valid = {
    acs: { attempted: false, succeeded: false },
    app: { attempted: true, succeeded: true },
    web: { attempted: false, succeeded: false },
  };
  for (const receipts of [
    { acs: valid.acs, app: valid.app },
    { ...valid, database: { attempted: false, succeeded: false } },
    { ...valid, web: { attempted: 'false', succeeded: false } },
    { ...valid, web: { attempted: false, succeeded: true } },
    { ...valid, web: { attempted: false, succeeded: false, detail: 'ok' } },
  ]) {
    assert.equal(summarizeRollbackReceipts(receipts), null);
    assert.equal(
      reconcilePromotion({ ...base, observed: before, rollbackReceipts: receipts }).outcome,
      'needs_human',
    );
  }
});

test('accepts a run-bound ACS pre-change recovery only with unchanged production identities', () => {
  const prechangeRecoveryReceipts = { acs: { recovered: true } };
  assert.deepEqual(summarizePrechangeRecoveryReceipts(prechangeRecoveryReceipts), {
    recovered: true,
  });
  const result = reconcilePromotion({
    ...base,
    observed: before,
    externalSideEffects: 'unknown',
    prechangeRecoveryReceipts,
  });
  assert.equal(result.outcome, 'failed_before_change');
  assert.match(result.reason, /admission recovery is durably attested/u);

  assert.equal(
    reconcilePromotion({
      ...base,
      observed: target,
      configIdentityConfirmed: true,
      externalSideEffects: 'unknown',
      prechangeRecoveryReceipts,
    }).outcome,
    'needs_human',
  );
});

test('rejects malformed or contradictory pre-change recovery evidence', () => {
  const rollbackReceipts = {
    acs: { attempted: true, succeeded: true },
    app: { attempted: false, succeeded: false },
    web: { attempted: false, succeeded: false },
  };
  for (const prechangeRecoveryReceipts of [
    {},
    { app: { recovered: true } },
    { acs: { recovered: 'true' } },
    { acs: { recovered: true, detail: 'unchecked' } },
  ]) {
    assert.equal(summarizePrechangeRecoveryReceipts(prechangeRecoveryReceipts), null);
    assert.equal(
      reconcilePromotion({
        ...base,
        observed: before,
        externalSideEffects: 'unknown',
        prechangeRecoveryReceipts,
      }).outcome,
      'needs_human',
    );
  }
  assert.equal(
    reconcilePromotion({
      ...base,
      observed: before,
      externalSideEffects: 'unknown',
      rollbackReceipts,
      prechangeRecoveryReceipts: { acs: { recovered: true } },
    }).outcome,
    'needs_human',
  );
});
