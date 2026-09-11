import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { IOS_BUILD_JOB, IOS_WORKFLOW, artifactName } from './ios-actions-policy.mjs';
import {
  DEFAULT_RELEASE_OPERATION, RELEASE_OPERATIONS, assertPinnedArtifact,
  parseBuildRunReference, resolveReleaseInputs, waitForCi,
} from './ios-release-inputs.mjs';

const repository = 'example/ios-release-contract';
const repo = { full_name: repository };
const sourceSha = 'a'.repeat(40);
const workflowSha = 'b'.repeat(40);
const dispatchSha = 'd'.repeat(40);
const context = { repository, event: 'workflow_dispatch', ref: 'refs/heads/main', sha: dispatchSha, runId: '202', attempt: '1' };
const retry = { operation: '重试已有构建的发布', build_run: '101' };
const run = { id: 101, run_attempt: 3, path: IOS_WORKFLOW, event: 'workflow_dispatch', head_branch: 'main', head_sha: workflowSha, repository: repo, head_repository: repo, status: 'completed', conclusion: 'failure' };
const job = { name: IOS_BUILD_JOB, run_id: 101, run_attempt: 1, status: 'completed', conclusion: 'success' };
const artifact = { id: 303, name: artifactName(sourceSha, '101', '1'), expired: false, size_in_bytes: 100, digest: `sha256:${'c'.repeat(64)}`, workflow_run: { id: 101, head_sha: workflowSha } };
const ci = { ...run, id: 100, run_attempt: 1, path: '.github/workflows/ci.yml', event: 'push', head_sha: sourceSha, conclusion: 'success' };
const ciJobs = [{ name: 'Build & Check', status: 'completed', conclusion: 'success' }];

function backend(options = {}) {
  const calls = [];
  let reads = 0;
  const current = options.run ?? run;
  return {
    calls,
    api: async (path) => {
      calls.push(path);
      if (path === '/actions/runs/101') return reads++ && options.refreshed ? options.refreshed : current;
      const match = /^\/actions\/runs\/101\/attempts\/(\d+)$/u.exec(path);
      assert.ok(match, `Unexpected metadata request: ${path}`);
      return options.original ?? { ...current, run_attempt: Number(match[1]) };
    },
    pages: async (path, key) => {
      calls.push(path);
      if (path === '/actions/runs/101/artifacts') {
        assert.equal(key, 'artifacts');
        return options.artifacts ?? [artifact];
      }
      const match = /^\/actions\/runs\/101\/attempts\/(\d+)\/jobs$/u.exec(path);
      assert.ok(match, `Unexpected collection request: ${path}`);
      assert.equal(key, 'jobs');
      return options.jobs ?? [{ ...job, run_attempt: Number(match[1]) }];
    },
  };
}

for (const value of ['101', ' 101 ', `https://github.com/${repository}/actions/runs/101`, `https://github.com/${repository}/actions/runs/101/job/900?pr=643#step:7:1`]) {
  test(`run reference accepts ${value}`, () => assert.equal(parseBuildRunReference(value, repository), '101'));
}
for (const value of ['', '0', '01', '-1', '1e2', '9007199254740992', '$(echo 101)', '101\n102',
  `https://github.com/other/repo/actions/runs/101`, `http://github.com/${repository}/actions/runs/101`,
  `https://github.com.evil/${repository}/actions/runs/101`, `https://github.com@evil/${repository}/actions/runs/101`,
  `https://github.com/${repository}/actions/runs/101/../../202`, `https://github.com/${repository}/actions/runs/101/attempts/3`,
  `https://github.com/${repository}/actions/runs/101\nmalformed`]) {
  test(`run reference rejects ${JSON.stringify(value)}`, () => assert.throws(() => parseBuildRunReference(value, repository)));
}

test('default and build-only use the dispatch SHA without reading any old run', async () => {
  const noNetwork = { api: () => assert.fail('unexpected API call'), pages: () => assert.fail('unexpected API call') };
  for (const [label, operation] of Object.entries(RELEASE_OPERATIONS).filter(([, value]) => value !== 'testflight')) {
    assert.deepEqual(await resolveReleaseInputs(context, { operation: label, build_run: '' }, noNetwork), { operation, sourceSha: dispatchSha, buildRunId: '202', buildAttempt: '1' });
  }
  assert.equal((await resolveReleaseInputs(context, {}, noNetwork)).operation, 'build-and-testflight');
});

