import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPromotionRetryable } from './assert-promotion-retry.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
function entry(state, operationKey = state, reason) {
  return { state, operationKey, ...(reason ? { reason } : {}) };
}
function promoting(operationKey = 'promoting') {
  return entry(
    'promoting',
    operationKey,
    JSON.stringify({
      migrationPhase: 'none',
      manifestDigest: DIGEST,
      migrationPlanDigest: DIGEST,
      productionBeforeDigest: DIGEST,
      productionTargetDigest: DIGEST,
    }),
  );
}

test('accepts a fresh verified release and a fail-closed pre-mutation retry', () => {
  assert.deepEqual(assertPromotionRetryable([entry('built'), entry('verified')]), {
    mode: 'fresh',
    latestState: 'verified',
  });
  assert.deepEqual(
    assertPromotionRetryable([
      entry('built'),
      entry('verified', 'verified:1'),
      entry('approved'),
      entry('failed_before_change'),
    ]),
    {
      mode: 'retry_before_change',
      latestState: 'failed_before_change',
      verifiedOperationKey: 'verified:1',
      previousApprovalCount: 1,
    },
  );
  assert.deepEqual(
    assertPromotionRetryable([
      entry('verified', 'verified:1'),
      entry('approved'),
      promoting(),
      entry('failed_before_change'),
    ]),
    {
      mode: 'retry_before_change',
      latestState: 'failed_before_change',
      verifiedOperationKey: 'verified:1',
      previousApprovalCount: 1,
    },
  );
  assert.deepEqual(assertPromotionRetryable([entry('verified', 'verified:1'), entry('approved')]), {
    mode: 'retry_before_change',
    latestState: 'approved',
    verifiedOperationKey: 'verified:1',
    previousApprovalCount: 1,
  });
});

for (const state of [
  'needs_human',
  'partial_failed',
  'rolled_back',
  'awaiting_expand_confirmation',
  'completed',
]) {
  test(`rejects post-mutation or terminal state ${state}`, () => {
    assert.throws(
      () =>
        assertPromotionRetryable([
          entry('verified'),
          entry('approved'),
          entry('promoting'),
          entry(state),
        ]),
      /cannot be approved|production mutation/u,
    );
  });
}

test('rejects failed-before-change retry without immutable promoting proof', () => {
  assert.throws(
    () =>
      assertPromotionRetryable([
        entry('verified'),
        entry('approved'),
        entry('promoting'),
        entry('failed_before_change'),
      ]),
    /bound failure proof/u,
  );
});

test('rejects a pre-mutation tail without prior approval', () => {
  assert.throws(
    () => assertPromotionRetryable([entry('verified'), entry('failed_before_change')]),
    /prior approval/u,
  );
});
