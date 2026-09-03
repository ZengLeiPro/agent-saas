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

test('allows reviewed post-mutation recovery but rejects ambiguous mutation histories', () => {
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
  assert.throws(
    () =>
      assertPromotionRetryable([
        entry('verified'),
        entry('approved'),
        entry('promoting'),
        entry('failed_before_change'),
      ]),
    /ambiguous post-mutation/u,
  );
});

test('keeps repeated pre-write recovery failures in retry_after_change mode', () => {
  const failedRecoveryAttempt = [
    entry('verified', 'verified:1'),
    entry('approved', 'approved:1'),
    entry('promoting', 'promoting:1'),
    entry('needs_human', 'needs-human:1'),
    entry('approved', 'approved:2'),
    entry('failed_before_change', 'failed-before-change:2'),
  ];
  assert.deepEqual(assertPromotionRetryable(failedRecoveryAttempt), {
    mode: 'retry_after_change',
    latestState: 'failed_before_change',
    verifiedOperationKey: 'verified:1',
    promotingOperationKey: 'promoting:1',
    previousApprovalCount: 2,
  });

  const reapproved = [...failedRecoveryAttempt, entry('approved', 'approved:3')];
  assert.deepEqual(assertPromotionRetryable(reapproved), {
    mode: 'retry_after_change',
    latestState: 'approved',
    verifiedOperationKey: 'verified:1',
    promotingOperationKey: 'promoting:1',
    previousApprovalCount: 3,
  });

  assert.deepEqual(
    assertPromotionRetryable([
      ...reapproved,
      entry('promoting', 'promoting:2'),
      entry('needs_human', 'needs-human:2'),
    ]),
    {
      mode: 'retry_after_change',
      latestState: 'needs_human',
      verifiedOperationKey: 'verified:1',
      promotingOperationKey: 'promoting:2',
      previousApprovalCount: 3,
    },
  );
});
