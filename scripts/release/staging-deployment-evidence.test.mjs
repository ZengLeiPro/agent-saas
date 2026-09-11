import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  stagingBinding,
  validateStagingDeployment,
  recordPreflightFailure,
} from './staging-deployment-evidence.mjs';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';

const repository = 'owner/agent-saas';
const script = fileURLToPath(new URL('./verify-staging-promotion-evidence.sh', import.meta.url));
const cli = fileURLToPath(new URL('./staging-deployment-evidence.mjs', import.meta.url));
const iso = (t) => new Date(t).toISOString();
function fixture(now = Date.now()) {
  const manifest = {
    releaseId: 'rc-20260910-113',
    releaseSha: 'a'.repeat(40),
    digest: `sha256:${'b'.repeat(64)}`,
    promotionPolicy: { expiresAt: iso(now + 3600000) },
  };
  const entry = (state, operationKey, recordedAt) => ({
    state,
    operationKey,
    recordedAt,
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
  });
  const history = [
    entry('built', 'build:34498045127', iso(now - 1200000)),
    {
      ...entry('staging_deployed', 'staging:34498045127:1', iso(now - 601000)),
      reason: JSON.stringify({
        stagingDeploymentId: '6375802051',
        stagingRunId: '34498045127',
        manifestDigest: manifest.digest,
      }),
    },
    entry('verified', 'deterministic:34498045127:1', iso(now - 600000)),
  ];
  const deployment = {
    id: 6375802051,
    environment: 'staging',
    sha: manifest.releaseSha,
    payload: {
      releaseId: manifest.releaseId,
      manifestDigest: manifest.digest,
      stagingRunId: '34498045127',
    },
  };
  const status = (id, state, at) => ({
    id,
    state,
    environment: 'staging',
    created_at: iso(at),
    deployment_url: `https://api.github.com/repos/${repository}/deployments/${deployment.id}`,
    log_url: '',
  });
  const statusPages = [
    [
      status(3, 'inactive', now - 467000),
      status(2, 'success', now - 582000),
      status(1, 'in_progress', now - 1200000),
    ],
  ];
  const attemptRun = {
    id: 34498045127,
    run_attempt: 1,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_sha: manifest.releaseSha,
    head_branch: 'main',
    event: 'workflow_dispatch',
    path: '.github/workflows/deploy-staging.yml',
    status: 'completed',
    conclusion: 'success',
    run_started_at: iso(now - 1200000),
    updated_at: iso(now - 578000),
  };
  return {
    manifest,
    history,
    deployment,
    statusPages,
    attemptRun,
    latestRun: structuredClone(attemptRun),
    repository,
    now,
  };
}
const check = (value) => validateStagingDeployment(value);
function rejects(value, expected) {
  assert.throws(
    () => check(value),
    (error) => error.details?.check === expected,
    expected,
  );
}

