import { canonicalJson, digestBuffer } from '../artifact-lib.mjs';
import { createValidReleaseEvidence } from '../release-evidence-fixture.test-helper.mjs';
import { describeRelease } from '../automatic-release-plan.mjs';
import { REQUEST_TASK, STEP_TASK, seal } from '../automatic-release-contract.mjs';
import { createProductionCheckpoint } from '../production-checkpoint.mjs';

export const repository = 'owner/agent-saas';
export const sha = (n) => n.toString(16).repeat(40);
export const digest = (n) => `sha256:${n.toString(16).repeat(64)}`;
export const iso = (n) => new Date(n).toISOString();
export const ancestor = (older, newer) => older <= newer;
export function sealManifest(body) {
  const { digest: unused, ...value } = body;
  return {
    ...value,
    digest: digestBuffer(Buffer.from(`agent-saas-release-manifest-v2\0${canonicalJson(value)}`)),
  };
}
export function components(source, observed = false) {
  return Object.fromEntries(
    ['web', 'api', 'runtimeWorker', 'acs'].map((name) => [
      name,
      {
        [observed ? 'gitSha' : 'sourceSha']: source,
        ...(name === 'acs'
          ? { orchestratorArtifactDigest: digest(3), sandboxImageDigest: digest(4) }
          : { artifactDigest: digest(name === 'web' ? 2 : 1) }),
      },
    ]),
  );
}
export function release(
  n,
  source,
  base,
  state = 'verified',
  at = Date.now() - 600000,
  now = Date.now(),
) {
  const manifest = sealManifest({
    schemaVersion: 2,
    releaseId: `rc-20260911-${n}`,
    releaseSha: source,
    components: components(source),
    productionBaseline: components(base),
    promotionPolicy: { expiresAt: iso(now + 3600000) },
    migrationPlan: {
      phase: 'none',
      confirmation: 'not_required',
      contract: 'separate_release',
      planDigest: digest(5),
    },
  });
  const entry = (state, operationKey, offset, reason) => ({
    id: `${n}-${offset}`,
    state,
    operationKey,
    recordedAt: iso(at + offset),
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    ...(reason ? { reason: JSON.stringify(reason) } : {}),
  });
  const history = [
    entry('built', `build:${n}`, 0),
    entry('staging_deployed', `staging:${n}:1`, 1000, {
      stagingDeploymentId: String(n + 1000),
      stagingRunId: String(n),
      manifestDigest: manifest.digest,
    }),
    entry('verified', `deterministic:${n}:1`, 2000),
  ];
  if (state !== 'verified') {
    history.push(entry('approved', `approved:${n}`, 3000));
    if (state !== 'approved' && state !== 'failed_before_change')
      history.push(
        entry('promoting', `promoting:${n}`, 4000, {
          migrationPhase: 'none',
          manifestDigest: manifest.digest,
          migrationPlanDigest: digest(5),
          productionBeforeDigest: digest(6),
          productionTargetDigest: digest(7),
        }),
      );
    if (state !== 'approved' && state !== 'promoting')
      history.push(entry(state, `outcome:${n}`, 5000));
  }
  return describeRelease({ manifest, history }, now);
}
export function run(id = 501, workflow = 'promote-release.yml', now = Date.now()) {
  return {
    id,
    run_attempt: 1,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_branch: 'main',
    head_sha: sha(15),
    path: `.github/workflows/${workflow}`,
    event: 'workflow_dispatch',
    status: 'in_progress',
    conclusion: null,
    created_at: iso(now - 10000),
    run_started_at: iso(now - 10000),
    updated_at: iso(now - 10000),
    html_url: `https://github.com/${repository}/actions/runs/${id}`,
  };
}
export function context(now = Date.now()) {
  const parentRun = run(501, 'promote-release.yml', now);
  const request = seal({
    schemaVersion: 1,
    kind: 'automatic-release-request',
    repository,
    parentRunId: '501',
    engineSha: parentRun.head_sha,
    requestedAt: parentRun.created_at,
    reason: 'release latest',
    target: {
      sourceSha: sha(10),
      releaseId: 'rc-20260911-118',
      manifestDigest: digest(8),
      verifiedAt: iso(now - 20000),
    },
  });
  const requestRecord = {
    id: 601,
    task: REQUEST_TASK,
    sha: request.engineSha,
    environment: 'production-request',
    created_at: iso(now - 9000),
    payload: request,
  };
  const step = seal({
    schemaVersion: 1,
    kind: 'automatic-release-step',
    repository,
    requestId: '601',
    requestDigest: request.digest,
    parentRunId: '501',
    parentRunAttempt: 1,
    engineSha: request.engineSha,
    stage: 'refresh',
    key: 'auto:501:refresh',
    workflow: 'deploy-staging.yml',
    sourceSha: request.target.sourceSha,
    inputs: { reason: request.reason },
  });
  const stepRecord = {
    id: 602,
    task: STEP_TASK,
    sha: step.engineSha,
    environment: 'production-request',
    created_at: iso(now - 8000),
    payload: step,
  };
  const childRun = {
    ...run(701, 'deploy-staging.yml', now - 3000),
    display_title: step.key,
    created_at: iso(now - 7000),
    run_started_at: iso(now - 7000),
    updated_at: iso(now + 1000),
  };
  return { requestRecord, stepRecord, parentRun, run: childRun };
}
export function sourceFixture(now = Date.now()) {
  const c = context(now);
  const authority = createValidReleaseEvidence();
  const m = release(119, sha(10), sha(11), 'verified', now - 6000, now).manifest;
  const manifest = sealManifest({
    ...m,
    productionBaseline: authority.productionBaseline,
    migrationPlan: authority.migrationPlan,
  });
  const deployment = {
    id: 801,
    environment: 'staging',
    sha: manifest.releaseSha,
    payload: {
      releaseId: manifest.releaseId,
      manifestDigest: manifest.digest,
      stagingRunId: '701',
      stagingRunAttempt: '1',
    },
  };
  return { manifest, authority, context: c, deployment, now, repository };
}
export function checkpointFor(manifest, runId = 801, now = Date.now()) {
  const stateBody = {
    schemaVersion: 1,
    environment: 'production',
    observedAt: iso(now),
    components: components(manifest.releaseSha, true),
    configIdentity: { status: 'consistent' },
  };
  return createProductionCheckpoint({
    manifest,
    state: { ...stateBody, digest: digestBuffer(Buffer.from(canonicalJson(stateBody))) },
    completed: {
      releaseId: manifest.releaseId,
      manifestDigest: manifest.digest,
      state: 'completed',
    },
    runId,
    runAttempt: 1,
    now,
  });
}
