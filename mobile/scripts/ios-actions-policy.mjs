import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const IOS_WORKFLOW = '.github/workflows/mobile-ios-release.yml';
export const IOS_BUILD_JOB = 'iOS / 签名构建';
export const IOS_ENVIRONMENTS = Object.freeze({
  build: 'mobile-build-production',
  submit: 'mobile-submit-ios-store',
});

export function requireSha(value, label = 'source SHA') {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.equal(value.length, 40, `${label} must contain exactly 40 characters`);
  assert.match(value, /^[0-9a-f]{40}$/u, `${label} must be a full lowercase Git SHA`);
  return value;
}

export function requireId(value, label) {
  const text = String(value ?? '');
  assert.match(text, /^[1-9][0-9]*$/u, `${label} must be a positive integer`);
  assert.ok(Number.isSafeInteger(Number(text)), `${label} is too large`);
  assert.equal(text, String(Number(text)), `${label} must be canonical`);
  return text;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function allocateBuildNumber(baseBuildNumber, runId, attempt) {
  const base = requireId(baseBuildNumber, 'manifest iOS build number');
  return `${base}.${requireId(runId, 'run ID')}.${requireId(attempt, 'attempt')}`;
}

export function validateDispatch(context, inputs) {
  assert.equal(context.event, 'workflow_dispatch', 'Release is manual dispatch only');
  assert.equal(context.ref, 'refs/heads/main', 'Dispatch the reviewed workflow from main only');
  assert.match(context.repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  const operation = inputs.operation;
  assert.ok(['build', 'build-and-submit', 'submit'].includes(operation), 'Unknown iOS operation');
  const sourceSha = requireSha(inputs.source_sha || context.sha);
  const buildRunId = requireId(operation === 'submit' ? inputs.build_run_id : context.runId, 'build run ID');
  const buildAttempt = requireId(operation === 'submit' ? inputs.build_run_attempt : context.attempt, 'build attempt');
  if (operation !== 'submit') {
    assert.ok(!inputs.build_run_id, 'build_run_id is only valid for submit');
  } else {
    assert.ok(inputs.source_sha, 'submit requires the exact source_sha from the build summary');
    assert.notEqual(buildRunId, String(context.runId), 'submit-only must reference an earlier build run');
  }
  return { operation, sourceSha, buildRunId, buildAttempt };
}

export function artifactName(sourceSha, runId, attempt) {
  return `ios-ipa-${requireSha(sourceSha)}-${requireId(runId, 'run ID')}-${requireId(attempt, 'attempt')}`;
}

function assertRepository(run, repository) {
  assert.equal(run.repository?.full_name, repository, 'Workflow belongs to another repository');
  assert.equal(run.head_repository?.full_name, repository, 'Fork workflow is not a release authority');
}

export function validateCiRun(run, jobs, sourceSha, repository) {
  assertRepository(run, repository);
  assert.equal(run.path, '.github/workflows/ci.yml', 'Wrong CI workflow');
  assert.equal(run.event, 'push', 'Only push-main CI authorizes a release');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, requireSha(sourceSha), 'CI source mismatch');
  assert.equal(run.status, 'completed', 'Wait for the selected main commit CI to finish');
  assert.equal(run.conclusion, 'success', 'The latest CI run for the selected commit must succeed');
  const gate = jobs.filter((job) => job.name === 'Build & Check');
  assert.equal(gate.length, 1, 'Missing or ambiguous Build & Check gate');
  assert.equal(gate[0].status, 'completed');
  assert.equal(gate[0].conclusion, 'success', 'Build & Check did not pass');
  return { runId: run.id, attempt: run.run_attempt, sourceGitSha: sourceSha };
}

export function validateBuildRun(run, jobs, artifacts, expected) {
  assertRepository(run, expected.repository);
  assert.equal(run.path, IOS_WORKFLOW, 'Only this iOS workflow can supply a release artifact');
  assert.equal(run.event, 'workflow_dispatch', 'PR artifacts cannot be submitted');
  assert.equal(run.head_branch, 'main', 'Build workflow was not dispatched from main');
  assert.equal(String(run.id), requireId(expected.buildRunId, 'build run ID'));
  assert.equal(String(run.run_attempt), requireId(expected.buildAttempt, 'build attempt'));
  requireSha(run.head_sha, 'build workflow SHA');
  if (String(run.id) !== String(expected.currentRunId)) {
    assert.equal(run.status, 'completed', 'The referenced build run is still active');
  }
  // A successful build may be reused after a later submit job failed. Never
  // infer build success merely from an artifact existing or a run conclusion.
  const builds = jobs.filter((job) => job.name === IOS_BUILD_JOB);
  assert.equal(builds.length, 1, 'Missing or ambiguous signed build job');
  assert.equal(builds[0].status, 'completed');
  assert.equal(builds[0].conclusion, 'success', 'Signed build job did not succeed');
  const name = artifactName(expected.sourceSha, expected.buildRunId, expected.buildAttempt);
  const matches = artifacts.filter((artifact) => artifact.name === name);
  assert.equal(matches.length, 1, 'Exactly one immutable IPA artifact must match source/run/attempt');
  const artifact = matches[0];
  assert.equal(artifact.expired, false, 'IPA artifact has expired; do not silently rebuild');
  assert.equal(String(artifact.workflow_run?.id), String(run.id), 'Artifact run mismatch');
  assert.match(artifact.digest ?? '', /^sha256:[0-9a-f]{64}$/u, 'GitHub artifact digest is missing');
  requireId(artifact.id, 'artifact ID');
  assert.ok(artifact.size_in_bytes > 0, 'Empty IPA artifact');
  return { artifactId: String(artifact.id), artifactDigest: artifact.digest, workflowSha: run.head_sha };
}

export function validateEnvironment(environment, expected) {
  assert.equal(environment.name, expected.environment, 'Wrong protected environment');
  const reviewers = environment.protection_rules?.filter((rule) => rule.type === 'required_reviewers') ?? [];
  assert.equal(reviewers.length, 0, 'Normal iOS release must not require a second environment approval');
  const policy = environment.deployment_branch_policy;
  assert.equal(policy?.protected_branches, false, 'Use an explicit main-only environment branch policy');
  assert.equal(policy?.custom_branch_policies, true, 'Use an explicit main-only environment branch policy');
  assert.ok(expected.branchPolicies?.length > 0, 'Deployment branch policy metadata is missing');
  assert.ok(expected.branchPolicies.every((item) => item.name === 'main' && item.type === 'branch'),
    'Custom environment branch policy must allow main only, not tags');
  return {
    environment: environment.name,
    environmentId: environment.id,
    protectionRulesSha256: digest(canonical({
      protection_rules: environment.protection_rules,
      deployment_branch_policy: policy,
      branch_policies: expected.branchPolicies ?? [],
    })),
    authorization: 'workflow_dispatch',
    actor: expected.actor,
    triggeringActor: expected.triggeringActor,
  };
}
