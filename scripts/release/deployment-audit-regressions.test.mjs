import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { retryDeployment } from './staging-deployment-retry.mjs';
import { assertLatestStagingAttempt } from './assert-staging-acceptance-deployment.mjs';
import { verifyPublicWeb } from './verify-public-web.mjs';
import { summarizeStagingState } from './staging-final-state.mjs';
import { assertDatabaseEvidence, selectPostconditions } from './migration-postconditions.mjs';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';

const release = 'rc-20260907-01';
const digest = `sha256:${'a'.repeat(64)}`;
const entry = (state) => ({
  state,
  releaseId: release,
  manifestDigest: digest,
  reason: JSON.stringify({
    manifestDigest: digest,
    stagingRunId: '123',
    stagingDeploymentId: '456',
  }),
});

test('D-02: failures after built, deployed and verified retain a recoverable deployment binding', () => {
  assert.equal(retryDeployment([entry('built')], release, digest, '123'), '');
  for (const history of [
    [entry('built'), entry('staging_deployed')],
    [entry('built'), entry('staging_deployed'), entry('verified')],
  ]) {
    assert.equal(retryDeployment(history, release, digest, '123'), '456');
    assert.throws(() => retryDeployment(history, release, digest, '124'), /same run/);
    assert.throws(() => retryDeployment(history, release, 'different', '123'), /binding mismatch/);
  }
  assert.throws(
    () => retryDeployment([entry('promoting')], release, digest, '123'),
    /after promotion/,
  );
});

test('D-04: the latest attempt, including a retry of an older deployment ID, gates acceptance', () => {
  const deployment = (id) => ({ id, environment: 'staging', payload: { releaseId: release } });
  const status = (id, state) => ({ id, state, created_at: `2026-09-07T00:00:0${id}Z` });
  const history = [
    { deployment: deployment(1), statuses: [status(1, 'success'), status(4, 'success')] },
    { deployment: deployment(2), statuses: [status(2, 'failure')] },
  ];
  assert.equal(assertLatestStagingAttempt(history, release).deploymentId, 1);
  history[1].statuses.push(status(5, 'in_progress'));
  assert.throws(() => assertLatestStagingAttempt(history, release), /incomplete/);
  history[1].statuses.push(status(6, 'failure'));
  assert.throws(() => assertLatestStagingAttempt(history, release), /incomplete/);
  assert.throws(
    () =>
      assertLatestStagingAttempt(
        [{ deployment: deployment(1), statuses: [status(1, 'success'), status(7, 'inactive')] }],
        release,
      ),
    /incomplete/,
  );
  assert.throws(
    () => assertLatestStagingAttempt([{ deployment: deployment(1), statuses: [] }], release),
    /no status/,
  );
});

const deploy = readFileSync(new URL('./deploy-production-release.sh', import.meta.url), 'utf8');
const handoff = deploy.slice(
  deploy.indexOf('hand_off_retired_authority() {'),
  deploy.indexOf('\ndeploy_app() {'),
);
for (const scenario of ['missing', 'mismatch', 'signal_failure', 'unhandled', 'ack', 'inactive']) {
  test(`D-01: execute actual handoff shell with ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'drain-ack-'));
    try {
      await writeFile(join(root, 'pid'), scenario === 'missing' ? '' : '123');
      const result = spawnSync(
        'bash',
        [
          '-c',
          `
        set -euo pipefail
        systemctl() {
          case "$1" in
            is-active) return 0 ;;
            disable) return 0 ;;
            show) if [ "$3" = --property=MainPID ]; then echo ${scenario === 'mismatch' ? '124' : '123'}; else echo ${scenario === 'inactive' ? 'inactive' : 'active'}; fi ;;
          esac
        }
        kill() {
          ${scenario === 'signal_failure' ? 'return 1' : scenario === 'ack' ? `printf '%s' '{"pid":123,"activeStreams":7,"activeUploads":0,"runtimeQuiesced":false}' > "$TEST_ROOT/marker"` : ':'}
        }
        sleep() { SECONDS=$((SECONDS + 15)); }
        ${handoff}
        hand_off_retired_authority test-unit "$TEST_ROOT/marker" "$TEST_ROOT/pid"
      `,
        ],
        { encoding: 'utf8', env: { ...process.env, TEST_ROOT: root }, timeout: 5000 },
      );
      assert.equal(result.status === 0, ['ack', 'inactive'].includes(scenario), result.stderr);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('D-05: real HTTP rejects stale HTML, missing JS and mismatched JS despite a new identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-web-'));
  await mkdir(join(root, 'assets'));
  const html = '<script type="module" src="/assets/main.js"></script>';
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, 'assets/main.js'), 'console.log("new")');
  let mode = 'ok';
  const server = createServer((req, res) => {
    if (req.url === '/release-identity.json')
      return res.end(JSON.stringify({ releaseId: release }));
    if (req.url === '/') return res.end(mode === 'old-html' ? 'old page' : html);
    if (mode === 'missing-js') {
      res.writeHead(404);
      return res.end();
    }
    res.end(mode === 'old-js' ? 'old code' : 'console.log("new")');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await verifyPublicWeb({ root, url })).status, 'passed');
    for (mode of ['old-html', 'missing-js', 'old-js'])
      await assert.rejects(verifyPublicWeb({ root, url }), /mismatch|unavailable/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

function verifyCleanupFailureBlocksAcceptance(report) {
  const workflow = readFileSync(
    new URL('../../.github/workflows/deploy-staging.yml', import.meta.url),
    'utf8',
  );
  const revokeName = '      - name: 撤销临时测试环境 SSH 入站授权';
  const finalizeName = '      - name: 完成 GitHub 测试环境部署记录';
  const revokeIndex = workflow.indexOf(revokeName);
  const finalIndex = workflow.indexOf(finalizeName);
  assert.ok(workflow.indexOf('observe-staging-state.sh final') < revokeIndex);
  assert.ok(revokeIndex < finalIndex);
  const shell = (step) =>
    step
      .split('        run: |\n')[1]
      .split('\n      - name:')[0]
      .split('\n')
      .map((line) => line.replace(/^          /u, ''))
      .join('\n');
  const revoke = shell(workflow.slice(revokeIndex));
  const finalize = shell(workflow.slice(finalIndex));
  assert.match(workflow.slice(finalIndex), /WORKFLOW_STATUS: \$\{\{ job.status \}\}/u);
  assert.match(workflow.slice(finalIndex), /if: always\(\)/u);
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
    aliyun() { echo revoke-attempt >&2; return 1; }
    sleep() { :; }
    export -f aliyun sleep
    if bash -c "$REVOKE_SCRIPT"; then WORKFLOW_STATUS=success; else WORKFLOW_STATUS=failure; fi
    gh() { printf '%s\\n' "$@" >&2; }
    ${finalize}
  `,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        REVOKE_SCRIPT: revoke,
        STAGING_SSH_SECURITY_GROUP_ID: 'sg-test',
        STAGING_SSH_SOURCE_CIDR: '192.0.2.1/32',
        GITHUB_REPOSITORY: 'test/repo',
        STAGING_DEPLOYMENT_ID: '456',
        STAGING_WEB_URL: 'https://example.invalid',
      },
    },
  );
  // The actual finalization script redirects stdout, so capture gh arguments on stderr.
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.match(/revoke-attempt/gu)?.length, 5);
  assert.match(result.stderr, /state=failure/u);
  assert.doesNotMatch(result.stderr, /state=success/u);
  const state = result.stderr.match(/state=(\w+)/u)[1];
  assert.equal(report.runtimeConverged, true);
  assert.throws(
    () =>
      assertLatestStagingAttempt(
        [
          {
            deployment: { id: 456, environment: 'staging', payload: { releaseId: release } },
            statuses: [{ id: 1, state, created_at: '2026-09-07T00:00:00Z' }],
          },
        ],
        release,
      ),
    /incomplete/,
  );
}

