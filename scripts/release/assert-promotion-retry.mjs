#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const RETRYABLE_TAIL_STATES = new Set(['approved', 'failed_before_change', 'needs_human']);
const RECOVERABLE_MUTATION_TAIL_STATES = new Set([...RETRYABLE_TAIL_STATES, 'promoting']);
// durable promoting 后的 failed_before_change 仍按 post-mutation 路径要求人工复核。

function hasPromotionBinding(entry) {
  if (entry?.state !== 'promoting' || typeof entry.reason !== 'string') return false;
  try {
    const value = JSON.parse(entry.reason);
    return (
      ['none', 'expand'].includes(value.migrationPhase) &&
      [
        value.manifestDigest,
        value.migrationPlanDigest,
        value.productionBeforeDigest,
        value.productionTargetDigest,
      ].every((digest) => /^sha256:[a-f0-9]{64}$/u.test(digest ?? ''))
    );
  } catch {
    return false;
  }
}

function hasReviewedMutationRecoveryTail(tail) {
  let mutationSeen = false;
  let reviewedCurrentMutation = false;
  for (let index = 0; index < tail.length; index += 1) {
    const state = tail[index]?.state;
    const previousState = tail[index - 1]?.state;
    if (!mutationSeen) {
      if (state === 'promoting') {
        if (previousState !== 'approved' || !hasPromotionBinding(tail[index])) return false;
        mutationSeen = true;
        reviewedCurrentMutation = false;
      } else if (!RETRYABLE_TAIL_STATES.has(state)) return false;
      continue;
    }
    if (state === 'promoting') {
      if (
        previousState !== 'approved' ||
        !reviewedCurrentMutation ||
        !hasPromotionBinding(tail[index])
      )
        return false;
      reviewedCurrentMutation = false;
    } else if (state === 'needs_human') {
      if (previousState !== 'promoting' && previousState !== 'needs_human') return false;
      reviewedCurrentMutation = true;
    } else if (state === 'approved') {
      if (
        !reviewedCurrentMutation ||
        (previousState !== 'needs_human' && previousState !== 'failed_before_change')
      )
        return false;
    } else if (state === 'failed_before_change') {
      if (previousState === 'promoting') reviewedCurrentMutation = true;
      else if (!reviewedCurrentMutation || previousState !== 'approved') return false;
    } else return false;
  }
  return mutationSeen && reviewedCurrentMutation;
}

export function assertPromotionRetryable(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('Release attestation history is empty');
  const latest = entries.at(-1);
  if (latest?.state === 'verified') return { mode: 'fresh', latestState: 'verified' };
  if (
    latest?.state !== 'approved' &&
    latest?.state !== 'needs_human' &&
    latest?.state !== 'failed_before_change'
  )
    throw new Error(`Release cannot be approved from ${String(latest?.state ?? 'unknown')}`);

  const verifiedIndex = entries.findLastIndex((entry) => entry?.state === 'verified');
  if (verifiedIndex < 0) throw new Error('Release has no verified Staging attestation');
  const tail = entries.slice(verifiedIndex + 1);
  const promotingIndex = tail.findLastIndex((entry) => entry?.state === 'promoting');
  if (promotingIndex >= 0) {
    const forbidden = tail.find((entry) => !RECOVERABLE_MUTATION_TAIL_STATES.has(entry?.state));
    if (forbidden)
      throw new Error(`Release has a terminal post-mutation state: ${forbidden.state}`);
    if (!hasReviewedMutationRecoveryTail(tail))
      throw new Error('Release has an ambiguous post-mutation attestation tail');
    return {
      mode: 'retry_after_change',
      latestState: latest.state,
      verifiedOperationKey: entries[verifiedIndex]?.operationKey,
      promotingOperationKey: tail[promotingIndex]?.operationKey,
      previousApprovalCount: tail.filter((entry) => entry?.state === 'approved').length,
    };
  }
  const forbidden = tail.find((entry) => !RETRYABLE_TAIL_STATES.has(entry?.state));
  if (forbidden)
    throw new Error(`Release may have entered production mutation state: ${forbidden.state}`);
  if (!tail.some((entry) => entry?.state === 'approved'))
    throw new Error('Release has no prior approval to recover');

  return {
    mode: 'retry_before_change',
    latestState: latest.state,
    verifiedOperationKey: entries[verifiedIndex]?.operationKey,
    previousApprovalCount: tail.filter((entry) => entry?.state === 'approved').length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error('usage: assert-promotion-retry.mjs <attestation.jsonl>');
  const entries = (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  process.stdout.write(`${JSON.stringify(assertPromotionRetryable(entries))}\n`);
}
