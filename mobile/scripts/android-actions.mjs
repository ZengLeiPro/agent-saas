#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  requireId, requireSha, validateDispatch, validateEnvironment,
} from './ios-actions-policy.mjs';
import { waitForCi } from './ios-release-inputs.mjs';

export const ANDROID_WORKFLOW = '.github/workflows/mobile-android-release.yml';
export const ANDROID_BUILD_JOB = 'Android / 企业 APK 签名构建';
export const ANDROID_ENVIRONMENT = 'mobile-build-android-enterprise';
export const ANDROID_OPERATIONS = Object.freeze({
  '仅构建企业 APK': 'build',
});
export const DEFAULT_ANDROID_OPERATION = '仅构建企业 APK';

export function artifactName(sourceSha, runId, attempt) {
  return `android-enterprise-apk-${requireSha(sourceSha)}-${requireId(runId, 'run ID')}-${requireId(attempt, 'attempt')}`;
}

export function resolveAndroidOperation(inputs = {}) {
  assert.ok(inputs && typeof inputs === 'object' && !Array.isArray(inputs), '无效的发布参数');
  for (const key of Object.keys(inputs)) {
    assert.ok(key === 'operation', `不再支持发布参数 ${key}`);
  }
  const label = inputs.operation ?? DEFAULT_ANDROID_OPERATION;
  assert.ok(Object.hasOwn(ANDROID_OPERATIONS, label), '未知的 Android 执行操作');
  return ANDROID_OPERATIONS[label];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function runCli(command, checkoutRoot = '.') {
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY;
  assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 'GitHub repository context is required');
  const base = `https://api.github.com/repos/${repository}`;
  const root = resolve(checkoutRoot);
  const temporary = env.RUNNER_TEMP;

  async function api(path) {
    assert.ok(path.startsWith('/') && !path.includes('..'), 'Invalid GitHub API path');
    assert.ok(env.GH_TOKEN, 'A read-only GitHub token is required');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${base}${path}`, {
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
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

  async function loadCi(sourceSha) {
    const runs = await pages(
      `/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${requireSha(sourceSha)}`,
      'workflow_runs',
    );
    if (!runs.length) return null;
    const run = runs.sort((a, b) => b.id - a.id)[0];
    const jobs = run.status === 'completed' && run.conclusion === 'success'
      ? await pages(
        `/actions/runs/${requireId(run.id, 'CI run ID')}/attempts/${requireId(run.run_attempt, 'CI attempt')}/jobs`,
        'jobs',
      )
      : [];
    const refreshed = await api(`/actions/runs/${requireId(run.id, 'CI run ID')}`);
    if (
      refreshed.run_attempt !== run.run_attempt
      || refreshed.status !== run.status
      || refreshed.conclusion !== run.conclusion
    ) {
      return {
        run: {
          ...refreshed,
          status: refreshed.status === 'completed' && refreshed.conclusion === 'success'
            ? 'in_progress'
            : refreshed.status,
        },
        jobs: [],
      };
    }
    return { run: refreshed, jobs };
  }

  async function authorizeCi(sourceSha, wait = false) {
    return waitForCi(sourceSha, repository, loadCi, {
      ...(wait ? {} : { timeoutMs: 0 }),
      progress: (sha, run) => console.log(
        `[Android Actions] 等待固定源码 ${sha} 的 CI：${run ? `${run.id}/${run.run_attempt} ${run.status}` : '尚未创建'}`,
      ),
    });
  }

  function verifyManifest(sourceSha) {
    const printed = execFileSync(process.execPath, [
      'mobile/scripts/verify-release-manifest.mjs',
      '--profile', 'production',
      '--platform', 'android',
      '--distribution', 'enterprise',
      '--git-sha', sourceSha,
      '--print-build-values',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...env,
        GITHUB_SHA: sourceSha,
        MOBILE_SOURCE_GIT_SHA: sourceSha,
        MOBILE_BUILD_PLATFORM: 'android',
        MOBILE_ANDROID_DISTRIBUTION: 'enterprise',
        MOBILE_RELEASE_PROFILE: 'production',
      },
    }).trim();
    const [marketingVersion, androidVersionCode] = printed.split('|');
    assert.ok(marketingVersion, 'marketingVersion missing from release manifest');
    assert.match(androidVersionCode ?? '', /^[1-9][0-9]*$/u, 'androidVersionCode must be a positive integer');
    return { marketingVersion, androidVersionCode };
  }

  async function plan() {
    const event = readJson(env.GITHUB_EVENT_PATH);
    const operation = resolveAndroidOperation(event.inputs || {});
    const selected = validateDispatch({
      event: env.GITHUB_EVENT_NAME,
      ref: env.GITHUB_REF,
      repository,
      sha: env.GITHUB_SHA,
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
    }, { operation });
    assertMainSource(selected.sourceSha, false);
    const ci = await authorizeCi(selected.sourceSha, true);
    const { androidVersionCode } = verifyManifest(selected.sourceSha);
    output({
      source_sha: selected.sourceSha,
      do_build: 'true',
      artifact_name: artifactName(selected.sourceSha, selected.buildRunId, selected.buildAttempt),
      version_code: androidVersionCode,
    });
    summary(
      `### Android enterprise APK plan\n\nSource: \`${selected.sourceSha}\`\n\n`
      + `Operation: \`仅构建企业 APK\` · main CI: ${ci.runId}/${ci.attempt}\n\n`
      + `versionCode: ${androidVersionCode}\n\n`
      + 'Signed dispatch requires Environment secrets after merge; PR contract never uses them.',
    );
  }

  async function guardBuild() {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(env.GITHUB_REF, 'refs/heads/main');
    const sourceSha = requireSha(env.ANDROID_SOURCE_SHA);
    assertMainSource(sourceSha);
    verifyManifest(sourceSha);
    const ci = await authorizeCi(sourceSha);
    const environment = await api(`/environments/${ANDROID_ENVIRONMENT}`);
    const branchPolicies = environment.deployment_branch_policy?.custom_branch_policies
      ? await pages(`/environments/${ANDROID_ENVIRONMENT}/deployment-branch-policies`, 'branch_policies')
      : [];
    const protection = validateEnvironment(environment, {
      environment: ANDROID_ENVIRONMENT,
      branchPolicies,
      actor: env.GITHUB_ACTOR,
      triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
    });
    assert.ok(temporary, 'Runner temporary directory is required');
    const authorization = {
      ...protection,
      sourceGitSha: sourceSha,
      ci,
      runId: requireId(env.GITHUB_RUN_ID, 'current run ID'),
      runAttempt: requireId(env.GITHUB_RUN_ATTEMPT, 'current attempt'),
      observedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(temporary, 'android-build-authorization.json'),
      `${JSON.stringify(authorization, null, 2)}\n`,
      { mode: 0o600 },
    );
    summary(
      `### ${ANDROID_ENVIRONMENT}\n\nAuthorized source: \`${sourceSha}\`\n\n`
      + `Trigger: ${protection.authorization} by ${protection.actor}\n\n`
      + `Protection digest: \`${protection.protectionRulesSha256}\``,
    );
  }

  switch (command) {
    case 'plan':
      await plan();
      break;
    case 'guard-build':
      await guardBuild();
      break;
    default:
      throw new Error('Expected plan or guard-build');
  }
}

const isMain = Boolean(process.argv[1])
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    await runCli(process.argv[2], process.argv[3] || '.');
  } catch (error) {
    console.error(`[Android Actions] ${error.message}`);
    process.exitCode = 1;
  }
}
