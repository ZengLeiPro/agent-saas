import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCoreSmokeEvidence } from './staging-core-smoke-evidence.mjs';

import {
  integer,
  requireEvidence,
  equal,
  time,
  stagingBinding,
  validateRun,
} from './staging-deployment-binding.mjs';
export { stagingBinding } from './staging-deployment-binding.mjs';

const digest = (value) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const states = new Set([
  'success',
  'inactive',
  'failure',
  'error',
  'pending',
  'queued',
  'in_progress',
]);

/** Full paginated status history, not `.some(success)` and not a synthetic status rewrite. */
export function validateStagingDeployment({
  manifest,
  history,
  deployment,
  statusPages,
  attemptRun,
  latestRun,
  repository,
  now = Date.now(),
}) {
  requireEvidence(
    /^[\w.-]+\/[\w.-]+$/u.test(repository ?? ''),
    'repository',
    'owner/repo',
    repository,
  );
  const binding = stagingBinding(manifest, history);
  requireEvidence(
    time(manifest.promotionPolicy?.expiresAt, 'rc_expiry') > now,
    'rc_expiry',
    'unexpired RC',
    manifest.promotionPolicy?.expiresAt,
  );
  equal(String(deployment?.id), binding.stagingDeploymentId, 'deployment.id');
  equal(deployment?.environment, 'staging', 'deployment.environment');
  equal(deployment?.sha, binding.sourceSha, 'deployment.sha');
  equal(deployment?.payload?.releaseId, binding.releaseId, 'deployment.release');
  equal(deployment?.payload?.manifestDigest, binding.manifestDigest, 'deployment.manifest');
  equal(String(deployment?.payload?.stagingRunId), binding.stagingRunId, 'deployment.run');
  if (deployment?.payload?.stagingRunAttempt !== undefined)
    equal(
      String(deployment.payload.stagingRunAttempt),
      binding.stagingRunAttempt,
      'deployment.attempt',
    );
  validateRun(attemptRun, binding, repository, 'bound_run');
  // A newer attempt may have changed or invalidated this deployment. Fail closed, even if green.
  // A fresh RC is required rather than combining an old attestation with newer smoke evidence.
  validateRun(latestRun, binding, repository, 'latest_run');
  const started = time(attemptRun.run_started_at, 'run_started_at');
  const finished = time(attemptRun.updated_at, 'run_finished_at');
  const verified = time(binding.verifiedAt, 'verified_at');
  requireEvidence(
    started <= verified && verified <= finished + 60_000 && finished <= now + 60_000,
    'run_time_window',
    'verification within completed attempt',
    null,
  );
  requireEvidence(
    Array.isArray(statusPages) &&
      statusPages.length > 0 &&
      statusPages.every(
        (page, index) =>
          Array.isArray(page) &&
          page.length <= 100 &&
          (index === statusPages.length - 1 || page.length === 100),
      ),
    'status_pagination',
    'complete gh api --paginate --slurp pages',
    null,
  );
  const statuses = statusPages.flat();
  requireEvidence(statuses.length > 0, 'status_history', 'nonempty', statuses.length);
  const ids = new Set();
  const expectedUrl = `https://api.github.com/repos/${repository}/deployments/${binding.stagingDeploymentId}`;
  for (const status of statuses) {
    requireEvidence(
      integer(status?.id) && !ids.has(String(status.id)),
      'status_id',
      'unique positive integer',
      status?.id,
    );
    ids.add(String(status.id));
    equal(status.deployment_url, expectedUrl, 'status_deployment');
    equal(status.environment, 'staging', 'status_environment');
    requireEvidence(
      states.has(status.state),
      'status_state',
      'known GitHub deployment state',
      status.state,
    );
    requireEvidence(
      time(status.created_at, 'status_time') <= now + 60_000,
      'status_future',
      'not in future',
      status.created_at,
    );
  }
  statuses.sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || Number(a.id) - Number(b.id),
  );
  // GitHub status times have second precision, while attestations have milliseconds.
  const eligible = statuses.findIndex(
    (status) =>
      status.state === 'success' &&
      Date.parse(status.created_at) >= Math.floor(verified / 1000) * 1000 &&
      Date.parse(status.created_at) <= finished + 60_000,
  );
  requireEvidence(
    eligible >= 0,
    'bound_success',
    'success after verification within the bound attempt',
    statuses.at(-1)?.state,
  );
  const success = statuses[eligible];
  const runUrl = `https://github.com/${repository}/actions/runs/${binding.stagingRunId}`;
  if (success.log_url)
    requireEvidence(
      [runUrl, `${runUrl}/attempts/${binding.stagingRunAttempt}`].includes(success.log_url),
      'success_log_binding',
      `${runUrl}/attempts/${binding.stagingRunAttempt}`,
      success.log_url,
    );
  // Fail/error after verification cannot be washed away by a later manual success.
  for (const status of statuses) {
    if (
      ['failure', 'error', 'pending', 'queued', 'in_progress'].includes(status.state) &&
      Date.parse(status.created_at) >= Math.floor(verified / 1000) * 1000
    )
      requireEvidence(
        false,
        'post_verification_failure',
        'no failure/error or restart after verification',
        { id: status.id, state: status.state, createdAt: status.created_at },
      );
  }
  for (const status of statuses.slice(eligible + 1)) {
    requireEvidence(
      status.state === 'inactive',
      'post_success_state',
      'only inactive after bound success; otherwise reverify a new RC',
      { id: status.id, state: status.state, createdAt: status.created_at },
    );
  }
  return {
    schemaVersion: 1,
    status: 'metadata_verified',
    phase: 'before_production_mutation',
    ...binding,
    deploymentLatestState: statuses.at(-1).state,
    deploymentSuccessStatusId: String(success.id),
    deploymentSuccessAt: success.created_at,
    deploymentInactiveAt:
      statuses.find((status, index) => index > eligible && status.state === 'inactive')
        ?.created_at ?? null,
    inactivityPolicy:
      'lifecycle-only; revocation requires failure/error or RC attestation rejection',
    inactivityOrigin: 'not-inferred',
    statusHistoryDigest: digest(statuses),
    checkedAt: new Date(now).toISOString(),
  };
}

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

