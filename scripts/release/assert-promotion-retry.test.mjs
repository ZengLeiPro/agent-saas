import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPromotionRetryable } from './assert-promotion-retry.mjs';

function entry(state, operationKey = state) {
  return { state, operationKey };
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
      entry('needs_human'),
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

test('allows reviewed recovery from needs_human but rejects ambiguous mutation histories', () => {
  assert.deepEqual(
    assertPromotionRetryable([
      entry('verified', 'verified:1'),
      entry('approved'),
      entry('promoting', 'promoting:1'),
      entry('needs_human'),
    ]),
    {
      mode: 'retry_after_change',
      latestState: 'needs_human',
      verifiedOperationKey: 'verified:1',
      promotingOperationKey: 'promoting:1',
      previousApprovalCount: 1,
    },
  );
  assert.throws(
    () =>
      assertPromotionRetryable([
        entry('verified'),
        entry('approved'),
        entry('promoting'),
        entry('partial_failed'),
        entry('needs_human'),
      ]),
    /terminal post-mutation state: partial_failed/u,
  );
  assert.throws(
    () => assertPromotionRetryable([entry('verified'), entry('needs_human')]),
    /prior approval/u,
  );
});