for (const inputs of [
  { operation: 'unknown' }, { operation: 'build' }, { build_run: '101' }, { operation: '仅构建，不发布', build_run: '101' },
  { operation: retry.operation }, { ...retry, build_run: '202' }, { build_run: 101 },
  { source_sha: sourceSha }, { build_run_id: '101' }, { build_run_attempt: '1' },
]) {
  test(`invalid/removed UI inputs fail before API: ${JSON.stringify(inputs)}`, async () => {
    const deps = backend();
    await assert.rejects(resolveReleaseInputs(context, inputs, deps));
    assert.equal(deps.calls.length, 0);
  });
}
for (const change of [{ event: 'pull_request' }, { ref: 'refs/heads/feature' }, { ref: 'refs/tags/v1' }]) {
  test(`retry refuses non-main dispatch ${JSON.stringify(change)}`, async () => {
    const deps = backend();
    await assert.rejects(resolveReleaseInputs({ ...context, ...change }, retry, deps));
    assert.equal(deps.calls.length, 0);
  });
}

test('retry resolves producing attempt 1 even when latest attempt is 3, and source differs from workflow/main', async () => {
  const deps = backend();
  assert.deepEqual(await resolveReleaseInputs(context, retry, deps), { operation: 'testflight', sourceSha, buildRunId: '101', buildAttempt: '1', artifactId: '303', artifactDigest: artifact.digest, workflowSha });
  assert.ok(deps.calls.includes('/actions/runs/101/attempts/1/jobs'));
  assert.ok(!deps.calls.includes('/actions/runs/101/attempts/3/jobs'));
});

for (const change of [{ event: 'pull_request' }, { path: '.github/workflows/ci.yml' }, { head_branch: 'feature' }, { status: 'in_progress' }, { head_repository: { full_name: 'fork/repo' } }, { repository: { full_name: 'fork/repo' } }, { id: 999 }]) {
  test(`retry rejects untrusted run ${JSON.stringify(change)}`, async () => {
    await assert.rejects(resolveReleaseInputs(context, retry, backend({ run: { ...run, ...change } })));
  });
}
for (const [name, options] of [
  ['missing IPA', { artifacts: [] }],
  ['expired IPA', { artifacts: [{ ...artifact, expired: true }] }],
  ['missing expiry state', { artifacts: [{ ...artifact, expired: undefined }] }],
  ['malformed name', { artifacts: [{ ...artifact, name: 'ios-ipa-malformed' }] }],
  ['wrong name run ID', { artifacts: [{ ...artifact, name: artifactName(sourceSha, '999', '1') }] }],
  ['future attempt', { artifacts: [{ ...artifact, name: artifactName(sourceSha, '101', '4') }] }],
  ['wrong artifact run', { artifacts: [{ ...artifact, workflow_run: { id: 999, head_sha: workflowSha } }] }],
  ['wrong artifact workflow', { artifacts: [{ ...artifact, workflow_run: { id: 101, head_sha: dispatchSha } }] }],
  ['missing digest', { artifacts: [{ ...artifact, digest: null }] }],
  ['empty artifact', { artifacts: [{ ...artifact, size_in_bytes: 0 }] }],
  ['duplicate artifact', { artifacts: [artifact, artifact] }],
  ['multiple successful attempts', { artifacts: [artifact, { ...artifact, id: 304, name: artifactName(sourceSha, '101', '2') }] }],
  ['failed build', { jobs: [{ ...job, conclusion: 'failure' }] }],
  ['skipped build', { jobs: [{ ...job, conclusion: 'skipped' }] }],
  ['missing build', { jobs: [] }],
  ['duplicate build', { jobs: [job, job] }],
  ['wrong job run', { jobs: [{ ...job, run_id: 999 }] }],
  ['inherited job', { jobs: [{ ...job, run_attempt: 2 }] }],
  ['wrong attempt response', { original: { ...run, run_attempt: 2 } }],
  ['workflow SHA changed', { original: { ...run, run_attempt: 1, head_sha: dispatchSha } }],
  ['rerun began during resolution', { refreshed: { ...run, status: 'in_progress', run_attempt: 4 } }],
]) {
  test(`retry fails closed: ${name}`, async () => {
    await assert.rejects(resolveReleaseInputs(context, retry, backend(options)));
  });
}

