#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';
import { readEvidenceJson } from './evidence-file.mjs';
import { assertDatabaseEvidence } from './migration-postconditions.mjs';

/** Archive age is bounded by the authenticated staging attempt AND the RC lifetime.
 * The live reader's five-minute default is deliberately not used as the archive lifetime.
 */
export function assertArchivedDatabaseEvidence({
  manifest, evidence, run, runId, runAttempt, repository, now = Date.now(),
}) {
  const start = Date.parse(run?.run_started_at);
  const end = Date.parse(run?.updated_at);
  const observed = Date.parse(evidence?.observedAt);
  const expiry = Date.parse(manifest?.promotionPolicy?.expiresAt);
  if (
    !Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(end) ||
    !Number.isFinite(observed) || !Number.isFinite(expiry) || expiry <= now ||
    start > end || end > now + 60000 || end - start > 86400000 ||
    observed < start - 60000 || observed > end + 60000 ||
    !/^[1-9][0-9]*$/u.test(String(runId)) ||
    !/^[1-9][0-9]*$/u.test(String(runAttempt)) ||
    String(run?.id) !== String(runId) || String(run?.run_attempt) !== String(runAttempt) ||
    !repository || run?.repository?.full_name !== repository ||
    run?.head_repository?.full_name !== repository ||
    !SHA_PATTERN.test(manifest?.releaseSha ?? '') || run?.head_sha !== manifest.releaseSha ||
    run?.head_branch !== 'main' || run?.event !== 'workflow_dispatch' ||
    run?.path !== '.github/workflows/deploy-staging.yml' ||
    run?.status !== 'completed' || run?.conclusion !== 'success' ||
    !DIGEST_PATTERN.test(manifest?.digest ?? '') ||
    !DIGEST_PATTERN.test(manifest?.migrationPlan?.planDigest ?? '') ||
    evidence?.schemaVersion !== 1
  )
    throw new Error('Database evidence is outside the bound staging attempt or RC lifetime');
  assertDatabaseEvidence(manifest, evidence, 'staging', end, Math.max(300000, end - start + 60000));
  return {
    schemaVersion: 1,
    status: 'passed',
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    planDigest: manifest.migrationPlan.planDigest,
    environment: 'staging',
    stagingRunId: String(runId),
    stagingRunAttempt: String(runAttempt),
    observedAt: evidence.observedAt,
    migrationPhase: manifest.migrationPlan.phase,
    checks: evidence.checks.length,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [manifestPath, evidencePath, runPath, runId, runAttempt] = process.argv.slice(2);
    if (!runAttempt) throw new Error('Expected manifest, readback, bound attempt, run ID and attempt');
    const result = assertArchivedDatabaseEvidence({
      manifest: await readEvidenceJson(manifestPath, 1048576),
      evidence: await readEvidenceJson(evidencePath),
      run: await readEvidenceJson(runPath),
      runId, runAttempt, repository: process.env.GITHUB_REPOSITORY,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Migration readback rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
