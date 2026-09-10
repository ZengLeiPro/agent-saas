import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  IOS_BUILD_JOB, IOS_WORKFLOW, allocateBuildNumber, artifactName, canonical, digest,
  validateBuildRun, validateCiRun, validateDispatch, validateEnvironment,
} from './ios-actions-policy.mjs';
import { hashFile, readJson, sealBundle, verifyBundle } from './ios-actions-artifacts.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha = 'a'.repeat(40);
const workflowSha = 'b'.repeat(40);
const repository = 'example/ios-release-contract';
const repo = { full_name: repository };
const context = { repository, sourceSha: sha, workflowSha, buildRunId: '101', buildAttempt: '2', buildNumber: '4.101.2', currentRunId: '202' };
const dispatch = { event: 'workflow_dispatch', ref: 'refs/heads/main', repository, sha, runId: '202', attempt: '1' };
const ci = {
  id: 100, run_attempt: 1, path: '.github/workflows/ci.yml', event: 'push',
  head_sha: sha, head_branch: 'main', repository: repo, head_repository: repo,
  status: 'completed', conclusion: 'success',
};
const ciJobs = [{ name: 'Build & Check', status: 'completed', conclusion: 'success' }];
const buildRun = {
  ...ci, id: 101, run_attempt: 2, path: IOS_WORKFLOW, event: 'workflow_dispatch', head_sha: workflowSha,
};
const buildJobs = [{ name: IOS_BUILD_JOB, status: 'completed', conclusion: 'success' }];
const artifact = {
  id: 303, name: artifactName(sha, '101', '2'), expired: false, size_in_bytes: 100,
  digest: `sha256:${'c'.repeat(64)}`, workflow_run: { id: 101 },
};
const protectedEnvironment = {
  id: 7, name: 'mobile-build-production', can_admins_bypass: false,
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  protection_rules: [],
};
const protectionExpected = { environment: 'mobile-build-production', actor: 'author', triggeringActor: 'rerunner', branchPolicies: [{ name: 'main', type: 'branch' }] };
const buildAuthorization = validateEnvironment(protectedEnvironment, protectionExpected);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ios-actions-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'mobile/builds'), { recursive: true });
  const manifest = {
    identity: { iosBundleIdentifier: 'com.example.contract', iosAscAppId: '1234567890', iosAppleTeamId: 'TESTTEAM01', iosAppGroupIdentifier: 'group.com.example.contract' },
    version: { marketingVersion: '1.2.3', iosBuildNumber: 4 },
  };
  writeFileSync(join(directory, 'mobile/release-manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: test-fixture\n');
  const ipa = join(directory, 'mobile/builds/AgentSaaS-1.2.3.ipa');
  // This is deliberately not a signed IPA. These tests validate handoff logic,
  // not native signing, live Apple upload, real-device evidence or store approval.
  writeFileSync(ipa, 'DETERMINISTIC CONTRACT FIXTURE; NOT AN INSTALLABLE IPA');
  writeFileSync(`${ipa}.source.json`, JSON.stringify({
    profile: 'ios-store', sourceGitSha: sha, appId: manifest.identity.iosBundleIdentifier,
    iosTeamId: manifest.identity.iosAppleTeamId, iosAppGroup: manifest.identity.iosAppGroupIdentifier,
    version: '1.2.3', buildNumber: '4.101.2',
  }));
  writeFileSync(`${ipa}.verification.json`, JSON.stringify({ evidenceKind: 'deterministic-contract-fixture' }));
  const record = sealBundle(directory, context, buildAuthorization, { evidenceKind: 'test-fixture' }, { sourceGitSha: sha, runId: 100, attempt: 1 });
  return { directory, ipa, record, recordPath: join(directory, 'mobile/builds/ios-release.json') };
}

test('iOS dispatch defaults to the immutable main workflow SHA and separates operations', () => {
  const build = validateDispatch(dispatch, { operation: 'build' });
  assert.deepEqual(build, { operation: 'build', sourceSha: sha, buildRunId: '202', buildAttempt: '1' });
  assert.equal(validateDispatch(dispatch, { operation: 'build-and-submit' }).operation, 'build-and-submit');
  assert.equal(validateDispatch(dispatch, { operation: 'submit', source_sha: sha, build_run_id: '101', build_run_attempt: '2' }).buildRunId, '101');
  for (const invalid of ['main', 'HEAD', 'a'.repeat(7), `${sha}\n`, '$(echo unsafe)', '-a']) {
    assert.throws(() => validateDispatch(dispatch, { operation: 'build', source_sha: invalid }));
  }
  for (const change of [{ event: 'pull_request' }, { ref: 'refs/heads/feature' }, { ref: 'refs/tags/mobile-v1.0.0' }]) {
    assert.throws(() => validateDispatch({ ...dispatch, ...change }, { operation: 'build' }));
  }
  assert.throws(() => validateDispatch(dispatch, { operation: 'submit', build_run_id: '101', build_run_attempt: '2' }));
  assert.throws(() => validateDispatch(dispatch, { operation: 'submit', source_sha: sha, build_run_id: '202', build_run_attempt: '1' }));
  assert.throws(() => validateDispatch(dispatch, { operation: 'build', build_run_id: '101' }));
  assert.throws(() => validateDispatch(dispatch, { operation: 'unknown' }));
  assert.equal(allocateBuildNumber(4, '202', '1'), '4.202.1');
  assert.throws(() => allocateBuildNumber(4, '../../etc', '1'));
});