test('D-04: runtime convergence does not grant acceptance when SSH revocation fails', () => {
  const component = { sourceSha: 'a'.repeat(40), artifactDigest: digest };
  const manifest = {
    releaseId: release,
    components: {
      api: component,
      runtimeWorker: component,
      web: component,
      acs: {
        sourceSha: component.sourceSha,
        orchestratorArtifactDigest: digest,
        sandboxImageDigest: digest,
      },
    },
  };
  const identity = { releaseId: release, ...component };
  const observed = {
    api: { status: 'ok' },
    host: { api: identity, runtimeWorker: identity },
    web: { releaseId: release, releaseSha: component.sourceSha, webDigest: digest },
    acs: {
      releaseId: release,
      sourceSha: component.sourceSha,
      orchestratorArtifactDigest: digest,
      sandboxImageDigest: digest,
      status: 'ok',
    },
  };
  const input = { manifest, observed, publicWebPassed: true };
  const report = summarizeStagingState(input);
  assert.equal(report.runtimeConverged, true);
  assert.equal(Object.hasOwn(report, 'acceptanceAllowed'), false);
  verifyCleanupFailureBlocksAcceptance(report);

  assert.equal(summarizeStagingState({ ...input, publicWebPassed: false }).runtimeConverged, false);
  observed.web.releaseId = 'old';
  assert.equal(summarizeStagingState(input).state, 'mixed_versions');
  assert.equal(summarizeStagingState(input).runtimeConverged, false);
  observed.host.runtimeWorker = { error: 'failed restore' };
  assert.equal(summarizeStagingState(input).state, 'unknown');
});

test('D-03: missing checks, source drift, incomplete or stale database evidence block migration completion', () => {
  const file = {
    path: 'schema.ts',
    classification: 'expand',
    baselineBlobDigest: null,
    targetBlobDigest: digest,
  };
  assert.throws(() => selectPostconditions([file], { entries: [] }), /Missing/);
  const check = {
    id: 'column',
    configPath: 'runtimeEventStore',
    description: 'column type',
    sql: 'SELECT true AS ok',
    params: [],
  };
  const catalog = {
    entries: [{ path: file.path, baselineDigest: null, targetDigest: digest, checks: [check] }],
  };
  const checks = selectPostconditions([file], catalog);
  assert.throws(
    () => selectPostconditions([{ ...file, targetBlobDigest: 'changed' }], catalog),
    /Missing/,
  );
  const manifest = {
    releaseId: release,
    digest,
    migrationPlan: {
      phase: 'expand',
      planDigest: digest,
      postconditions: checks,
      postconditionsDigest: digestBuffer(canonicalJson(checks)),
    },
  };
  const evidence = {
    releaseId: release,
    manifestDigest: digest,
    planDigest: digest,
    postconditionsDigest: manifest.migrationPlan.postconditionsDigest,
    environment: 'production',
    status: 'passed',
    observedAt: new Date().toISOString(),
    checks: [{ id: 'column', status: 'passed', database: 'test', targetDigest: digest }],
  };
  assert.doesNotThrow(() => assertDatabaseEvidence(manifest, evidence, 'production'));
  for (const change of [
    { checks: [] },
    { observedAt: '2000-01-01' },
    { environment: 'staging' },
    { status: 'failed' },
  ])
    assert.throws(
      () => assertDatabaseEvidence(manifest, { ...evidence, ...change }, 'production'),
      /readback/,
    );
});