test('unrelated artifacts and expired attempts do not replace the unique verified IPA', async () => {
  const deps = backend({ artifacts: [{ id: 999, name: 'ios-testflight-receipt' }, { ...artifact, id: 304, expired: true, name: artifactName(sourceSha, '101', '2') }, artifact] });
  assert.equal((await resolveReleaseInputs(context, retry, deps)).artifactId, '303');
});

test('failed newer build cannot hide the earlier successful producing attempt', async () => {
  const deps = backend({ artifacts: [artifact, { ...artifact, id: 304, name: artifactName(sourceSha, '101', '2') }] });
  const pages = deps.pages;
  deps.pages = async (path, key) => path.endsWith('/attempts/2/jobs') ? [{ ...job, run_attempt: 2, conclusion: 'failure' }] : pages(path, key);
  assert.equal((await resolveReleaseInputs(context, retry, deps)).buildAttempt, '1');
});

test('retry pins artifact ID, digest and workflow SHA across jobs', () => {
  const pinned = { artifactId: '303', artifactDigest: artifact.digest, workflowSha };
  assert.doesNotThrow(() => assertPinnedArtifact(pinned, pinned));
  assert.doesNotThrow(() => assertPinnedArtifact(pinned, {}));
  for (const field of Object.keys(pinned)) {
    assert.throws(() => assertPinnedArtifact({ ...pinned, [field]: 'changed' }, pinned));
    assert.throws(() => assertPinnedArtifact(pinned, { ...pinned, [field]: '' }));
  }
});

function fakeClock() {
  let time = 0;
  return { now: () => time, pause: async (ms) => { time += ms; }, timeoutMs: 100, intervalMs: 10 };
}

test('CI waits through absent, queued, running and a newer attempt without changing SHA', async () => {
  const states = [null, { run: { ...ci, status: 'queued' }, jobs: [] }, { run: { ...ci, status: 'in_progress', run_attempt: 2 }, jobs: [] }, { run: { ...ci, run_attempt: 2 }, jobs: ciJobs }];
  const seen = [];
  const result = await waitForCi(sourceSha, repository, async (sha) => { seen.push(sha); return states.shift(); }, fakeClock());
  assert.equal(result.attempt, 2);
  assert.deepEqual(seen, [sourceSha, sourceSha, sourceSha, sourceSha]);
});
for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'skipped', 'neutral']) {
  test(`completed CI ${conclusion} fails immediately rather than waiting or falling back`, async () => {
    let calls = 0;
    await assert.rejects(waitForCi(sourceSha, repository, async () => { calls++; return { run: { ...ci, conclusion }, jobs: ciJobs }; }, fakeClock()));
    assert.equal(calls, 1);
  });
}
for (const snapshot of [null, { run: { ...ci, status: 'in_progress' }, jobs: [] }]) {
  test(`CI waiting is bounded with ${snapshot ? 'running CI' : 'no CI'}`, async () => {
    const clock = fakeClock();
    await assert.rejects(waitForCi(sourceSha, repository, async () => snapshot, clock), /超时/u);
    assert.equal(clock.now(), 100);
  });
}
for (const change of [{ head_sha: dispatchSha }, { event: 'pull_request' }, { head_branch: 'feature' }, { path: IOS_WORKFLOW }, { head_repository: { full_name: 'fork/repo' } }]) {
  test(`CI validates pending provenance ${JSON.stringify(change)}`, async () => {
    await assert.rejects(waitForCi(sourceSha, repository, async () => ({ run: { ...ci, status: 'in_progress', ...change }, jobs: [] }), fakeClock()));
  });
}

