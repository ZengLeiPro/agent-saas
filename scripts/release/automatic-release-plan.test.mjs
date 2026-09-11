import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRequest,
  planRequest,
  chooseTarget,
  currentTransactions,
  describeRelease,
} from './automatic-release-plan.mjs';
import { validateProductionOperation } from './production-operation.mjs';
import {
  release,
  run,
  sha,
  iso,
  ancestor,
  repository,
  sealManifest,
} from './fixtures/automatic-release-fixture.mjs';
const now = Date.now();
const options = { isAncestor: ancestor, now };
const base = release(116, sha(1), sha(1), 'completed', now - 900000, now);
const old = release(117, sha(2), sha(1), 'needs_human', now - 800000, now);
const target = release(118, sha(3), sha(1), 'verified', now - 700000, now);
const request = () =>
  createRequest({
    run: run(501, undefined, now),
    repository,
    reason: 'ship',
    releases: [base, old, target],
    isAncestor: ancestor,
  });

test('RC117 recovery is selected automatically while RC118 source remains the goal', () => {
  const r = request();
  const p = planRequest(r, [base, old, target], options);
  assert.equal(r.target.releaseId, target.manifest.releaseId);
  assert.equal(p.recovery.manifest.releaseId, old.manifest.releaseId);
  assert.equal(p.needsRefresh, true);
});
test('newer number does not make older source the newest target', () => {
  const newerNumber = release(999, sha(2), sha(1), 'verified', now - 100000, now);
  assert.equal(
    chooseTarget([target, newerNumber], {
      engineSha: sha(15),
      requestedAt: now,
      isAncestor: ancestor,
    }),
    target,
  );
});
test('sources verified after the click and outside pinned engine history are excluded', () => {
  const late = release(121, sha(4), sha(1), 'verified', now - 1000, now + 5000);
  const newer = release(122, sha(14), sha(1), 'verified', now - 90000, now);
  assert.equal(
    chooseTarget([target, late, newer], {
      engineSha: sha(3),
      requestedAt: now - 10000,
      isAncestor: ancestor,
    }),
    target,
  );
});
test('stable matching baseline can directly promote without rebuilding Staging', () => {
  assert.equal(planRequest(request(), [base, target], options).needsRefresh, false);
});
test('recovery complete needs fresh same-source candidate rather than rewriting RC118 baseline', () => {
  const complete = release(117, sha(2), sha(1), 'completed', now - 50000, now);
  const before = JSON.stringify(target);
  const plan = planRequest(request(), [base, complete, target], options);
  assert.equal(plan.recovery, undefined);
  assert.equal(plan.needsRefresh, true);
  assert.equal(JSON.stringify(target), before);
});
test('completed target is no-op except fresh final verification', () => {
  const done = { ...target, state: 'completed', completedAt: now - 5000 };
  assert.equal(planRequest(request(), [base, done], options).needsRefresh, false);
});
for (const mode of [
  'expired',
  'multiple',
  'revoked',
  'downgrade',
  'target-changed',
  'target-rejected',
]) {
  test(`fail closed: ${mode}`, () => {
    const data = structuredClone([base, old, target]);
    if (mode === 'expired') data[1].manifest.promotionPolicy.expiresAt = iso(now - 1);
    if (mode === 'multiple')
      data.push(release(120, sha(3), sha(1), 'promoting', now - 600000, now));
    if (mode === 'revoked') data[1].state = 'revoked';
    if (mode === 'downgrade') data[0].manifest.releaseSha = sha(9);
    if (mode === 'target-changed') data[2].manifest.digest = 'wrong';
    if (mode === 'target-rejected') data[2].state = 'rejected';
    assert.throws(() => planRequest(request(), data, options));
  });
}
test('historical unclosed transaction is not replayed after later whole-matrix completion', () => {
  const later = release(120, sha(3), sha(2), 'completed', now - 100000, now);
  assert.equal(currentTransactions([base, old, later]).recovery, undefined);
});
test('expired target can be refreshed without rewriting expiry; expired recovery cannot', () => {
  const stale = structuredClone(target);
  stale.manifest.promotionPolicy.expiresAt = iso(now - 1);
  const r = request();
  r.target.manifestDigest = stale.manifest.digest;
  assert.equal(planRequest(r, [base, stale], options).needsRefresh, true);
});
test('manifest checksum and append-only history validation remain mandatory', () => {
  for (const mutation of [
    (r) => {
      r.manifest.releaseSha = sha(4);
    },
    (r) => {
      r.history[1].operationKey = r.history[0].operationKey;
    },
    (r) => {
      r.history[1].recordedAt = iso(now + 120000);
    },
    (r) => {
      r.history[1].manifestDigest = 'invalid';
    },
  ]) {
    const r = structuredClone(target);
    mutation(r);
    assert.throws(() => describeRelease(r, now));
  }
});
test('auto has no manual RC or repair override; old API omission still means promote', () => {
  const ctx = { eventName: 'workflow_dispatch', ref: 'refs/heads/main' };
  assert.equal(
    validateProductionOperation({ operation: 'auto', reason: 'ship' }, ctx).operation,
    'auto',
  );
  for (const change of [
    { release_id: 'rc-20260911-117' },
    { recovery_mode: 'repair' },
    { confirm_recovery_only: true },
    { automation_id: '123', automation_key: 'auto:9:publish' },
  ])
    assert.throws(() =>
      validateProductionOperation({ operation: 'auto', reason: 'ship', ...change }, ctx),
    );
});
