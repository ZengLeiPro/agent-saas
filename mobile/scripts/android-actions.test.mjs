import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANDROID_ENVIRONMENT,
  ANDROID_OPERATIONS,
  ANDROID_WORKFLOW,
  artifactName,
  resolveAndroidOperation,
} from './android-actions.mjs';
import { requireSha, validateCiRun, validateDispatch, validateEnvironment } from './ios-actions-policy.mjs';
import { waitForCi } from './ios-release-inputs.mjs';

const sha = 'a'.repeat(40);
const repository = 'example/android-release-contract';
const repo = { full_name: repository };
const dispatch = {
  event: 'workflow_dispatch',
  ref: 'refs/heads/main',
  repository,
  sha,
  runId: '303',
  attempt: '1',
};
const ci = {
  id: 100,
  run_attempt: 1,
  path: '.github/workflows/ci.yml',
  event: 'push',
  head_sha: sha,
  head_branch: 'main',
  repository: repo,
  head_repository: repo,
  status: 'completed',
  conclusion: 'success',
};
const ciJobs = [{ name: 'Build & Check', status: 'completed', conclusion: 'success' }];

test('Android dispatch maps the single enterprise build operation and rejects extras', () => {
  assert.equal(resolveAndroidOperation({}), 'build');
  assert.equal(resolveAndroidOperation({ operation: '仅构建企业 APK' }), 'build');
  assert.equal(ANDROID_OPERATIONS['仅构建企业 APK'], 'build');
  assert.throws(() => resolveAndroidOperation({ operation: '仅构建，不发布' }));
  assert.throws(() => resolveAndroidOperation({ operation: '仅构建企业 APK', build_run: '1' }));
  const selected = validateDispatch(dispatch, { operation: resolveAndroidOperation({ operation: '仅构建企业 APK' }) });
  assert.deepEqual(selected, {
    operation: 'build',
    sourceSha: sha,
    buildRunId: '303',
    buildAttempt: '1',
  });
  for (const change of [{ event: 'pull_request' }, { ref: 'refs/heads/feature' }]) {
    assert.throws(() => validateDispatch({ ...dispatch, ...change }, { operation: 'build' }));
  }
});

test('Android artifact names pin source SHA, run, and attempt', () => {
  assert.equal(artifactName(sha, '303', '1'), `android-enterprise-apk-${sha}-303-1`);
  assert.throws(() => artifactName('MAIN', '303', '1'));
  assert.throws(() => artifactName(sha, '0', '1'));
});

test('Android plan waits only for successful same-source push-main CI', async () => {
  assert.equal(validateCiRun(ci, ciJobs, sha, repository).runId, 100);
  const result = await waitForCi(sha, repository, async () => ({ run: ci, jobs: ciJobs }), {
    timeoutMs: 0,
  });
  assert.equal(result.runId, 100);
  assert.throws(() => validateCiRun({ ...ci, event: 'pull_request' }, ciJobs, sha, repository));
  assert.throws(() => validateCiRun(ci, [{ ...ciJobs[0], conclusion: 'failure' }], sha, repository));
  await assert.rejects(
    () => waitForCi(sha, repository, async () => null, { timeoutMs: 0 }),
    /main CI/,
  );
});

test('Android build environment must be main-only without reviewers', () => {
  assert.equal(ANDROID_ENVIRONMENT, 'mobile-build-android-enterprise');
  assert.equal(ANDROID_WORKFLOW, '.github/workflows/mobile-android-release.yml');
  const protection = validateEnvironment({
    id: 9,
    name: ANDROID_ENVIRONMENT,
    can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [],
  }, {
    environment: ANDROID_ENVIRONMENT,
    actor: 'operator',
    triggeringActor: 'operator',
    branchPolicies: [{ name: 'main', type: 'branch' }],
  });
  assert.equal(protection.authorization, 'workflow_dispatch');
  assert.equal(protection.environment, ANDROID_ENVIRONMENT);
  assert.throws(() => validateEnvironment({
    id: 9,
    name: ANDROID_ENVIRONMENT,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [{ type: 'required_reviewers' }],
  }, {
    environment: ANDROID_ENVIRONMENT,
    actor: 'operator',
    triggeringActor: 'operator',
    branchPolicies: [{ name: 'main', type: 'branch' }],
  }));
  requireSha(sha);
});
