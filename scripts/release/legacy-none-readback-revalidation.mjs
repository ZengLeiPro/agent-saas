#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, digestBuffer, SHA_PATTERN } from './artifact-lib.mjs';
import { readEvidenceFile, readEvidenceJson } from './evidence-file.mjs';
import { assertPromotionRetryable } from './assert-promotion-retry.mjs';
import { stagingBinding } from './staging-deployment-binding.mjs';
import { assertArchivedDatabaseEvidence } from './verify-migration-readback.mjs';
import { assertDatabaseEvidence } from './migration-postconditions.mjs';

// Exact pre-#644 producer. This is a format compatibility contract, not an RC allowlist.
// A different producer, expand plan, or a fresh promotion must use ordinary evidence.
export const LEGACY_NONE_PRODUCER_BLOB = '55f3c65ffad956d978ea4e4347121677dc20b27d';
const RECEIPT = 'legacy-none-readback-revalidation.json';
const repositoryPattern = /^[\w.-]+\/[\w.-]+$/u;
const hash = (value) => digestBuffer(canonicalJson(value));
const evidenceKeys = [
  'checks',
  'environment',
  'manifestDigest',
  'observedAt',
  'planDigest',
  'releaseId',
  'schemaVersion',
  'status',
];

/** Validate only the known serializer defect, without editing the archived bytes.
 * The supplemental record attests a NONE plan, not a new Staging run or a DB query.
 * Live production identity, phase-prefix, configuration and side-effect gates stay downstream.
 */
export function revalidateLegacyNoneReadback({
  manifest,
  history,
  bytes,
  producerBlob,
  run,
  runId,
  runAttempt,
  repository,
  now = Date.now(),
}) {
  assert.equal(producerBlob, LEGACY_NONE_PRODUCER_BLOB, 'Unknown legacy readback producer');
  assert.ok(repositoryPattern.test(repository ?? ''), 'Repository is required');
  assert.ok(SHA_PATTERN.test(manifest?.releaseSha ?? ''), 'Invalid source SHA');
  const plan = manifest.migrationPlan;
  assert.equal(plan?.phase, 'none', 'Only a no-migration plan can be revalidated');
  assert.equal(plan.confirmation, 'not_required');
  assert.equal(plan.contract, 'separate_release');
  assert.deepEqual(Object.keys(plan).sort(), ['confirmation', 'contract', 'phase', 'planDigest']);
  const binding = stagingBinding(manifest, history);
  assert.equal(binding.stagingRunId, String(runId));
  assert.equal(binding.stagingRunAttempt, String(runAttempt));
  const retry = assertPromotionRetryable(history);
  assert.equal(retry.mode, 'retry_after_change', 'Only an interrupted promotion can recover');
  const marker = history.findLast((entry) => entry.operationKey === retry.promotingOperationKey);
  const mutation = JSON.parse(marker.reason);
  assert.match(marker.operationKey, /^promoting:[1-9][0-9]*:[1-9][0-9]*$/u);
  assert.equal(mutation.releaseId, manifest.releaseId);
  assert.equal(mutation.releaseSha, manifest.releaseSha);
  assert.equal(mutation.manifestDigest, manifest.digest);
  assert.equal(mutation.migrationPhase, 'none');
  assert.equal(mutation.migrationPlanDigest, plan.planDigest);
  const mutationTime = Date.parse(marker.recordedAt);
  assert.ok(Number.isFinite(mutationTime) && mutationTime >= Date.parse(binding.verifiedAt));
  assert.ok(mutationTime <= now + 60000, 'Promotion marker is in the future');

  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 4096, 'Invalid legacy evidence size');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const defect = '"postconditionsDigest":undefined,';
  assert.equal(raw.split(defect).length, 2, 'Not the known optional-field serialization defect');
  const historical = JSON.parse(raw.replace(defect, ''));
  assert.deepEqual(Object.keys(historical).sort(), evidenceKeys);
  // Re-encoding equality rejects duplicate keys, extra tokens, whitespace variants and
  // defects hidden inside strings. Nothing is written back to the original artifact.
  assert.equal(raw, canonicalJson({ ...historical, postconditionsDigest: undefined }) + '\n');
  const archived = assertArchivedDatabaseEvidence({
    manifest,
    evidence: historical,
    run,
    runId,
    runAttempt,
    repository,
    now,
  });
  const revalidatedAt = new Date(now).toISOString();
  const currentPlanCheck = {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    planDigest: plan.planDigest,
    environment: 'staging',
    observedAt: revalidatedAt,
    status: 'not_required',
    checks: [],
  };
  assertDatabaseEvidence(manifest, currentPlanCheck, 'staging', now);
  const body = {
    schemaVersion: 1,
    status: 'revalidated',
    scope: 'legacy_none_plan_only',
    repository,
    ...binding,
    planDigest: plan.planDigest,
    recoveryMode: retry.mode,
    promotingOperationKey: retry.promotingOperationKey,
    historyDigest: hash(history),
    revalidatedAt,
    original: {
      formatValid: false,
      format: 'undefined_optional_postconditions_digest',
      producerBlob,
      digest: digestBuffer(bytes),
      size: bytes.length,
      observedAt: archived.observedAt,
    },
    verification: {
      kind: 'manifest_none_plan',
      databaseAccessed: false,
      stagingRerun: false,
      status: currentPlanCheck.status,
      checks: 0,
    },
  };
  return { ...body, digest: hash(body) };
}