test('iOS accepts only successful same-source push-main CI and its authoritative job', () => {
  assert.equal(validateCiRun(ci, ciJobs, sha, repository).runId, 100);
  for (const change of [
    { event: 'pull_request' }, { head_branch: 'feature' }, { head_sha: workflowSha },
    { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' },
    { path: IOS_WORKFLOW }, { head_repository: { full_name: 'fork/repo' } },
  ]) assert.throws(() => validateCiRun({ ...ci, ...change }, ciJobs, sha, repository));
  assert.throws(() => validateCiRun(ci, [], sha, repository));
  assert.throws(() => validateCiRun(ci, [...ciJobs, ...ciJobs], sha, repository));
  assert.throws(() => validateCiRun(ci, [{ ...ciJobs[0], conclusion: 'skipped' }], sha, repository));
});

test('iOS retry reuses a successful build even when its later submit failed', () => {
  const result = validateBuildRun({ ...buildRun, conclusion: 'failure' }, buildJobs, [artifact], context);
  assert.equal(result.artifactId, '303');
  assert.equal(result.workflowSha, workflowSha);
  assert.doesNotThrow(() => validateBuildRun({ ...buildRun, status: 'in_progress', conclusion: null }, buildJobs, [artifact], { ...context, currentRunId: '101' }));
  assert.throws(() => validateBuildRun({ ...buildRun, status: 'in_progress' }, buildJobs, [artifact], context));
});

test('iOS rejects fork, PR, wrong-attempt, expired and failed-build artifacts', () => {
  for (const change of [
    { event: 'pull_request' }, { path: '.github/workflows/ci.yml' }, { head_branch: 'feature' },
    { run_attempt: 1 }, { id: 999 }, { head_repository: { full_name: 'fork/repo' } },
  ]) assert.throws(() => validateBuildRun({ ...buildRun, ...change }, buildJobs, [artifact], context));
  for (const change of [
    { expired: true }, { digest: null }, { size_in_bytes: 0 }, { workflow_run: { id: 999 } },
    { name: artifactName(workflowSha, '101', '2') }, { name: artifactName(sha, '101', '1') },
  ]) assert.throws(() => validateBuildRun(buildRun, buildJobs, [{ ...artifact, ...change }], context));
  assert.throws(() => validateBuildRun(buildRun, [], [artifact], context));
  assert.throws(() => validateBuildRun(buildRun, [{ ...buildJobs[0], conclusion: 'failure' }], [artifact], context));
  assert.throws(() => validateBuildRun(buildRun, buildJobs, [artifact, artifact], context));
  assert.throws(() => artifactName(sha, '../../etc', '1'));
});

test('iOS environments use the dispatch as the sole authorization and allow main only', () => {
  assert.equal(buildAuthorization.authorization, 'workflow_dispatch');
  assert.equal(buildAuthorization.actor, 'author');
  assert.match(buildAuthorization.protectionRulesSha256, /^[0-9a-f]{64}$/u);
  for (const change of [
    { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }] },
    { deployment_branch_policy: null },
    { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } },
  ]) assert.throws(() => validateEnvironment({ ...protectedEnvironment, ...change }, protectionExpected));
  for (const policies of [[], [{ name: '*', type: 'branch' }], [{ name: 'main', type: 'tag' }]]) {
    assert.throws(() => validateEnvironment(protectedEnvironment, { ...protectionExpected, branchPolicies: policies }));
  }
  assert.equal(digest(canonical({ b: 2, a: 1 })), digest(canonical({ a: 1, b: 2 })));
});

test('iOS handoff round-trips and refuses overwrite', (t) => {
  const item = fixture(t);
  assert.equal(verifyBundle(item.directory, context).ipaPath, item.ipa);
  assert.throws(() => sealBundle(item.directory, context, buildAuthorization, {}, { sourceGitSha: sha }), /EEXIST/u);
});

test('iOS handoff detects changes to IPA, source, verification, lockfile and manifest', (t) => {
  for (const path of [
    'mobile/builds/AgentSaaS-1.2.3.ipa', 'mobile/builds/AgentSaaS-1.2.3.ipa.source.json',
    'mobile/builds/AgentSaaS-1.2.3.ipa.verification.json', 'pnpm-lock.yaml', 'mobile/release-manifest.json',
  ]) {
    const item = fixture(t);
    writeFileSync(join(item.directory, path), 'tampered');
    assert.throws(() => verifyBundle(item.directory, context));
  }
});

