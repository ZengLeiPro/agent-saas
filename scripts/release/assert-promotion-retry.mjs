#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const RETRYABLE_LATEST_STATES = new Set([
  'approved',
  'failed_before_change',
  'needs_human',
  'rolled_back',
]);
const PRE_MUTATION_TAIL_STATES = new Set(['approved', 'failed_before_change', 'needs_human']);
const POST_MUTATION_TAIL_STATES = new Set([
  ...PRE_MUTATION_TAIL_STATES,
  'promoting',
  'partial_failed',
  'rolled_back',
]);
const POST_MUTATION_TRANSITIONS = new Map([
  ['approved', new Set(['promoting', 'failed_before_change', 'needs_human'])],
  ['failed_before_change', new Set(['approved', 'failed_before_change', 'needs_human'])],
  ['promoting', new Set(['failed_before_change', 'partial_failed', 'needs_human', 'rolled_back'])],
  ['partial_failed', new Set(['rolled_back'])],
  // Controlled needs_human recovery may be re-approved directly. An authoritative operator
  // recovery may instead append rolled_back before a new approval.
  ['needs_human', new Set(['approved', 'needs_human', 'rolled_back'])],
  ['rolled_back', new Set(['approved'])],
]);

function assertUnambiguousMutationTail(tail) {
  const forbidden = tail.find((entry) => !POST_MUTATION_TAIL_STATES.has(entry?.state));
  if (forbidden)
    throw new Error(`Release has a terminal post-mutation state: ${String(forbidden?.state)}`);

  const firstPromotingIndex = tail.findIndex((entry) => entry?.state === 'promoting');
  if (firstPromotingIndex < 0)
    throw new Error('Release rolled_back state has no production promoting operation');
  if (tail[firstPromotingIndex - 1]?.state !== 'approved')
    throw new Error('Release promoting state is not preceded by an approval');

  let lastPromotingIndex = -1;
  let lastRolledBackIndex = -1;
  for (let index = firstPromotingIndex; index < tail.length; index += 1) {
    const state = tail[index]?.state;
    const previous = tail[index - 1]?.state;
    if (state === 'promoting') {
      if (previous !== 'approved')
        throw new Error('Release promoting state is not preceded by an approval');
      lastPromotingIndex = index;
    }
    if (index > firstPromotingIndex && !POST_MUTATION_TRANSITIONS.get(previous)?.has(state))
      throw new Error('Release has an ambiguous post-mutation attestation tail');
    if (state === 'rolled_back') {
      if (lastPromotingIndex <= lastRolledBackIndex)
        throw new Error('Release rolled_back state has no active production promoting operation');
      lastRolledBackIndex = index;
    }
  }

  return lastPromotingIndex;
}

export function assertPromotionRetryable(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('Release attestation history is empty');

  const verifiedIndex = entries.findLastIndex((entry) => entry?.state === 'verified');
  if (verifiedIndex < 0) throw new Error('Release has no verified Staging attestation');
  if (
    entries
      .slice(0, verifiedIndex)
      .some((entry) => entry?.state === 'promoting' || entry?.state === 'rolled_back')
  )
    throw new Error('Release has an ambiguous production mutation before its verified attestation');

  const latest = entries.at(-1);
  const tail = entries.slice(verifiedIndex + 1);
  const hasProductionMutation = tail.some(
    (entry) => entry?.state === 'promoting' || entry?.state === 'rolled_back',
  );

  if (latest?.state === 'verified') return { mode: 'fresh', latestState: 'verified' };
  if (!RETRYABLE_LATEST_STATES.has(latest?.state))
    throw new Error(`Release cannot be approved from ${String(latest?.state ?? 'unknown')}`);

  if (hasProductionMutation) {
    const promotingIndex = assertUnambiguousMutationTail(tail);
    return {
      mode: 'retry_after_change',
      latestState: latest.state,
      verifiedOperationKey: entries[verifiedIndex]?.operationKey,
      promotingOperationKey: tail[promotingIndex]?.operationKey,
      previousApprovalCount: tail.filter((entry) => entry?.state === 'approved').length,
    };
  }

  const forbidden = tail.find((entry) => !PRE_MUTATION_TAIL_STATES.has(entry?.state));
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