test('RC113 legacy operation keys bind a successful, later inactive deployment', () => {
  const f = fixture();
  assert.equal(stagingBinding(f.manifest, f.history).stagingRunAttempt, '1');
  const result = check(f);
  assert.equal(result.status, 'metadata_verified');
  assert.equal(result.stagingRunAttempt, '1');
  assert.equal(result.deploymentLatestState, 'inactive');
  assert.equal(result.deploymentSuccessStatusId, '2');
  assert.equal(result.inactivityOrigin, 'not-inferred');
  f.statusPages[0].shift();
  assert.equal(check(f).deploymentLatestState, 'success');
});
test('new explicit producer attempt and run log must agree with immutable operation keys', () => {
  const f = fixture();
  f.deployment.payload.stagingRunAttempt = '1';
  const reason = JSON.parse(f.history[1].reason);
  reason.stagingRunAttempt = '1';
  f.history[1].reason = JSON.stringify(reason);
  f.statusPages[0][1].log_url = `https://github.com/${repository}/actions/runs/34498045127/attempts/1`;
  check(f);
  f.statusPages[0][1].log_url = `https://github.com/${repository}/actions/runs/34498045127/attempts/2`;
  rejects(f, 'success_log_binding');
});
for (const state of ['failure', 'error', 'pending', 'queued', 'in_progress', 'success']) {
  test(`success followed by ${state} then inactive cannot reuse old acceptance`, () => {
    const f = fixture();
    f.statusPages[0].splice(1, 0, {
      ...f.statusPages[0][0],
      id: 4,
      state,
      created_at: iso(f.now - 500000),
    });
    rejects(
      f,
      ['failure', 'error', 'pending', 'queued', 'in_progress'].includes(state)
        ? 'post_verification_failure'
        : 'post_success_state',
    );
  });
}
for (const state of ['inactive', 'failure', 'error', 'pending', 'queued', 'in_progress']) {
  test(`${state} without bound success is rejected`, () => {
    const f = fixture();
    f.statusPages = [[{ ...f.statusPages[0][0], state }]];
    rejects(f, 'bound_success');
  });
}
test('a later bare success cannot erase a failure after verified', () => {
  const f = fixture();
  f.statusPages[0].splice(2, 0, {
    ...f.statusPages[0][1],
    id: 4,
    state: 'failure',
    created_at: iso(f.now - 590000),
  });
  rejects(f, 'post_verification_failure');
});
test('only successes within the completed acceptance attempt can qualify', () => {
  for (const offset of [-601000, -200000]) {
    const f = fixture();
    f.statusPages[0][1].created_at = iso(f.now + offset);
    rejects(f, 'bound_success');
  }
});
for (const [field, value, expected] of [
  ['environment', 'production', 'deployment.environment'],
  ['sha', 'c'.repeat(40), 'deployment.sha'],
  ['id', 44, 'deployment.id'],
])
  test(`reject wrong deployment ${field}`, () => {
    const f = fixture();
    f.deployment[field] = value;
    rejects(f, expected);
  });
for (const [field, value, expected] of [
  ['releaseId', 'rc-20260910-112', 'deployment.release'],
  ['manifestDigest', 'wrong', 'deployment.manifest'],
  ['stagingRunId', '1', 'deployment.run'],
  ['stagingRunAttempt', '2', 'deployment.attempt'],
])
  test(`reject wrong deployment payload ${field}`, () => {
    const f = fixture();
    f.deployment.payload[field] = value;
    rejects(f, expected);
  });
for (const [field, value, expected] of [
  ['head_sha', 'c'.repeat(40), 'sha'],
  ['head_branch', 'feature', 'branch'],
  ['event', 'pull_request', 'event'],
  ['path', '.github/workflows/other.yml', 'workflow'],
  ['status', 'in_progress', 'status'],
  ['conclusion', 'failure', 'conclusion'],
  ['run_attempt', 2, 'attempt'],
])
  test(`reject wrong bound/latest run ${field}`, () => {
    for (const name of ['attemptRun', 'latestRun']) {
      const f = fixture();
      f[name][field] = value;
      rejects(f, `${name === 'attemptRun' ? 'bound_run' : 'latest_run'}.${expected}`);
    }
  });