export async function recordPreflightFailure(directory, check, details = null, exitCode = 1) {
  await mkdir(directory, { recursive: true });
  let previous = {};
  try {
    previous = await json(join(directory, 'report.json'));
  } catch {
    /* No prior report. */
  }
  const report = {
    ...previous,
    schemaVersion: 1,
    status: 'rejected',
    phase: 'before_production_mutation',
    check,
    ...(details ?? {}),
    exitCode,
    rejectedAt: new Date().toISOString(),
  };
  await save(join(directory, 'report.json'), report);
  return report;
}

async function main([mode, directory, manifestPath, historyPath]) {
  await mkdir(directory, { recursive: true });
  if (mode === 'failure') {
    let existing;
    try {
      existing = await json(join(directory, 'report.json'));
    } catch {
      /* Early failure. */
    }
    if (existing?.status !== 'rejected')
      await recordPreflightFailure(
        directory,
        process.env.STAGING_PREFLIGHT_CHECK ?? 'unknown',
        null,
        Number(process.env.STAGING_PREFLIGHT_EXIT_CODE ?? 1),
      );
    console.error(`Staging promotion preflight rejected; see ${join(directory, 'report.json')}`);
    return;
  }
  try {
    const manifest = await json(manifestPath);
    const history = (await readFile(historyPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (mode === 'binding') {
      await save(join(directory, 'binding.json'), stagingBinding(manifest, history));
      return;
    }
    requireEvidence(
      ['verify', 'complete'].includes(mode),
      'cli_mode',
      'binding, verify, complete or failure',
      mode,
    );
    const report = validateStagingDeployment({
      manifest,
      history,
      repository: process.env.GITHUB_REPOSITORY,
      deployment: await json(join(directory, 'deployment.json')),
      statusPages: await json(join(directory, 'deployment-statuses.json')),
      attemptRun: await json(join(directory, 'staging-attempt.json')),
      latestRun: await json(join(directory, 'staging-run.json')),
    });
    if (mode === 'complete') {
      const smoke = validateCoreSmokeEvidence(
        await json(join(directory, 'staging-core-smoke.json')),
        report,
      );
      report.coreSmokeEvidenceDigest = smoke.evidenceDigest;
      report.status = 'passed';
    }
    await save(join(directory, 'report.json'), report);
    console.log(JSON.stringify(report));
  } catch (error) {
    const report = await recordPreflightFailure(
      directory,
      error.details?.check ?? `preflight_${mode}`,
      error.details,
    );
    // Never print raw API responses, tokens, subprocess stderr or command lines.
    console.error(JSON.stringify(report));
    process.exitCode = 1;
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
