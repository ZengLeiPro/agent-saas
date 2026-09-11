#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeReceipt, safeRecovery, safeRestoration, safeMatrices, safeBudget, safeNextAction } from './promotion-diagnostics-summary.mjs';

export function safeAssetEvent(value) {
  if (
    !value ||
    !/^[A-Za-z0-9._/-]{1,512}$/.test(value.key ?? '') ||
    ![
      'compress',
      'put',
      'readback',
      'metadata',
      'public-head',
      'public-headers',
      'verify',
      'get',
    ].includes(value.phase)
  )
    return null;
  if (
    ![value.attempt, value.exitCode, value.durationSeconds].every(
      (item) => Number.isSafeInteger(item) && item >= 0,
    )
  )
    return null;
  return {
    key: value.key,
    phase: value.phase,
    attempt: value.attempt,
    exitCode: value.exitCode,
    durationSeconds: value.durationSeconds,
  };
}
export async function collectDiagnostics(root, output) {
  const json = async (name) => {
    try {
      const path = join(root, name); const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256_000) return null;
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return null;
    }
  };
  const engine = await json('deployment-engine.json');
  const reconciliation = await json('reconcile.json');
  const events = [];
  let truncated = false;
  const directory = join(root, 'web-asset-diagnostics');
  for (const name of (await readdir(directory).catch(() => []))
    .filter((name) => /^worker-[0-9]+\.jsonl$/.test(name))
    .sort().slice(0, 8)) {
    const file = join(directory, name); const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512_000) { truncated = true; continue; }
    const bytes = await readFile(file);
    if (bytes.length > 512_000) {
      truncated = true;
      continue;
    }
    for (const line of bytes.toString().split('\n').filter(Boolean)) {
      try {
        const value = safeAssetEvent(JSON.parse(line));
        if (value && events.length < 2000) events.push(value);
        else truncated = true;
      } catch {
        truncated = true;
      }
    }
  }
  const result = {
    schemaVersion: 1,
    engine: engine
      ? {
          sourceSha: engine.sourceSha,
          implementationDigest: engine.implementationDigest,
          workflow: engine.workflow,
        }
      : null,
    outcome: [
      'completed',
      'failed_before_change',
      'partial_failed',
      'rolled_back',
      'needs_human',
    ].includes(reconciliation?.outcome)
      ? reconciliation.outcome
      : 'unknown',
    webAssets: { events, truncated },
    evidencePresent: {},
    matrices: safeMatrices(await json('reconcile-input.json')),
    budget: safeBudget(await json('web-budget.json')),
    restoration: safeRestoration(await json('web-rollback.json')),
    priorTransactionRestoration: safeRestoration(await json('web-recovery-restore.json')),
    webRecovery: safeRecovery(await json('web-recovery-last.json')),
    nextAction: safeNextAction(reconciliation?.recovery),
    operationReceipts: [],
  };
  const receipts = (await readdir(join(root, 'operation-receipts')).catch(() => [])).filter((name) => /^operation-[A-Za-z0-9_.-]+\.json$/u.test(name)).sort();
  for (const name of receipts.slice(0, 64)) {
    const receipt = safeReceipt(await json('operation-receipts/' + name));
    if (receipt) result.operationReceipts.push(receipt);
  }
  result.receiptsTruncated = receipts.length > 64;
  for (const name of [
    'production-before.json',
    'production-after.json',
    'reconcile-input.json',
    'app-handoff.json',
    'production-checkpoint.json',
    'checkpoint-maintenance.json',
  ])
    result.evidencePresent[name] = (await json(name)) !== null;
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  });
  return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await collectDiagnostics(...process.argv.slice(2));