test('cross-repository/fork attempts are not accepted', () => {
  for (const field of ['repository', 'head_repository']) {
    const f = fixture();
    f.attemptRun[field].full_name = 'fork/repo';
    rejects(f, `bound_run.${field}`);
  }
});
test('conflicting or missing immutable attempt cannot silently use the latest run', () => {
  for (const operation of ['deterministic:34498045127:2', 'deterministic:99:1', undefined]) {
    const f = fixture();
    f.history[2].operationKey = operation;
    rejects(f, 'verified_attempt');
  }
  const f = fixture();
  f.history[1].operationKey = 'staging:34498045127';
  rejects(f, 'staging_operation');
});
test('explicit attempt conflict and terminal attestation tails are rejected', () => {
  const f = fixture();
  const reason = JSON.parse(f.history[1].reason);
  reason.stagingRunAttempt = '2';
  f.history[1].reason = JSON.stringify(reason);
  rejects(f, 'reason_attempt');
  for (const state of ['rejected', 'revoked', 'completed']) {
    const g = fixture();
    g.history.push({ ...g.history[2], state });
    rejects(g, 'attestation_tail');
  }
});
test('expired RC is rejected independently of deployment lifecycle state', () => {
  const f = fixture();
  f.manifest.promotionPolicy.expiresAt = iso(f.now - 1);
  rejects(f, 'rc_expiry');
});
test('empty, malformed, duplicate, cross-deployment, future or unknown status histories fail closed', () => {
  for (const pages of [null, {}, [null], [[], []]]) {
    const f = fixture();
    f.statusPages = pages;
    rejects(f, 'status_pagination');
  }
  const f = fixture();
  f.statusPages = [[]];
  rejects(f, 'status_history');
  const g = fixture();
  g.statusPages[0].push(g.statusPages[0][0]);
  rejects(g, 'status_id');
  const h = fixture();
  h.statusPages[0][0].deployment_url += '1';
  rejects(h, 'status_deployment');
  const i = fixture();
  i.statusPages[0][0].state = 'unknown';
  rejects(i, 'status_state');
  const j = fixture();
  j.statusPages[0][0].created_at = iso(j.now + 120000);
  rejects(j, 'status_future');
});
test('status pagination reaches success on page two; truncated page one is not accepted', () => {
  const f = fixture();
  const inactive = f.statusPages[0][0];
  const pages = Array.from({ length: 101 }, (_, i) => ({
    ...inactive,
    id: i + 10,
    created_at: iso(f.now - 467000 + i),
  })).reverse();
  pages.push(...f.statusPages[0].slice(1));
  f.statusPages = [pages.slice(0, 100), pages.slice(100)];
  check(f);
  f.statusPages.pop();
  rejects(f, 'bound_success');
});
test('second-precision timestamps are supported without losing status-id ordering', () => {
  const f = fixture();
  const stamp = iso(Math.floor((f.now - 600000) / 1000) * 1000);
  f.statusPages[0][1].created_at = stamp;
  f.statusPages[0][0].created_at = stamp;
  check(f);
});
test('failure diagnostics persist before any approval or production readback exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'staging-preflight-'));
  try {
    await recordPreflightFailure(root, 'deployment_status_history', null, 124);
    const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
    assert.equal(report.status, 'rejected');
    assert.equal(report.exitCode, 124);
    assert.equal(report.phase, 'before_production_mutation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function files(root, f) {
  await mkdir(root, { recursive: true });
  for (const [name, value] of Object.entries({
    manifest: f.manifest,
    deployment: f.deployment,
    'deployment-statuses': f.statusPages,
    'staging-attempt': f.attemptRun,
    'staging-run': f.latestRun,
  }))
    await writeFile(join(root, `${name}.json`), JSON.stringify(value));
  await writeFile(
    join(root, 'history.jsonl'),
    f.history.map((x) => JSON.stringify(x)).join('\n') + '\n',
  );
  const smoke = {
    schemaVersion: 1,
    status: 'passed',
    environment: 'staging',
    releaseId: f.manifest.releaseId,
    sourceSha: f.manifest.releaseSha,
    manifestDigest: f.manifest.digest,
    stagingRunId: '34498045127',
    stagingRunAttempt: '1',
    actor: 'staging-e2e-admin',
    checks: ['login', 'authenticated-read', 'persistence-read', 'websocket'],
    observedAt: f.history[2].recordedAt,
  };
  await writeFile(
    join(root, 'staging-core-smoke.json'),
    JSON.stringify({ ...smoke, evidenceDigest: digestBuffer(canonicalJson(smoke)) }),
  );
}
test('CLI completion requires the exact, unexpired core-smoke proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'staging-cli-'));
  try {
    const f = fixture();
    await files(root, f);
    const args = [
      cli,
      'complete',
      root,
      join(root, 'manifest.json'),
      join(root, 'history.jsonl'),
      repository,
    ];
    const env = { ...process.env, GITHUB_REPOSITORY: repository };
    assert.equal(spawnSync(process.execPath, args, { env }).status, 0);
    assert.equal(JSON.parse(await readFile(join(root, 'report.json'))).status, 'passed');
    const path = join(root, 'staging-core-smoke.json');
    const smoke = JSON.parse(await readFile(path));
    smoke.stagingRunAttempt = '2';
    await writeFile(path, JSON.stringify(smoke));
    assert.equal(spawnSync(process.execPath, args, { env }).status, 1);
    assert.equal(JSON.parse(await readFile(join(root, 'report.json'))).status, 'rejected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs'); const p = require('node:path');
const root = process.env.GH_FIXTURE; const args = process.argv.slice(2);
fs.appendFileSync(p.join(root, 'calls.txt'), JSON.stringify(args)+'\\n');
const endpoint = args.find(x=>x.startsWith('repos/'));
if (process.env.GH_FAIL && endpoint?.includes(process.env.GH_FAIL)) process.exit(23);
if (args[0]==='run') {
  if (process.env.GH_FAIL === 'download') process.exit(23);
  const out=args[args.indexOf('--dir')+1]; fs.mkdirSync(out,{recursive:true});
  fs.copyFileSync(p.join(root,'staging-core-smoke.json'),p.join(out,'staging-core-smoke.json')); process.exit(0);
}
let name = endpoint?.includes('/statuses?') ? 'deployment-statuses' : endpoint?.includes('/deployments/') ? 'deployment' : endpoint?.includes('/attempts/') ? 'staging-attempt' : 'staging-run';
let value=JSON.parse(fs.readFileSync(p.join(root,name+'.json')));
if (process.env.GH_RERUN && name==='staging-run') {
  const counter=p.join(root,'reads'); const count=fs.existsSync(counter)?Number(fs.readFileSync(counter)):0; fs.writeFileSync(counter,String(count+1)); if(count) value.run_attempt=2;
}
process.stdout.write(JSON.stringify(value));
`;
for (const mode of ['success', 'pagination-failure', 'download-failure', 'rerun-during-download']) {
  test(`real shell/validator orchestration: ${mode}`, async (t) => {
    if (spawnSync('jq', ['--version']).status !== 0)
      return t.skip('jq is required for the workflow shell integration');
    const root = await mkdtemp(join(tmpdir(), 'staging-shell-'));
    try {
      const f = fixture();
      await files(root, f);
      await mkdir(join(root, 'bin'));
      await writeFile(join(root, 'bin', 'gh'), fakeGh, { mode: 0o755 });
      const env = {
        ...process.env,
        GITHUB_REPOSITORY: repository,
        GH_FIXTURE: root,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      };
      if (mode === 'pagination-failure') env.GH_FAIL = '/statuses?';
      if (mode === 'download-failure') env.GH_FAIL = 'download';
      if (mode === 'rerun-during-download') env.GH_RERUN = '1';
      const out = join(root, 'diagnostics');
      const result = spawnSync(
        'bash',
        [script, join(root, 'manifest.json'), join(root, 'history.jsonl'), out],
        { env, encoding: 'utf8', timeout: 15000 },
      );
      assert.equal(
        result.status,
        mode === 'success' ? 0 : mode.endsWith('failure') ? 23 : 1,
        result.stderr + result.stdout,
      );
      const report = JSON.parse(await readFile(join(out, 'report.json')));
      assert.equal(report.status, mode === 'success' ? 'passed' : 'rejected');
      const calls = (await readFile(join(root, 'calls.txt'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.ok(calls.every((args) => !args.includes('POST') && !args.includes('--method')));
      if (mode === 'success') {
        assert.ok(
          calls.some((args) =>
            args.includes('repos/owner/agent-saas/actions/runs/34498045127/attempts/1'),
          ),
        );
        assert.ok(calls.some((args) => args.includes('staging-evidence-rc-20260910-113-1')));
        assert.equal(calls.filter((args) => args.some((x) => x.includes('/statuses?'))).length, 2);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
test('shell is syntactically valid', () => {
  execFileSync('bash', ['-n', script]);
});
