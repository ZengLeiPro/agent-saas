#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateCoreSmokeEvidence } from './staging-core-smoke-evidence.mjs';

export function validateAcceptanceBinding({ manifest, deployment, run, isolation, smoke, final }) {
  if (
    deployment.environment !== 'staging' ||
    deployment.sha !== manifest.releaseSha ||
    deployment.payload?.releaseId !== manifest.releaseId ||
    deployment.payload?.manifestDigest !== manifest.digest ||
    String(deployment.payload?.stagingRunId) !== String(run.id) ||
    run.head_sha !== manifest.releaseSha ||
    run.head_branch !== 'main' ||
    run.event !== 'workflow_dispatch' ||
    run.path !== '.github/workflows/deploy-staging.yml' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    throw new Error('Acceptance evidence is not bound to the successful exact RC deployment');
  validateCoreSmokeEvidence(smoke, {
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    sourceSha: manifest.releaseSha,
    stagingRunId: String(run.id),
    stagingRunAttempt: String(run.run_attempt),
  });
  if (
    isolation?.schemaVersion !== 1 ||
    isolation.releaseId !== manifest.releaseId ||
    isolation.manifestDigest !== manifest.digest ||
    isolation.stagingRunId !== String(run.id) ||
    isolation.stagingRunAttempt !== String(run.run_attempt) ||
    isolation.environment !== 'staging' ||
    isolation.status !== 'verified-with-accepted-residual-risk' ||
    !/^sha256:[a-f0-9]{64}$/u.test(isolation.evidenceDigest ?? '') ||
    final?.releaseId !== manifest.releaseId ||
    final.runtimeConverged !== true ||
    final.state !== 'target_runtime'
  )
    throw new Error(
      'Acceptance isolation or final runtime evidence is missing or belongs to another RC',
    );
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , repository, manifestPath, deploymentId, output] = process.argv;
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? '') || !/^[1-9][0-9]*$/u.test(deploymentId ?? ''))
    throw new Error('Acceptance requires a repository and authoritative deployment ID');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const gh = (...args) =>
    execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const deployment = JSON.parse(gh('api', `repos/${repository}/deployments/${deploymentId}`));
  const runId = String(deployment.payload?.stagingRunId ?? '');
  if (!/^[1-9][0-9]*$/u.test(runId))
    throw new Error(
      'Historical RC lacks attempt-bound evidence; create and deploy a new RC before acceptance',
    );
  const run = JSON.parse(gh('api', `repos/${repository}/actions/runs/${runId}`));
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1)
    throw new Error('Invalid staging run attempt');
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  try {
    gh(
      'run',
      'download',
      runId,
      '--repo',
      repository,
      '--name',
      `staging-evidence-${manifest.releaseId}-${run.run_attempt}`,
      '--dir',
      directory,
    );
  } catch {
    throw new Error(
      'Required Staging attempt evidence is missing or expired; redeploy the RC before acceptance',
    );
  }
  const json = async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'));
  const [isolation, smoke, final] = await Promise.all(
    ['isolation-summary.json', 'staging-core-smoke.json', 'staging-final.json'].map(json),
  );
  validateAcceptanceBinding({ manifest, deployment, run, isolation, smoke, final });
  if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required');
  await appendFile(
    process.env.GITHUB_ENV,
    `STAGING_ISOLATION_SUMMARY=${join(directory, 'isolation-summary.json')}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      releaseId: manifest.releaseId,
      stagingRunId: runId,
      stagingRunAttempt: run.run_attempt,
      status: 'validated',
    })}\n`,
  );
}
