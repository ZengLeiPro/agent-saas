#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  IOS_ENVIRONMENTS, artifactName, requireId, requireSha, validateBuildRun,
  validateCiRun, validateDispatch, validateProtection,
} from './ios-actions-policy.mjs';
import { readJson, sealBundle, verifyBundle } from './ios-actions-artifacts.mjs';

const env = process.env;
const repository = env.GITHUB_REPOSITORY;
assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 'GitHub repository context is required');
const base = `https://api.github.com/repos/${repository}`;
const root = resolve(process.argv[3] || '.');
const temporary = env.RUNNER_TEMP;

async function api(path) {
  assert.ok(path.startsWith('/') && !path.includes('..'), 'Invalid GitHub API path');
  assert.ok(env.GH_TOKEN, 'A read-only GitHub token is required');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
      continue;
    }
    throw new Error(`GitHub authorization metadata unavailable: ${path.split('?')[0]} (HTTP ${response.status})`);
  }
  throw new Error('GitHub API retry limit exceeded');
}

async function pages(path, key) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const entries = key ? result[key] : result;
    assert.ok(Array.isArray(entries), `Missing GitHub collection ${key || path}`);
    all.push(...entries);
    if (entries.length < 100) return all;
  }
  throw new Error('GitHub collection exceeded the pagination bound; refusing incomplete authorization');
}

function output(values) {
  assert.ok(env.GITHUB_OUTPUT, 'GitHub output file is required');
  for (const [name, value] of Object.entries(values)) {
    assert.ok(!String(value).includes('\n') && !String(value).includes('\r'), 'Unsafe workflow output');
    appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function summary(text) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function context() {
  return {
    repository,
    sourceSha: requireSha(env.IOS_SOURCE_SHA),
    buildRunId: requireId(env.IOS_BUILD_RUN_ID, 'build run ID'),
    buildAttempt: requireId(env.IOS_BUILD_ATTEMPT, 'build attempt'),
    currentRunId: requireId(env.GITHUB_RUN_ID, 'current run ID'),
    workflowSha: requireSha(env.IOS_BUILD_WORKFLOW_SHA || env.GITHUB_SHA, 'workflow SHA'),
  };
}

function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function assertMainSource(sourceSha, checkCheckout = true) {
  requireSha(sourceSha);
  if (checkCheckout) {
    assert.equal(git(['rev-parse', '--verify', 'HEAD']), sourceSha, 'Checkout does not match release source');
    assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), '', 'Release checkout must be clean');
  }
  git(['merge-base', '--is-ancestor', sourceSha, 'origin/main']);
}

async function authorizeCi(sourceSha) {
  const runs = await pages(`/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${requireSha(sourceSha)}`, 'workflow_runs');
  assert.ok(runs.length > 0, 'No push-main CI run exists for the selected source');
  // Only the latest run/attempt counts. An older green run must not hide a
  // newer failure or an in-progress rerun of the same commit.
  const run = runs.sort((a, b) => b.id - a.id)[0];
  const jobs = await pages(`/actions/runs/${requireId(run.id, 'CI run ID')}/attempts/${requireId(run.run_attempt, 'CI attempt')}/jobs`, 'jobs');
  return validateCiRun(run, jobs, sourceSha, repository);
}

function verifyManifest(sourceSha) {
  const result = execFileSync(process.execPath, [
    'mobile/scripts/verify-release-manifest.mjs', '--profile', 'production',
    '--platform', 'ios', '--git-sha', sourceSha, '--print-artifact-identity',
  ], {
    cwd: root, encoding: 'utf8',
    env: { ...env, GITHUB_SHA: sourceSha, MOBILE_SOURCE_GIT_SHA: sourceSha, MOBILE_BUILD_PLATFORM: 'ios', MOBILE_RELEASE_PROFILE: 'production' },
  });
  return JSON.parse(result);
}

async function plan() {
  const event = readJson(env.GITHUB_EVENT_PATH);
  const selected = validateDispatch({
    event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, repository,
    sha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
  }, event.inputs || {});
  assertMainSource(selected.sourceSha, false);
  const ci = await authorizeCi(selected.sourceSha);
  output({
    source_sha: selected.sourceSha,
    do_build: selected.operation !== 'submit',
    do_submit: selected.operation !== 'build',
    build_run_id: selected.buildRunId,
    build_run_attempt: selected.buildAttempt,
    artifact_name: artifactName(selected.sourceSha, selected.buildRunId, selected.buildAttempt),
  });
  summary(`### iOS release plan\n\nSource: \`${selected.sourceSha}\`\n\nOperation: \`${selected.operation}\` · main CI: ${ci.runId}/${ci.attempt}\n\nBuild run: ${selected.buildRunId}, attempt: ${selected.buildAttempt}\n\nBuild and submit use separate approvals. This workflow does not approve an App Store review or rollout.`);
}

