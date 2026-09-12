import { canonicalJson, digestBuffer } from '../artifact-lib.mjs';
import { LEGACY_NONE_PRODUCER_BLOB } from '../legacy-none-readback-revalidation.mjs';

export const iso = (value) => new Date(value).toISOString();
export const digest = (value) => digestBuffer(canonicalJson(value));
export const asBytes = (value) => Buffer.from(canonicalJson(value) + '\n');
export const parseLegacy = (bytes) =>
  JSON.parse(bytes.toString().replace('"postconditionsDigest":undefined,', ''));

export function fixture(now = Date.now()) {
  const repository = 'owner/agent-saas';
  const manifest = {
    releaseId: 'rc-20260911-117',
    releaseSha: 'a'.repeat(40),
    digest: `sha256:${'b'.repeat(64)}`,
    promotionPolicy: { expiresAt: iso(now + 3600000) },
    migrationPlan: {
      phase: 'none',
      planDigest: `sha256:${'c'.repeat(64)}`,
      confirmation: 'not_required',
      contract: 'separate_release',
    },
  };
  const entry = (state, operationKey, at, reason) => ({
    state,
    operationKey,
    recordedAt: iso(at),
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    ...(reason ? { reason: JSON.stringify(reason) } : {}),
  });
  const history = [
    entry('built', 'build:701', now - 1200000),
    entry('staging_deployed', 'staging:701:1', now - 601000, {
      stagingDeploymentId: '801',
      stagingRunId: '701',
      manifestDigest: manifest.digest,
    }),
    entry('verified', 'deterministic:701:1', now - 600000),
    entry('approved', 'approval:901:1', now - 400000),
    entry('promoting', 'promoting:901:1', now - 300000, {
      releaseId: manifest.releaseId,
      releaseSha: manifest.releaseSha,
      manifestDigest: manifest.digest,
      migrationPhase: 'none',
      migrationPlanDigest: manifest.migrationPlan.planDigest,
      productionBeforeDigest: `sha256:${'d'.repeat(64)}`,
      productionTargetDigest: `sha256:${'e'.repeat(64)}`,
    }),
    entry('needs_human', 'outcome:901:1', now - 200000),
  ];
  const run = {
    id: 701,
    run_attempt: 1,
    head_sha: manifest.releaseSha,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_branch: 'main',
    event: 'workflow_dispatch',
    path: '.github/workflows/deploy-staging.yml',
    status: 'completed',
    conclusion: 'success',
    run_started_at: iso(now - 1200000),
    updated_at: iso(now - 578000),
  };
  const historical = {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    planDigest: manifest.migrationPlan.planDigest,
    postconditionsDigest: undefined,
    environment: 'staging',
    observedAt: iso(now - 610000),
    status: 'not_required',
    checks: [],
  };
  const deployment = {
    id: 801,
    environment: 'staging',
    sha: manifest.releaseSha,
    payload: {
      releaseId: manifest.releaseId,
      manifestDigest: manifest.digest,
      stagingRunId: '701',
    },
  };
  const state = (id, value, at) => ({
    id,
    state: value,
    environment: 'staging',
    created_at: iso(at),
    deployment_url: `https://api.github.com/repos/${repository}/deployments/801`,
    log_url: '',
  });
  return {
    manifest,
    history,
    bytes: asBytes(historical),
    producerBlob: LEGACY_NONE_PRODUCER_BLOB,
    run,
    runId: '701',
    runAttempt: '1',
    repository,
    now,
    deployment,
    statusPages: [[state(3, 'inactive', now - 450000), state(2, 'success', now - 580000)]],
    latestRun: structuredClone(run),
  };
}
