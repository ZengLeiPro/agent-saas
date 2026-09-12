export const integer = (value) =>
  /^[1-9][0-9]*$/u.test(String(value)) && Number.isSafeInteger(Number(value));
const retryStates = new Set(['verified', 'approved', 'failed_before_change', 'needs_human']);

export function requireEvidence(condition, check, expected, actual) {
  if (!condition) {
    const error = new Error(`Staging promotion evidence rejected: ${check}`);
    error.details = { check, expected: expected ?? null, actual: actual ?? null };
    throw error;
  }
}
export function equal(actual, expected, check) {
  requireEvidence(actual === expected, check, expected, actual);
}
export function time(value, check) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  requireEvidence(Number.isFinite(parsed), check, 'ISO timestamp', value);
  return parsed;
}

/** Operation keys are immutable and already bind RC113; never guess an attempt from latest run. */
export function stagingBinding(manifest, history) {
  requireEvidence(
    Array.isArray(history) && history.length > 0,
    'attestation_history',
    'nonempty',
    null,
  );
  requireEvidence(
    retryStates.has(history.at(-1)?.state),
    'attestation_tail',
    'reviewable',
    history.at(-1)?.state,
  );
  for (const entry of history) {
    equal(entry.releaseId, manifest.releaseId, 'attestation_release');
    equal(entry.manifestDigest, manifest.digest, 'attestation_manifest');
  }
  const verifiedIndex = history.findLastIndex((entry) => entry.state === 'verified');
  const stagedIndex = history.findLastIndex((entry) => entry.state === 'staging_deployed');
  requireEvidence(
    stagedIndex >= 0 && verifiedIndex > stagedIndex,
    'attestation_order',
    'staging_deployed then verified',
    null,
  );
  const staged = history[stagedIndex];
  const verified = history[verifiedIndex];
  let reason;
  try {
    reason = JSON.parse(staged.reason);
  } catch {
    requireEvidence(false, 'staging_reason', 'JSON object', null);
  }
  const key = /^staging:([1-9][0-9]*):([1-9][0-9]*)$/u.exec(staged.operationKey ?? '');
  requireEvidence(
    key && integer(key[1]) && integer(key[2]),
    'staging_operation',
    'staging:<run>:<attempt>',
    staged.operationKey,
  );
  equal(verified.operationKey, `deterministic:${key[1]}:${key[2]}`, 'verified_attempt');
  equal(String(reason?.stagingRunId), key[1], 'reason_run');
  if (reason?.stagingRunAttempt !== undefined)
    equal(String(reason.stagingRunAttempt), key[2], 'reason_attempt');
  equal(reason?.manifestDigest, manifest.digest, 'reason_manifest');
  requireEvidence(
    integer(reason?.stagingDeploymentId),
    'deployment_id',
    'positive safe integer',
    reason?.stagingDeploymentId,
  );
  requireEvidence(
    time(verified.recordedAt, 'verified_time') >= time(staged.recordedAt, 'staged_time'),
    'attestation_time_order',
    'verified >= staged',
    null,
  );
  return {
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    sourceSha: manifest.releaseSha,
    stagingDeploymentId: String(reason.stagingDeploymentId),
    stagingRunId: key[1],
    stagingRunAttempt: key[2],
    stagedAt: staged.recordedAt,
    verifiedAt: verified.recordedAt,
  };
}

export function validateRun(run, binding, repository, name, engineSha = binding.sourceSha) {
  equal(String(run?.id), binding.stagingRunId, `${name}.id`);
  equal(run?.repository?.full_name, repository, `${name}.repository`);
  equal(run?.head_repository?.full_name, repository, `${name}.head_repository`);
  equal(run?.head_sha, engineSha, `${name}.sha`);
  equal(run?.head_branch, 'main', `${name}.branch`);
  equal(run?.event, 'workflow_dispatch', `${name}.event`);
  equal(run?.path, '.github/workflows/deploy-staging.yml', `${name}.workflow`);
  equal(run?.run_attempt, Number(binding.stagingRunAttempt), `${name}.attempt`);
  equal(run?.status, 'completed', `${name}.status`);
  equal(run?.conclusion, 'success', `${name}.conclusion`);
}