async function guard(stage) {
  assert.ok(IOS_ENVIRONMENTS[stage], 'Unknown release stage');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  const flag = stage === 'build' ? env.MOBILE_RELEASE_CONFIGURED : env.MOBILE_SUBMIT_CONFIGURED;
  assert.equal(flag, 'true', `Configure and enable the protected ${stage} integration first; see docs/mobile-ios-github-actions.md`);
  const current = context();
  assertMainSource(current.sourceSha);
  verifyManifest(current.sourceSha);
  const ci = await authorizeCi(current.sourceSha);
  const environmentName = IOS_ENVIRONMENTS[stage];
  const environment = await api(`/environments/${environmentName}`);
  const branchPolicies = environment.deployment_branch_policy?.custom_branch_policies
    ? await pages(`/environments/${environmentName}/deployment-branch-policies`, 'branch_policies') : [];
  const approvals = await pages(`/actions/runs/${current.currentRunId}/approvals`);
  const protection = validateProtection(environment, approvals, {
    environment: environmentName, branchPolicies,
    actor: env.GITHUB_ACTOR, triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
  });
  assert.ok(temporary, 'Runner temporary directory is required');
  const authorization = {
    ...protection, sourceGitSha: current.sourceSha, ci,
    runId: current.currentRunId, runAttempt: requireId(env.GITHUB_RUN_ATTEMPT, 'current attempt'),
    observedAt: new Date().toISOString(),
  };
  writeFileSync(join(temporary, `ios-${stage}-authorization.json`), `${JSON.stringify(authorization, null, 2)}\n`, { mode: 0o600 });
  summary(`### ${environmentName}\n\nApproved source: \`${current.sourceSha}\`\n\nReviewers: ${protection.reviewers.join(', ')}\n\nProtection digest: \`${protection.protectionRulesSha256}\``);
}

async function resolveArtifact() {
  const current = context();
  const run = await api(`/actions/runs/${current.buildRunId}/attempts/${current.buildAttempt}`);
  const jobs = await pages(`/actions/runs/${current.buildRunId}/attempts/${current.buildAttempt}/jobs`, 'jobs');
  const artifacts = await pages(`/actions/runs/${current.buildRunId}/artifacts`, 'artifacts');
  const authorized = validateBuildRun(run, jobs, artifacts, current);
  // Also require the workflow implementation that built the IPA to remain on
  // main. The source SHA is checked separately; they need not be identical.
  assertMainSource(authorized.workflowSha, false);
  output({ artifact_id: authorized.artifactId, artifact_digest: authorized.artifactDigest, workflow_sha: authorized.workflowSha });
}

function seal() {
  const current = context();
  assertMainSource(current.sourceSha);
  const authorization = readJson(join(temporary, 'ios-build-authorization.json'));
  assert.equal(authorization.sourceGitSha, current.sourceSha);
  assert.equal(authorization.runId, current.currentRunId);
  const toolchain = readJson(join(temporary, 'ios-toolchain.json'));
  const record = sealBundle(root, current, authorization, toolchain, authorization.ci);
  summary(`### Verified IPA saved\n\nSource: \`${record.sourceGitSha}\`\n\nVersion: ${record.version} (${record.buildNumber})\n\nIPA SHA256: \`${record.files[0].sha256}\`\n\nTo submit without rebuilding, select submit with source_sha=${record.sourceGitSha}, build_run_id=${record.buildRunId}, build_run_attempt=${record.buildRunAttempt}.`);
}

function verify() {
  const current = context();
  assertMainSource(current.sourceSha);
  verifyManifest(current.sourceSha);
  const { ipaPath } = verifyBundle(root, current);
  const verified = join(temporary, 'ios-download-verification.json');
  execFileSync('bash', [join(root, 'mobile/scripts/verify-mobile-release-artifact.sh'), 'ios-store', ipaPath, `${ipaPath}.source.json`, verified], { stdio: 'inherit' });
  assert.deepEqual(readFileSync(verified), readFileSync(`${ipaPath}.verification.json`), 'Downloaded IPA signature/identity no longer matches build verification');
  output({ ipa_path: ipaPath });
}

function receipt() {
  const current = context();
  const { record, ipaPath } = verifyBundle(root, current);
  assert.ok(readFileSync(`${ipaPath}.submit.log`).length > 0, 'The successful EAS submit log is missing');
  const approval = readJson(join(temporary, 'ios-submit-authorization.json'));
  assert.equal(approval.sourceGitSha, current.sourceSha);
  assert.equal(approval.runId, current.currentRunId);
  const result = {
    schemaVersion: 1, kind: 'github-ios-submit', status: 'eas-submit-finished',
    repository, sourceGitSha: current.sourceSha, appId: record.appId,
    appStoreConnectAppId: record.appStoreConnectAppId,
    version: record.version, buildNumber: record.buildNumber,
    ipaSha256: record.files[0].sha256,
    buildRunId: current.buildRunId, buildRunAttempt: current.buildAttempt,
    githubArtifactId: requireId(env.IOS_ARTIFACT_ID, 'artifact ID'),
    submitRunId: current.currentRunId, submitRunAttempt: requireId(env.GITHUB_RUN_ATTEMPT, 'submit attempt'),
    approval, completedAt: new Date().toISOString(),
    boundary: 'EAS submission finished. Apple processing, review, availability and M70 rollout are not asserted.',
  };
  const path = join(temporary, 'ios-submit-receipt.json');
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  output({ receipt_path: path });
  summary(`### Submitted to App Store Connect / TestFlight\n\n${record.version} (${record.buildNumber}) · IPA SHA256: \`${result.ipaSha256}\`\n\nThe original IPA was submitted without rebuilding. Apple processing and review remain external. Raw submission logs and credentials are not uploaded as artifacts.`);
}

try {
  switch (process.argv[2]) {
    case 'plan': await plan(); break;
    case 'guard-build': await guard('build'); break;
    case 'guard-submit': await guard('submit'); break;
    case 'resolve-artifact': await resolveArtifact(); break;
    case 'seal': seal(); break;
    case 'verify': verify(); break;
    case 'receipt': receipt(); break;
    default: throw new Error('Expected plan, guard-build, guard-submit, resolve-artifact, seal, verify or receipt');
  }
} catch (error) {
  console.error(`[iOS Actions] ${error.message}`);
  process.exitCode = 1;
}