test('iOS handoff rejects metadata swaps, path traversal and missing dispatch authorization', (t) => {
  const changes = [
    { repository: 'fork/repo' }, { sourceGitSha: workflowSha }, { workflowGitSha: sha },
    { buildRunId: '999' }, { buildRunAttempt: '1' }, { buildNumber: 99 },
    { appId: 'wrong.app' }, { appStoreConnectAppId: '9999999999' },
    { authorization: {} }, { ci: {} }, { files: [{ filename: '../../private.key' }] },
  ];
  for (const change of changes) {
    const item = fixture(t);
    writeFileSync(item.recordPath, JSON.stringify({ ...item.record, ...change }));
    assert.throws(() => verifyBundle(item.directory, context));
  }
});

test('iOS file readers reject symlinks and oversized metadata', (t) => {
  const item = fixture(t);
  rmSync(item.ipa);
  symlinkSync(join(item.directory, 'pnpm-lock.yaml'), item.ipa);
  assert.throws(() => hashFile(item.ipa), /regular file/u);
  assert.throws(() => verifyBundle(item.directory, context));
  writeFileSync(item.recordPath, ' '.repeat(128 * 1024 + 1));
  assert.throws(() => readJson(item.recordPath), /size bound/u);
});

test('iOS workflow keeps PR validation secret-free, uses one dispatch and keeps submission build-free', () => {
  const workflow = readFileSync(join(root, IOS_WORKFLOW), 'utf8');
  const contract = workflow.split('  contract:')[1].split('  plan:')[0];
  const build = workflow.split('  build_ios:')[1].split('  submit_ios:')[0];
  const submit = workflow.split('  submit_ios:')[1];
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run:|--auto-submit|--latest|EXPO_TOKEN|eas build|eas submit/u);
  assert.match(contract, /node --test mobile\/scripts\/ios-actions\.test\.mjs/u);
  assert.doesNotMatch(contract, /secrets\.|EXPO_TOKEN|environment:/u);
  assert.match(build, /environment: mobile-build-production/u);
  assert.match(build, /IOS_DISTRIBUTION_P12_BASE64/u);
  assert.match(build, /build\.sh ios --build/u);
  assert.doesNotMatch(build, /submit-ios\.sh/u);
  assert.match(submit, /environment: mobile-submit-ios-store/u);
  assert.match(submit, /artifact-ids: \$\{\{ steps\.artifact\.outputs\.artifact_id \}\}/u);
  assert.match(submit, /APP_STORE_CONNECT_API_KEY_P8/u);
  assert.match(submit, /submit-ios\.sh/u);
  assert.doesNotMatch(submit, /eas build|build\.sh|expo prebuild/u);
  assert.match(submit, /!cancelled\(\)/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /overwrite: false/u);
  assert.doesNotMatch(workflow, /continue-on-error: true/u);
  const cli = readFileSync(join(root, 'mobile/scripts/ios-actions.mjs'), 'utf8');
  assert.match(cli, /runs\.sort\(\(a, b\) => b\.id - a\.id\)\[0\]/u);
  assert.match(cli, /merge-base', '--is-ancestor'/u);
  assert.match(cli, /verify-mobile-release-artifact\.sh/u);
});

test('iOS native toolchain is explicit and pnpm supports both macOS architectures', () => {
  const eas = readJson(join(root, 'mobile/eas.json'));
  assert.equal(eas.build.production.ios, undefined);
  const checksums = readFileSync(join(root, '.github/pnpm-standalone.sha256'), 'utf8');
  assert.match(checksums, /7cf378c3a55d2aa3734007e4fdce5252291a4f1315966b0a996cffcff6aa2a74\s+pnpm-macos-arm64@10\.18\.3/u);
  assert.match(checksums, /fd9380941b1eac83b6e6a8660e9ca341eb8bc5a294c26d510e356c7bdf51a255\s+pnpm-macos-x64@10\.18\.3/u);
  for (const file of ['build.sh', 'build-ios-native.sh', 'submit-ios.sh', 'setup-ios-runner.sh', 'init-ios-github-release.sh', 'test-ios-native-project.sh']) {
    execFileSync('bash', ['-n', join(root, 'mobile/scripts', file)]);
  }
  const projectCheck = readFileSync(join(root, 'mobile/scripts/test-ios-native-project.sh'), 'utf8');
  assert.doesNotMatch(projectCheck, /' release-manifest\.json\)/u);
  assert.match(projectCheck, /"\$MOBILE_DIR\/release-manifest\.json"/u);
  const initializer = readFileSync(join(root, 'mobile/scripts/init-ios-github-release.sh'), 'utf8');
  assert.match(initializer, /if gh api "repos\/\$REPOSITORY\/environments\/\$environment" >\/dev\/null 2>&1; then/u);
  assert.doesNotMatch(initializer, /deployment-branch-policies[^\n]+\|\| true/u);
});
