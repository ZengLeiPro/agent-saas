#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const RETRYABLE_TAIL_STATES = new Set(['approved', 'failed_before_change', 'needs_human']);
const RECOVERABLE_MUTATION_TAIL_STATES = new Set([...RETRYABLE_TAIL_STATES, 'promoting']);

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
  if (latest.state === 'needs_human' && promotingIndex >= 0) {
    const forbidden = tail.find((entry) => !RECOVERABLE_MUTATION_TAIL_STATES.has(entry?.state));
    if (forbidden)
      throw new Error(`Release has a terminal post-mutation state: ${forbidden.state}`);
    if (tail[promotingIndex - 1]?.state !== 'approved')
      throw new Error('Release promoting state is not preceded by an approval');
    if (!tail.slice(promotingIndex + 1).every((entry) => entry?.state === 'needs_human'))
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
