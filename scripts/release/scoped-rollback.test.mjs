import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcilePromotion } from './reconcile-promotion.mjs';
const component = (c) => ({ gitSha: c.repeat(40), artifactDigest: `sha256:${c.repeat(64)}` });
const matrix = (c) => ({
  web: component(c),
  api: component(c),
  runtimeWorker: component(c),
  acs: {
    gitSha: c.repeat(40),
    orchestratorArtifactDigest: `sha256:${c.repeat(64)}`,
    sandboxImageDigest: `sha256:${c.repeat(64)}`,
  },
});
const before = matrix('a');
const target = matrix('b');
const receipts = {
  acs: { attempted: false, succeeded: false },
  app: { attempted: false, succeeded: false },
  web: { attempted: true, succeeded: true },
};
test('T11: ACS commit and verified Web rollback are independent facts', () => {
  const input = {
    releaseId: 'rc-20260911-01',
    before,
    target,
    observed: { ...before, acs: target.acs },
    observationComplete: true,
    rollbackReceipts: receipts,
  };
  const partial = reconcilePromotion({ ...input, externalSideEffects: 'none_observed' });
  assert.equal(partial.outcome, 'partial_failed');
  assert.equal(partial.componentResults.web.rollbackVerified, true);
  assert.equal(partial.componentResults.acs.state, 'target');
  const unknown = reconcilePromotion({ ...input, externalSideEffects: 'unknown' });
  assert.equal(unknown.outcome, 'needs_human');
  assert.match(unknown.reason, /local rollback verified.*side effects are unknown/);
  const conflict = reconcilePromotion({ ...input, observed: target });
  assert.equal(conflict.outcome, 'needs_human');
  assert.match(conflict.reason, /within its own scope/);
});