test('green CI still requires exactly one successful Build & Check job', async () => {
  for (const jobs of [[], [...ciJobs, ...ciJobs], [{ ...ciJobs[0], conclusion: 'skipped' }]]) {
    await assert.rejects(waitForCi(sourceSha, repository, async () => ({ run: ci, jobs }), fakeClock()));
  }
});

// Execute the actual CLI, real Git ancestry checks, JSON files, pagination,
// workflow outputs and artifact re-resolution. Only HTTPS is intercepted;
// unmatched requests fail rather than contacting GitHub/Apple.
function cliFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ios-release-ui-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  mkdirSync(join(root, 'mobile'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'mobile/release-manifest.json'), JSON.stringify({ version: { iosBuildNumber: 6 } }));
  git('add', '.'); git('commit', '-qm', 'original app');
  const source = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-qm', 'original workflow');
  const workflow = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-qm', 'new dispatch');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const preload = join(directory, 'fetch.mjs');
  writeFileSync(preload, `import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
const routes = JSON.parse(readFileSync(process.env.TEST_ROUTES));
globalThis.fetch = async (url, options) => {
  assert.equal(options.method ?? 'GET', 'GET');
  const path = String(url).replace('https://api.github.com/repos/${repository}', '');
  appendFileSync(process.env.TEST_CALLS, path + '\\n');
  assert.ok(Object.hasOwn(routes, path), 'Unexpected API request: ' + path);
  return { ok: true, json: async () => routes[path] };
};`);
  const currentRun = { ...run, head_sha: workflow };
  const originalArtifact = { ...artifact, name: artifactName(source, '101', '1'), workflow_run: { id: 101, head_sha: workflow } };
  const ciFor = (head) => ({ ...ci, head_sha: head });
  const routes = {
    '/actions/runs/101': currentRun,
    '/actions/runs/101/attempts/1': { ...currentRun, run_attempt: 1 },
    '/actions/runs/101/attempts/1/jobs?per_page=100&page=1': { jobs: [job] },
    '/actions/runs/101/artifacts?per_page=100&page=1': { artifacts: [originalArtifact] },
    [`/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${source}&per_page=100&page=1`]: { workflow_runs: [ciFor(source)] },
    [`/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100&page=1`]: { workflow_runs: [ciFor(sha)] },
    '/actions/runs/100/attempts/1/jobs?per_page=100&page=1': { jobs: ciJobs },
  };
  return { directory, root, source, workflow, sha, routes, originalArtifact, execute(inputs, command = 'plan', extraEnv = {}) {
    routes['/actions/runs/100'] ??= ciFor(inputs.operation === retry.operation ? source : sha);
    const event = join(directory, 'event.json'); const output = join(directory, 'output'); const calls = join(directory, 'calls');
    writeFileSync(event, JSON.stringify({ inputs })); writeFileSync(output, ''); writeFileSync(calls, '');
    writeFileSync(join(directory, 'routes.json'), JSON.stringify(routes));
    const result = spawnSync(process.execPath, ['--import', preload, resolve(import.meta.dirname, 'ios-actions.mjs'), command, root], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha, GITHUB_RUN_ID: '202', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(directory, 'summary'), RUNNER_TEMP: directory, GH_TOKEN: 'synthetic-read-only', TEST_ROUTES: join(directory, 'routes.json'), TEST_CALLS: calls, ...extraEnv },
    });
    assert.ifError(result.error);
    const rawOutput = readFileSync(output, 'utf8');
    return { ...result, rawOutput, values: Object.fromEntries(rawOutput.trim().split('\n').filter(Boolean).map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; })), calls: readFileSync(calls, 'utf8') };
  } };
}

