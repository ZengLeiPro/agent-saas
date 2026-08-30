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
});

test('rejects retry after production mutation may have started', () => {
  assert.throws(
    () =>
      assertPromotionRetryable([
        entry('verified'),
        entry('approved'),
        entry('promoting'),
        entry('needs_human'),
      ]),
    /production mutation state: promoting/u,
  );
  assert.throws(
    () => assertPromotionRetryable([entry('verified'), entry('needs_human')]),
    /prior approval/u,
  );
});
