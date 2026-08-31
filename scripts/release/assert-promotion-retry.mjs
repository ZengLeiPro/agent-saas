#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

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

function isRetryableTail(tail) {
  let index = 0;
  while (index < tail.length) {
    if (tail[index]?.state !== 'approved') return false;
    index += 1;
    if (index === tail.length) return true;
    if (tail[index]?.state === 'promoting') {
      if (!hasPromotionBinding(tail[index])) return false;
      index += 1;
      if (index >= tail.length || tail[index]?.state !== 'failed_before_change') return false;
      index += 1;
    } else if (tail[index]?.state === 'failed_before_change') index += 1;
    else return false;
  }
  return true;
}

export function assertPromotionRetryable(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('Release attestation history is empty');
  const latest = entries.at(-1);
  if (latest?.state === 'verified') return { mode: 'fresh', latestState: 'verified' };
  if (latest?.state !== 'approved' && latest?.state !== 'failed_before_change')
    throw new Error(`Release cannot be approved from ${String(latest?.state ?? 'unknown')}`);

  const verifiedIndex = entries.findLastIndex((entry) => entry?.state === 'verified');
  if (verifiedIndex < 0) throw new Error('Release has no verified Staging attestation');
  const tail = entries.slice(verifiedIndex + 1);
  if (!tail.some((entry) => entry?.state === 'approved'))
    throw new Error('Release has no prior approval to recover');
  if (!isRetryableTail(tail))
    throw new Error(
      'Release may have entered production mutation state or lacks bound failure proof',
    );

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