/** Bind the supplemental proof into the approval's existing Staging evidence summary. */
export function bindLegacyRevalidation({
  receipt,
  report,
  manifest,
  history,
  repository,
  bytes,
  now = Date.now(),
}) {
  const { digest, ...body } = receipt;
  assert.equal(digest, hash(body), 'Revalidation receipt digest mismatch');
  const binding = stagingBinding(manifest, history);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, 'revalidated');
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 4096);
  assert.equal(receipt.original.digest, digestBuffer(bytes));
  assert.equal(receipt.original.size, bytes.length);
  assert.equal(manifest.migrationPlan.phase, 'none');
  assert.deepEqual(receipt.verification, {
    kind: 'manifest_none_plan',
    databaseAccessed: false,
    stagingRerun: false,
    status: 'not_required',
    checks: 0,
  });
  assert.equal(receipt.scope, 'legacy_none_plan_only');
  assert.equal(receipt.repository, repository);
  assert.equal(receipt.historyDigest, hash(history));
  assert.equal(receipt.planDigest, manifest.migrationPlan.planDigest);
  assert.equal(receipt.original.formatValid, false);
  assert.equal(receipt.original.producerBlob, LEGACY_NONE_PRODUCER_BLOB);
  assert.equal(receipt.recoveryMode, 'retry_after_change');
  const retry = assertPromotionRetryable(history);
  assert.equal(retry.mode, 'retry_after_change');
  assert.equal(receipt.promotingOperationKey, retry.promotingOperationKey);
  assert.equal(report.status, 'passed');
  for (const key of Object.keys(binding)) {
    assert.equal(receipt[key], binding[key]);
    assert.equal(report[key], binding[key]);
  }
  const at = Date.parse(receipt.revalidatedAt);
  assert.ok(Number.isFinite(at) && now - at <= 300000 && at <= now + 60000);
  assert.ok(Date.parse(manifest.promotionPolicy.expiresAt) > now);
  return {
    ...report,
    databaseReadbackRevalidation: {
      scope: receipt.scope,
      digest,
      originalEvidenceDigest: receipt.original.digest,
      originalFormatValid: false,
      revalidatedAt: receipt.revalidatedAt,
      promotingOperationKey: receipt.promotingOperationKey,
    },
  };
}

async function main(args) {
  const [mode, manifestPath, historyPath, directory, repository] = args;
  assert.ok(args.length === 5 && args.every(Boolean) && repositoryPattern.test(repository));
  assert.ok(['revalidate', 'bind'].includes(mode));
  const manifest = await readEvidenceJson(manifestPath, 1048576);
  const historyBytes = await readEvidenceFile(historyPath, 4194304);
  const history = new TextDecoder('utf-8', { fatal: true })
    .decode(historyBytes)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const receiptPath = join(directory, RECEIPT);
  if (mode === 'bind') {
    const reportPath = join(directory, 'report.json');
    const report = bindLegacyRevalidation({
      receipt: await readEvidenceJson(receiptPath),
      report: await readEvidenceJson(reportPath),
      manifest,
      history,
      repository,
      bytes: await readEvidenceFile(
        join(directory, 'attempt-evidence/staging-database-readback.json'),
        4096,
      ),
    });
    const temporary = `${reportPath}.revalidated`;
    await writeFile(temporary, canonicalJson(report) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, reportPath);
    return;
  }
  assert.ok(SHA_PATTERN.test(manifest.releaseSha ?? ''));
  // Read Git object identity only; never execute the historical producer or its RC code.
  const producerBlob = execFileSync(
    'git',
    ['rev-parse', `${manifest.releaseSha}:scripts/release/read-migration-postconditions.mjs`],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  const binding = stagingBinding(manifest, history);
  const receipt = revalidateLegacyNoneReadback({
    manifest,
    history,
    repository,
    producerBlob,
    bytes: await readEvidenceFile(
      join(directory, 'attempt-evidence/staging-database-readback.json'),
      4096,
    ),
    run: await readEvidenceJson(join(directory, 'staging-attempt.json'), 1048576),
    runId: binding.stagingRunId,
    runAttempt: binding.stagingRunAttempt,
  });
  await writeFile(receiptPath, canonicalJson(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      status: 'passed',
      evidenceKind: 'supplemental_legacy_none_revalidation',
      releaseId: manifest.releaseId,
      manifestDigest: manifest.digest,
      revalidationDigest: receipt.digest,
      originalFormatValid: false,
    }),
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch {
    // Raw JSON, Git stderr, file paths and parser excerpts must not enter public logs.
    console.error('Legacy no-migration revalidation rejected; archived evidence was not modified');
    process.exitCode = 1;
  }
}
