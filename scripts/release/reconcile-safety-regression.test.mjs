import assert from 'node:assert/strict';
import test from 'node:test';
import { componentIdentityMatrix, reconcilePromotion } from './reconcile-promotion.mjs';

const identity = (value) => ({
  gitSha: value.repeat(40),
  artifactDigest: `sha256:${value.repeat(64)}`,
});
const matrix = (value) => ({
  web: identity(value),
  api: identity(value),
  runtimeWorker: identity(value),
  acs: {
    gitSha: value.repeat(40),
    orchestratorArtifactDigest: `sha256:${value.repeat(64)}`,
    sandboxImageDigest: `sha256:${value.repeat(64)}`,
  },
});
const before = matrix('a');
const target = matrix('b');
const base = { releaseId: 'rc-safety-regression', before, target, observationComplete: true };
const receipts = (scope = 'web', succeeded = true) => ({
  acs: { attempted: false, succeeded: false },
  app: { attempted: false, succeeded: false },
  web: { attempted: false, succeeded: false },
  [scope]: { attempted: true, succeeded },
});

test('unknown external effects cannot be hidden by a fully restored component matrix', () => {
  const result = reconcilePromotion({
    ...base,
    observed: before,
    rollbackReceipts: receipts(),
    externalSideEffects: 'unknown',
  });
  assert.equal(result.outcome, 'needs_human');
  assert.equal(result.componentResults.web.rollbackVerified, true);
  assert.match(result.reason, /external side effects/u);
});

test('unknown external effects cannot be reported as no change just because identities match', () => {
  const result = reconcilePromotion({ ...base, observed: before, externalSideEffects: 'unknown' });
  assert.equal(result.outcome, 'needs_human');
});

test('missing identity fields never count as convergence, including three identical incomplete matrices', () => {
  const incomplete = { web: {}, api: {}, runtimeWorker: {}, acs: {} };
  assert.equal(componentIdentityMatrix(incomplete), null);
  assert.equal(
    reconcilePromotion({
      ...base,
      before: incomplete,
      target: incomplete,
      observed: incomplete,
      configIdentityConfirmed: true,
    }).outcome,
    'needs_human',
  );
});

test('every identity field requires a nonempty string, not null, arrays or objects', () => {
  for (const scope of Object.keys(target)) {
    for (const field of Object.keys(target[scope])) {
      for (const value of [undefined, null, '', '   ', 42, [], {}]) {
        const incomplete = structuredClone(target);
        incomplete[scope][field] = value;
        assert.equal(componentIdentityMatrix(incomplete), null, `${scope}.${field}=${value}`);
        assert.equal(reconcilePromotion({ ...base, observed: incomplete }).outcome, 'needs_human');
      }
    }
  }
});

test('a valid Web-only rollback keeps committed ACS distinct and does not demand global rollback', () => {
  const result = reconcilePromotion({
    ...base,
    target: { ...before, web: target.web, acs: target.acs },
    observed: { ...before, acs: target.acs },
    rollbackReceipts: receipts(),
    externalSideEffects: 'none',
  });
  assert.equal(result.outcome, 'partial_failed');
  assert.equal(result.componentResults.web.rollbackVerified, true);
  assert.equal(result.componentResults.acs.rollbackAttempted, false);
  assert.equal(result.componentResults.acs.state, 'target');
});

test('a third identity in an unrolled scope is unknown, not safe to resume automatically', () => {
  const result = reconcilePromotion({
    ...base,
    observed: { ...before, acs: matrix('c').acs },
    rollbackReceipts: receipts(),
    externalSideEffects: 'none',
  });
  assert.equal(result.outcome, 'needs_human');
  assert.equal(result.componentResults.acs.state, 'mixed_or_unknown');
  assert.notEqual(result.recovery, 'resume_uncommitted_components');
});

test('App rollback verification covers both API and runtimeWorker', () => {
  const result = reconcilePromotion({
    ...base,
    observed: { ...before, runtimeWorker: target.runtimeWorker },
    rollbackReceipts: receipts('app'),
    externalSideEffects: 'none',
  });
  assert.equal(result.outcome, 'needs_human');
  assert.equal(result.componentResults.app.rollbackVerified, false);
  assert.match(result.reason, /own scope/u);
});

test('complete rollback retains scoped evidence for a canceled outcome input', () => {
  const result = reconcilePromotion({
    ...base,
    observed: before,
    processOutcome: 'canceled',
    rollbackReceipts: receipts(),
    externalSideEffects: 'none',
  });
  assert.equal(result.outcome, 'rolled_back');
  assert.equal(result.componentResults.web.rollbackVerified, true);
  assert.equal(result.componentResults.acs.rollbackAttempted, false);
});

test('an unsuccessful rollback retains its scope and stays fail closed', () => {
  const result = reconcilePromotion({
    ...base,
    observed: before,
    rollbackReceipts: receipts('web', false),
  });
  assert.equal(result.outcome, 'needs_human');
  assert.equal(result.componentResults.web.rollbackAttempted, true);
  assert.equal(result.componentResults.web.rollbackVerified, false);
});