test('actual CLI default plan binds dispatch SHA and only constructs a new build', (t) => {
  const f = cliFixture(t); const result = f.execute({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.values.source_sha, f.sha);
  assert.equal(result.values.do_build, 'true');
  assert.equal(result.values.do_testflight, 'true');
  assert.equal(result.values.build_run_attempt, '1');
  assert.equal(result.values.retry_artifact_id, '');
  assert.doesNotMatch(result.calls, /\/runs\/101/u);
});

test('actual CLI retry paginates artifacts, retains original SHA and producing attempt, and pins ID', (t) => {
  const f = cliFixture(t);
  f.routes['/actions/runs/101/artifacts?per_page=100&page=1'] = { artifacts: Array.from({ length: 100 }, (_, n) => ({ name: `receipt-${n}` })) };
  f.routes['/actions/runs/101/artifacts?per_page=100&page=2'] = { artifacts: [f.originalArtifact] };
  const result = f.execute({ ...retry, build_run: `https://github.com/${repository}/actions/runs/101` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.values.source_sha, f.source);
  assert.equal(result.values.build_run_attempt, '1');
  assert.equal(result.values.do_build, 'false');
  assert.equal(result.values.do_testflight, 'true');
  assert.equal(result.values.retry_artifact_id, '303');
  assert.equal(result.values.retry_artifact_digest, artifact.digest);
  assert.equal(result.values.retry_workflow_sha, f.workflow);
  assert.match(result.calls, /artifacts\?per_page=100&page=2/u);
  assert.doesNotMatch(result.calls, /attempts\/3\/jobs/u);
});

test('actual CLI latest failed CI wins over older green CI and produces no plan', (t) => {
  const f = cliFixture(t);
  const newer = { ...ci, id: 102, head_sha: f.sha, conclusion: 'failure' };
  f.routes[`/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${f.sha}&per_page=100&page=1`].workflow_runs.push(newer);
  f.routes['/actions/runs/102'] = newer;
  const result = f.execute({});
  assert.notEqual(result.status, 0);
  assert.equal(result.rawOutput, '');
  assert.match(result.stderr, /latest CI run/u);
});

test('actual CLI refuses API-supplied removed inputs before requesting metadata', (t) => {
  const f = cliFixture(t); const result = f.execute({ source_sha: f.source });
  assert.notEqual(result.status, 0);
  assert.equal(result.rawOutput, '');
  assert.equal(result.calls, '');
});

test('actual resolve-artifact detects a replaced ID before download even if name still matches', (t) => {
  const f = cliFixture(t);
  const extra = { IOS_SOURCE_SHA: f.source, IOS_BUILD_RUN_ID: '101', IOS_BUILD_ATTEMPT: '1', IOS_EXPECTED_ARTIFACT_ID: '303', IOS_EXPECTED_ARTIFACT_DIGEST: artifact.digest, IOS_EXPECTED_WORKFLOW_SHA: f.workflow };
  assert.equal(f.execute(retry, 'resolve-artifact', extra).status, 0);
  f.routes['/actions/runs/101/artifacts?per_page=100&page=1'].artifacts[0] = { ...f.originalArtifact, id: 999 };
  const result = f.execute(retry, 'resolve-artifact', extra);
  assert.notEqual(result.status, 0);
  assert.equal(result.rawOutput, '');
  assert.match(result.stderr, /制品 ID/u);
});

test('workflow exposes only two localized inputs and keeps publication isolated', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/mobile-ios-release.yml'), 'utf8');
  const form = workflow.split('  workflow_dispatch:')[1].split('\npermissions:')[0];
  assert.deepEqual([...form.matchAll(/^      ([a-z_]+):$/gmu)].map((match) => match[1]), ['operation', 'build_run']);
  for (const label of Object.keys(RELEASE_OPERATIONS)) assert.ok(form.includes(label));
  assert.ok(form.includes(`default: '${DEFAULT_RELEASE_OPERATION}'`));
  assert.doesNotMatch(workflow, /inputs\.(?:source_sha|build_run_id|build_run_attempt)/u);
  assert.match(workflow, /node --test mobile\/scripts\/ios-release-inputs\.test\.mjs/u);
  assert.match(workflow.split('  plan:')[1].split('  build_ios:')[0], /timeout-minutes: 25/u);
  const publish = workflow.split('  publish_testflight:')[1];
  assert.match(publish, /IOS_EXPECTED_ARTIFACT_ID/u);
  assert.match(publish, /IOS_EXPECTED_ARTIFACT_DIGEST/u);
  assert.match(publish, /IOS_EXPECTED_WORKFLOW_SHA/u);
  assert.doesNotMatch(publish, /build\.sh|expo prebuild/u);
  assert.doesNotMatch(workflow, /continue-on-error: true/u);
});
