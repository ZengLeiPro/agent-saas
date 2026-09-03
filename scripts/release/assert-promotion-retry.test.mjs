import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPromotionRetryable } from './assert-promotion-retry.mjs';

function entry(state, operationKey = state) {
  return { state, operationKey };
}

const verified = entry('verified', 'verified:1');

function mutationHistory(outcomeTail = []) {
  return [
    verified,
    entry('approved', 'approval:1'),
    entry('promoting', 'promoting:1'),
    ...outcomeTail,
  ];
}

test('accepts a fresh verified release and a fail-closed pre-mutation retry', () => {
  assert.deepEqual(assertPromotionRetryable([entry('built'), entry('verified')]), {
    mode: 'fresh',
    latestState: 'verified',
  });
  assert.deepEqual(
    assertPromotionRetryable([
      entry('built'),
      verified,
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

test('keeps promoting to failed_before_change retryable only as retry_after_change', () => {
  const failedBeforeChange = mutationHistory([entry('failed_before_change', 'reconcile:1')]);
  assert.deepEqual(assertPromotionRetryable(failedBeforeChange), {
    mode: 'retry_after_change',
    latestState: 'failed_before_change',
    verifiedOperationKey: 'verified:1',
    promotingOperationKey: 'promoting:1',
    previousApprovalCount: 1,
  });

  const nextReviewedRound = [
    ...failedBeforeChange,
    entry('approved', 'approval:2'),
    entry('promoting', 'promoting:2'),
    entry('failed_before_change', 'reconcile:2'),
  ];
  assert.deepEqual(assertPromotionRetryable(nextReviewedRound), {
    mode: 'retry_after_change',
    latestState: 'failed_before_change',
    verifiedOperationKey: 'verified:1',
    promotingOperationKey: 'promoting:2',
    previousApprovalCount: 2,
  });
});

test('requires authoritative rolled_back after partial_failed before retrying', () => {
  assert.throws(
    () => assertPromotionRetryable(mutationHistory([entry('partial_failed')])),
    /cannot be approved from partial_failed/u,
  );
  assert.deepEqual(
    assertPromotionRetryable(
      mutationHistory([entry('partial_failed'), entry('rolled_back', 'rollback:1')]),
    ),
    {
      mode: 'retry_after_change',
      latestState: 'rolled_back',
      verifiedOperationKey: 'verified:1',
      promotingOperationKey: 'promoting:1',
      previousApprovalCount: 1,
    },
  );
});

test('supports authoritative rolled_back after needs_human and preserves its controlled retry', () => {
  assert.deepEqual(assertPromotionRetryable(mutationHistory([entry('needs_human')])), {
    mode: 'retry_after_change',
    latestState: 'needs_human',
    verifiedOperationKey: 'verified:1',
    promotingOperationKey: 'promoting:1',
    previousApprovalCount: 1,
  });
  assert.equal(
    assertPromotionRetryable(
      mutationHistory([entry('needs_human'), entry('rolled_back', 'rollback:1')]),
    ).mode,
    'retry_after_change',
  );
});

test('supports direct rollback and multiple reviewed rollback rounds', () => {
  const firstRound = mutationHistory([entry('rolled_back', 'rollback:1')]);
  assert.equal(assertPromotionRetryable(firstRound).mode, 'retry_after_change');

  const secondRound = [
    ...firstRound,
    entry('approved', 'approval:2'),
    entry('promoting', 'promoting:2'),
    entry('partial_failed', 'partial:2'),
    entry('rolled_back', 'rollback:2'),
  ];
  assert.deepEqual(assertPromotionRetryable(secondRound), {
    mode: 'retry_after_change',
    latestState: 'rolled_back',
    verifiedOperationKey: 'verified:1',
    promotingOperationKey: 'promoting:2',
    previousApprovalCount: 2,
  });

  assert.equal(
    assertPromotionRetryable([...secondRound, entry('approved', 'approval:3')]).mode,
    'retry_after_change',
  );
});

test('rejects terminal states and unmapped recovery tails mixed into mutation history', () => {
  for (const terminal of ['completed', 'rejected', 'revoked', 'superseded']) {
    assert.throws(
      () =>
        assertPromotionRetryable(
          mutationHistory([entry(terminal), entry('rolled_back', `rollback:${terminal}`)]),
        ),
      /terminal post-mutation state/u,
    );
  }
  for (const tail of [
    [entry('partial_failed'), entry('needs_human'), entry('rolled_back')],
    [entry('needs_human'), entry('failed_before_change')],
    [entry('failed_before_change'), entry('partial_failed')],
    [entry('rolled_back'), entry('needs_human')],
    [entry('rolled_back'), entry('rolled_back', 'rollback:2')],
  ]) {
    assert.throws(
      () => assertPromotionRetryable(mutationHistory(tail)),
      /ambiguous|active|cannot be approved/u,
    );
  }
  assert.throws(
    () => assertPromotionRetryable([entry('approved'), entry('promoting'), entry('rolled_back')]),
    /no verified Staging attestation/u,
  );
  assert.throws(
    () => assertPromotionRetryable([entry('verified'), entry('promoting'), entry('rolled_back')]),
    /not preceded by an approval/u,
  );
  assert.throws(
    () => assertPromotionRetryable([entry('verified'), entry('needs_human')]),
    /prior approval/u,
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
