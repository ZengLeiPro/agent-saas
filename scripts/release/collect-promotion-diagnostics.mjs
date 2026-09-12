#!/usr/bin/env node
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeReceipt, safeRecovery, safeRestoration, safeMatrices, safeBudget, safeNextAction, safeAcsDrain } from './promotion-diagnostics-summary.mjs';

import { safePreflightSummary, safePrechangeFailure } from './production-preflight-report.mjs';
import { readEvidenceJson, readEvidenceJsonl } from './evidence-file.mjs';
import { collectAssetDiagnostics } from './web-asset-diagnostics.mjs';
import { safeComponentResults } from './promotion-diagnostics-scopes.mjs';
export { safeAssetEvent } from './web-asset-diagnostics.mjs';

export async function collectDiagnostics(root, output, context = { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT }) {
  const json = async (name) => {
    try {
      return await readEvidenceJson(join(root, name));
    } catch {
      return null;
    }
  };
  const engine = await json('deployment-engine.json');
  const reconciliation = await json('reconcile.json');
  const webAssets = await collectAssetDiagnostics(join(root, 'web-asset-diagnostics'));
  const preflight = safePreflightSummary(await json('production-preflight.json'), context);
  const prechangeFailure = safePrechangeFailure(await json('promotion-prechange-failure.json'), context);
  const result = {
    preflight, prechangeFailure,
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
      : (prechangeFailure || preflight?.status === 'failed') ? 'failed_before_change' : 'unknown',
    componentResults: safeComponentResults(reconciliation?.componentResults),
    webAssets,
    evidencePresent: {},
    matrices: safeMatrices(await json('reconcile-input.json')),
    budget: safeBudget(await json('web-budget.json')),
    restoration: safeRestoration(await json('web-rollback.json')),
    priorTransactionRestoration: safeRestoration(await json('web-recovery-restore.json')),
    webRecovery: safeRecovery(await json('web-recovery-last.json')),
    acsDrain: null,
    nextAction: safeNextAction(reconciliation?.recovery),
    operationReceipts: [],
  };
  try {
    result.acsDrain = safeAcsDrain(await readEvidenceJsonl(join(root, 'acs-drain-diagnostics.jsonl')));
  } catch {
    result.acsDrain = null;
  }
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
    'acs-drain-diagnostics.jsonl',
  ])
    result.evidencePresent[name] = name.endsWith('.jsonl')
      ? result.acsDrain !== null
      : (await json(name)) !== null;
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  });
  return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await collectDiagnostics(...process.argv.slice(2));
