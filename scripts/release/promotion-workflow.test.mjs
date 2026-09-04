import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertPromotionRetryable } from './assert-promotion-retry.mjs';
import { planPromotionConfigIdentityBaseline } from './promotion-config-identity-state.mjs';
import { reconcilePromotion } from './reconcile-promotion.mjs';
import { verifyPromotionAcsSelection } from './verify-promotion-acs-selection.mjs';

const workflowPath = new URL('../../.github/workflows/promote-release.yml', import.meta.url);
const rollbackRetryFixturePath = new URL(
  './fixtures/promotion-rollback-retry.json',
  import.meta.url,
);
const deployPath = new URL('./deploy-production-release.sh', import.meta.url);
const buildReleasePath = new URL('./build-release.mjs', import.meta.url);
const phaseVerifierPath = new URL('./verify-promotion-phase-state.mjs', import.meta.url);
const acsUnitPath = new URL(
  '../../daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template',
  import.meta.url,
);
const serverUnitPath = new URL(
  '../../daemon-packaging/systemd/agent-saas-server@.service.template',
  import.meta.url,
);
const workerUnitPath = new URL(
  '../../daemon-packaging/systemd/agent-saas-runtime-worker@.service.template',
  import.meta.url,
);

function ordered(text, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker);
    assert.ok(next > cursor, `${marker} must appear in the required order`);
    cursor = next;
  }
}

function runScriptLines(text) {
  const output = [];
  let runIndent = null;
  for (const line of text.split('\n')) {
    const indentation = line.match(/^\s*/u)[0].length;
    if (runIndent !== null && line.trim() && indentation <= runIndent) runIndent = null;
    const start = line.match(/^(\s*)run:\s*\|\s*$/u);
    if (start) {
      runIndent = start[1].length;
      continue;
    }
    if (runIndent !== null) output.push(line);
  }
  return output;
}

test('durable promoting marker interruptions always converge through needs_human', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const approvalStep = workflow.slice(
    workflow.indexOf('- name: Fail-closed revalidate deterministic Staging evidence'),
    workflow.indexOf('- name: Configure production SSH'),
  );
  ordered(approvalStep, [
    'if [ "$latest_state" = promoting ]; then',
    '--state needs_human --operation "recover-promoting:$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT"',
    'upload-github-release-asset-immutable.sh',
    'upload-oss-object-immutable.sh',
    'assert-promotion-retry.mjs',
    '--state approved --operation "approval:$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT"',
  ]);

  const markerStep = workflow.slice(
    workflow.indexOf('- name: Mark and persist promotion started'),
    workflow.indexOf('- name: Create GitHub Production Deployment'),
  );
  ordered(markerStep, [
    '--state promoting --operation "promoting:$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT"',
    'echo \'PROMOTION_STARTED=true\' >> "$GITHUB_ENV"',
    'attestation-snapshot.mjs create',
    'upload-github-release-asset-immutable.sh',
    'upload-oss-object-immutable.sh',
  ]);
});

test('promotion accepts only an approved release id and shares the production runtime lock', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /release_id:/u);
  assert.doesNotMatch(workflow, /^\s+(?:release_sha|artifact_url|image_tag):/mu);
  assert.match(workflow, /group: production-runtime/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /environment: production/u);
  assert.doesNotMatch(
    workflow,
    /group: (?:production-promotion|acs-production-deploy|agent-saas-production-deploy)/u,
  );
  assert.match(workflow, /PRODUCTION_SSH_HOST_KEY_SHA256/u);
  assert.match(workflow, /RELEASE_ID_INPUT: \$\{\{ inputs\.release_id \}\}/u);
  assert.match(workflow, /\[\[ "\$RELEASE_ID_INPUT" =~ \^rc-/u);
  assert.match(workflow, /tr -d '\[:space:\]'/u);
  assert.doesNotMatch(workflow, /printf[^\n]*\$\{\{ inputs\./u);
  assert.match(workflow, /retry_before_change/u);
  assert.match(workflow, /retry_after_change/u);
  assert.doesNotMatch(
    workflow,
    /verified\|approved\|promoting\|rejected|verified\|approved\|promoting\|revoked/u,
  );
  assert.match(
    workflow,
    /--state approved --operation "approval:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT"/u,
  );
  assert.match(
    workflow,
    /--state promoting --operation "promoting:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT"/u,
  );
  assert.match(workflow, /deployments\/\$deployment_id\/statuses/u);
  assert.match(workflow, /actions\/runs\/\$staging_run_id/u);
  assert.match(workflow, /deterministic-deployment-gates-v1/u);
  assert.match(workflow, /verificationSummary/u);
  assert.doesNotMatch(workflow, /e2eRunId|e2eSummary|summarize-e2e/u);
  assert.match(workflow, /runtime_summary=/u);
  assert.match(workflow, /\.artifacts\.stagingRuntimeAssets\?\.path \/\/ empty/u);
  assert.match(workflow, /if \[ -n "\$staging_runtime_path" \]; then/u);
  assert.match(workflow, /stagingRuntimeAssetsDigest/u);
  assert.match(workflow, /expected_runtime_summary/u);
  assert.match(workflow, /assert-promotion-retry\.mjs/u);
  assert.match(workflow, /retry-normalize:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT/u);
  assert.match(
    workflow,
    /\[ "\$retry_mode" = retry_after_change \] && \[ "\$latest_state" = approved \]/u,
  );
  assert.match(workflow, /APPROVAL_RECORDED=true/u);
});

test('rolled-back App and Web failures require staging revalidation and reviewed retry_after_change', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const fixture = JSON.parse(await readFile(rollbackRetryFixturePath, 'utf8'));
  const approvalStart = workflow.indexOf(
    '- name: Fail-closed revalidate deterministic Staging evidence and record human approval',
  );
  const approvalEnd = workflow.indexOf('- name: Configure production SSH', approvalStart);
  assert.ok(approvalStart >= 0 && approvalEnd > approvalStart, 'approval gate must be present');
  const approvalGate = workflow.slice(approvalStart, approvalEnd);
  ordered(approvalGate, [
    'assert-promotion-retry.mjs',
    'select(.state=="staging_deployed")',
    'deployments/$deployment_id/statuses',
    'actions/runs/$staging_run_id',
    '--arg recoveryMode "$retry_mode"',
    '--state approved',
  ]);

  for (const { failedStage, observedAtFailure } of fixture.temporaryFailures) {
    assert.equal(
      reconcilePromotion({
        releaseId: `rc-${failedStage}`,
        before: fixture.before,
        target: fixture.target,
        observed: observedAtFailure,
        observationComplete: true,
      }).outcome,
      'partial_failed',
    );
    assert.equal(
      reconcilePromotion({
        releaseId: `rc-${failedStage}`,
        before: fixture.before,
        target: fixture.target,
        observed: fixture.before,
        observationComplete: true,
        rollbackAttempted: true,
      }).outcome,
      'rolled_back',
    );

    const recoveryState =
      fixture.recoveryStates[
        fixture.temporaryFailures.findIndex((failure) => failure.failedStage === failedStage)
      ];
    const rolledBackHistory = [
      ...fixture.attestationPrefix,
      { state: recoveryState, operationKey: `${recoveryState}:${failedStage}` },
      { state: 'rolled_back', operationKey: `rollback:${failedStage}` },
    ];
    const retry = assertPromotionRetryable(rolledBackHistory);
    assert.equal(retry.mode, 'retry_after_change');
    assert.deepEqual(
      planPromotionConfigIdentityBaseline({
        retryMode: retry.mode,
        ...fixture.manifestActions,
      }),
      {
        reader: 'read-live-production-components.mjs',
        configIdentityStage: 'legacy-api-upgrade-retry-baseline',
      },
    );

    const secondReviewedRound = [
      ...rolledBackHistory,
      { state: 'approved', operationKey: `approval:${failedStage}:2` },
      { state: 'promoting', operationKey: `promoting:${failedStage}:2` },
      { state: 'partial_failed', operationKey: `partial:${failedStage}:2` },
      { state: 'rolled_back', operationKey: `rollback:${failedStage}:2` },
    ];
    assert.equal(assertPromotionRetryable(secondReviewedRound).mode, 'retry_after_change');
  }

  for (const history of fixture.illegalTails) {
    assert.throws(() => assertPromotionRetryable(history), /terminal post-mutation state/u);
  }
});

test('approval and promoting operations are unique per run attempt and idempotent within an attempt', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const approvalStart = workflow.indexOf(
    '- name: Fail-closed revalidate deterministic Staging evidence and record human approval',
  );
  const approvalEnd = workflow.indexOf('- name: Configure production SSH', approvalStart);
  const approvalGate = workflow.slice(approvalStart, approvalEnd);
  const approvalOperationTemplate = approvalGate.match(
    /--state approved --operation "([^"]+)"/u,
  )?.[1];
  const promotingOperationTemplate = workflow.match(
    /--state promoting --operation "([^"]+)"/u,
  )?.[1];
  assert.equal(approvalOperationTemplate, 'approval:$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT');
  assert.equal(promotingOperationTemplate, 'promoting:$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT');

  const operationFor = (template, runId, runAttempt) =>
    template
      .replace('$GITHUB_RUN_ID', runId)
      .replace('$GITHUB_RUN_ATTEMPT', String(runAttempt));
  const appendIdempotently = (history, approval) => {
    const existing = history.find((entry) => entry.operationKey === approval.operationKey);
    if (existing) {
      assert.deepEqual(existing, approval, 'same-attempt replay must carry identical content');
      return existing;
    }
    history.push(approval);
    return approval;
  };

  const runId = '424242';
  const firstApproval = {
    state: 'approved',
    operationKey: operationFor(approvalOperationTemplate, runId, 1),
    reason: 'attempt-1-review',
  };
  const retryFixtures = [
    {
      name: 'failed_before_change',
      expectedMode: 'retry_before_change',
      history: [
        { state: 'verified', operationKey: 'verified:fixture' },
        firstApproval,
        { state: 'failed_before_change', operationKey: `failed-before-change:${runId}:1` },
      ],
    },
    {
      name: 'rolled_back',
      expectedMode: 'retry_after_change',
      history: [
        { state: 'verified', operationKey: 'verified:fixture' },
        firstApproval,
        {
          state: 'promoting',
          operationKey: operationFor(promotingOperationTemplate, runId, 1),
        },
        { state: 'partial_failed', operationKey: `outcome:${runId}:1` },
        { state: 'rolled_back', operationKey: `rollback:${runId}:1` },
      ],
    },
  ];

  for (const fixture of retryFixtures) {
    assert.equal(
      assertPromotionRetryable(fixture.history).mode,
      fixture.expectedMode,
      fixture.name,
    );
    const nextApproval = {
      state: 'approved',
      operationKey: operationFor(approvalOperationTemplate, runId, 2),
      reason: `attempt-2-${fixture.expectedMode}`,
    };
    assert.notEqual(nextApproval.operationKey, firstApproval.operationKey);
    appendIdempotently(fixture.history, nextApproval);
    const lengthAfterApproval = fixture.history.length;
    assert.equal(assertPromotionRetryable(fixture.history).previousApprovalCount, 2);
    assert.strictEqual(appendIdempotently(fixture.history, { ...nextApproval }), nextApproval);
    assert.equal(
      fixture.history.length,
      lengthAfterApproval,
      `${fixture.name} replay must not append`,
    );
    const nextPromoting = {
      state: 'promoting',
      operationKey: operationFor(promotingOperationTemplate, runId, 2),
    };
    assert.notEqual(
      nextPromoting.operationKey,
      operationFor(promotingOperationTemplate, runId, 1),
    );
    appendIdempotently(fixture.history, nextPromoting);
    const lengthAfterPromoting = fixture.history.length;
    assert.strictEqual(appendIdempotently(fixture.history, { ...nextPromoting }), nextPromoting);
    assert.equal(fixture.history.length, lengthAfterPromoting);
  }
});

test('Web rollback marker is written only by the armed restore path', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const start = workflow.indexOf('- name: Publish Web entry last and retain prior hashed assets');
  const end = workflow.indexOf('- name: Persist Web operation receipt', start);
  const web = workflow.slice(start, end);
  const markerWrite = 'install -m 0600 /dev/null "$web_rollback_attempted_marker"';
  assert.equal(web.split(markerWrite).length - 1, 1);
  ordered(web, [
    'trap cleanup_web_on_exit EXIT',
    'aliyun --secure oss cp "$PRODUCTION_WEB_OSS_URI/release-identity.json"',
    'restore_web_entry() {',
    markerWrite,
    'web_backup_ready=true',
  ]);
  assert.ok(web.indexOf('trap cleanup_web_on_exit EXIT') < web.indexOf(markerWrite));
});

test('deploy output creates exact run-attempt fallback evidence without swallowing SSH failure', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const deploy = await readFile(deployPath, 'utf8');
  for (const phase of ['acs', 'app']) {
    const start = workflow.indexOf(
      phase === 'acs'
        ? '- name: Deploy exact ACS Orchestrator and Sandbox digest first'
        : '- name: Deploy API blue-green and hand off Runtime Worker',
    );
    const end = workflow.indexOf(
      phase === 'acs'
        ? '- name: Persist ACS operation receipt'
        : '- name: Persist API and Worker operation receipts',
      start,
    );
    const deployStep = workflow.slice(start, end);
    const exactSentinel =
      `AGENT_SAAS_ROLLBACK_ATTEMPTED PHASE=${phase} ` +
      'GITHUB_RUN_ID=$GITHUB_RUN_ID GITHUB_RUN_ATTEMPT=$GITHUB_RUN_ATTEMPT';
    ordered(deployStep, [
      `rollback_local_marker="$RUNNER_TEMP/rollback-attempted-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${phase}"`,
      `rollback_sentinel="${exactSentinel}"`,
      'set +e',
      '2>&1 | tee "$rollback_output"',
      'pipeline_status=("${PIPESTATUS[@]}")',
      'set -e\n          if grep',
      'grep -Fx -- "$rollback_sentinel" "$rollback_output"',
      'exit "${pipeline_status[0]}"',
      'exit "${pipeline_status[1]}"',
    ]);
    assert.doesNotMatch(deployStep, /if\s+ssh/u);
  }
  for (const name of [
    'PHASE',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'ROLLBACK_ATTEMPTED_MARKER',
  ]) {
    assert.match(deploy, new RegExp(`-u ${name}`));
  }
  assert.match(deploy, /2> >\(sed 's\/\^\/\[config-identity-cli\] \/' >&2\)/u);
});

test('reconcile derives rollback attempts from Web local, ACS/App fallback, and remote markers', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const start = workflow.indexOf('- name: Reconcile component outcome');
  const end = workflow.indexOf('- name: Record truthful final outcome', start);
  const reconcile = workflow.slice(start, end);
  assert.match(reconcile, /for component in web acs app; do/u);
  assert.match(
    reconcile,
    /local_rollback_attempted_marker="\$RUNNER_TEMP\/rollback-attempted-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT-\$component"/u,
  );
  assert.match(reconcile, /\[ -f "\$local_rollback_attempted_marker" \]/u);
  assert.match(reconcile, /\[ -n "\$\{PROMOTION_REMOTE:-\}" \]/u);
  assert.match(reconcile, /if ssh -o BatchMode=yes -o ConnectTimeout=10/u);
  assert.doesNotMatch(reconcile, /steps\.deploy_(?:acs|app|web)\.outcome/u);
  assert.match(reconcile, /rollback-attempted-acs/u);
  assert.match(reconcile, /rollback-attempted-app/u);
});

test('malicious multiline dispatch input cannot pass release-id validation or reach shell syntax', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.ok(
    runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\.(?:release_id|reason)/u.test(line)),
  );
  const result = spawnSync('bash', ['-c', '[[ "$RELEASE_ID_INPUT" =~ ^rc-[0-9]{8}-[0-9]{2,}$ ]]'], {
    env: {
      ...process.env,
      RELEASE_ID_INPUT: 'rc-20260827-01\nMALICIOUS=$(touch should-not-run)',
    },
  });
  assert.notEqual(result.status, 0);
});

test('remote workspaces and approval attestations are isolated by run attempt', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const remoteDirectories = [
    ...workflow.matchAll(
      /remote="(\/tmp\/(?:release-preflight|agent-saas-promotion|release-readback)-[^"]+)"/gu,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(remoteDirectories, [
    '/tmp/release-preflight-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT',
    '/tmp/agent-saas-promotion-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT',
    '/tmp/release-readback-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT',
  ]);
  assert.match(workflow, /--operation "approval:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT"/u);
  assert.doesNotMatch(workflow, /--operation "approval:\$GITHUB_RUN_ID"/u);
  assert.match(workflow, /--operation "promoting:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT"/u);
  assert.doesNotMatch(workflow, /--operation "promoting:\$GITHUB_RUN_ID"/u);
  assert.match(workflow, /--operation "outcome:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT"/u);
  assert.match(
    workflow,
    /--operation "failed-before-change:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT"/u,
  );
  assert.match(workflow, /rollback-attempted-acs/u);
  assert.match(workflow, /rollback-attempted-app/u);
});

test('trusted identity write is followed by a strict stable ConfigIdentity confirmation', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const start = workflow.indexOf(
    '- name: Read every live component and commit trusted identity only on complete convergence',
  );
  const end = workflow.indexOf('- name: Reconcile component outcome', start);
  assert.ok(start >= 0 && end > start, 'readback step must be present');
  const readback = workflow.slice(start, end);
  assert.match(
    readback,
    /config_identity_projection='\.configIdentity \| \{schemaVersion,status,expected,observed,releaseId\}'/u,
  );
  ordered(readback, [
    'test "$(jq -r .configIdentity.releaseId "$RUNNER_TEMP/production-after.json")" = "$expected_config_release_id"',
    'write-production-identity.mjs',
    "read-production-state.mjs' --output '$remote/production-confirmed.json'",
    'test "$(jq -r .configIdentity.status "$RUNNER_TEMP/production-confirmed.json")" = consistent',
    'test "$(jq -r .configIdentity.releaseId "$RUNNER_TEMP/production-confirmed.json")" =',
    'config_identity_projection=',
    '<(jq -S "$config_identity_projection" "$RUNNER_TEMP/production-confirmed.json")',
    '<(jq -S "$config_identity_projection" "$RUNNER_TEMP/production-after.json")',
  ]);

  const reconcileEnd = workflow.indexOf('- name: Record truthful final outcome', end);
  assert.ok(reconcileEnd > end, 'reconcile step must be present');
  const reconcile = workflow.slice(end, reconcileEnd);
  ordered(reconcile, [
    'config_identity_confirmed=false',
    'if [ "${{ steps.readback.outcome }}" = success ] &&',
    '[ "${{ steps.readback.outputs.target_match }}" = true ]; then',
    'config_identity_confirmed=true',
    '--argjson configIdentityConfirmed "$config_identity_confirmed"',
    'configIdentityConfirmed:$configIdentityConfirmed',
  ]);
});

test('final outcome and attestation preserve a reconciliation needs_human result', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const start = workflow.indexOf('- name: Record truthful final outcome');
  const end = workflow.indexOf(
    '- name: Record fail-closed outcome before production mutation',
    start,
  );
  assert.ok(start >= 0 && end > start, 'final outcome step must be present');
  const finalOutcome = workflow.slice(start, end);
  ordered(finalOutcome, [
    'outcome=needs_human',
    'outcome="$(jq -r .outcome "$RUNNER_TEMP/reconcile.json")"',
    'if [ "$outcome" = completed ]',
    '--state "$outcome"',
    'state=failure',
    '[ "$outcome" = completed ] && state=success',
    'test "$outcome" = completed',
  ]);
  assert.doesNotMatch(finalOutcome, /^\s*outcome=completed$/mu);
});

test('web-only, app-only, and ACS-only promotion validate the selected ACS identity and kept baseline by action', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(
    workflow,
    /verify-promotion-acs-selection\.mjs[\s\\]*"\$RUNNER_TEMP\/manifest\.json"[\s\S]*"\$RUNNER_TEMP\/built\/artifact-index\.json"/u,
  );
  const releaseSha = 'a'.repeat(40);
  const baselineSha = 'b'.repeat(40);
  const orchestratorDigest = `sha256:${'1'.repeat(64)}`;
  const imageDigest = `sha256:${'2'.repeat(64)}`;
  const expectedRepository = 'registry.example.com/agent-saas/acs-sandbox';
  const baseline = {
    sourceSha: baselineSha,
    orchestratorArtifactDigest: orchestratorDigest,
    sandboxImageDigest: imageDigest,
  };
  const manifestFor = (components, action) => ({
    releaseSha,
    components: {
      ...components,
      acs: { action, ...(action === 'deploy' ? { ...baseline, sourceSha: releaseSha } : baseline) },
    },
    productionBaseline: { acs: { ...baseline } },
    artifacts: {
      acsOrchestrator: { digest: orchestratorDigest, required: action === 'deploy' },
      acsImage: {
        repository: expectedRepository,
        digest: imageDigest,
        required: action === 'deploy',
      },
    },
  });
  const keepIndex = { acsImage: null };
  const scenarios = [
    [
      'web-only',
      { web: { action: 'deploy' }, api: { action: 'keep' }, runtimeWorker: { action: 'keep' } },
    ],
    [
      'app-only',
      { web: { action: 'keep' }, api: { action: 'deploy' }, runtimeWorker: { action: 'deploy' } },
    ],
  ];
  for (const [name, components] of scenarios) {
    assert.doesNotThrow(
      () =>
        verifyPromotionAcsSelection({
          manifest: manifestFor(components, 'keep'),
          artifactIndex: keepIndex,
          expectedRepository,
        }),
      name,
    );
  }
  const driftedKeep = manifestFor(scenarios[0][1], 'keep');
  driftedKeep.productionBaseline.acs = {
    ...driftedKeep.productionBaseline.acs,
    sandboxImageDigest: `sha256:${'3'.repeat(64)}`,
  };
  assert.throws(
    () =>
      verifyPromotionAcsSelection({
        manifest: driftedKeep,
        artifactIndex: keepIndex,
        expectedRepository,
      }),
    /Kept ACS image must equal the baseline/u,
  );
  const acsOnly = manifestFor(
    { web: { action: 'keep' }, api: { action: 'keep' }, runtimeWorker: { action: 'keep' } },
    'deploy',
  );
  assert.doesNotThrow(() =>
    verifyPromotionAcsSelection({
      manifest: acsOnly,
      artifactIndex: {
        acsImage: {
          sourceSha: releaseSha,
          digest: imageDigest,
          reference: `${expectedRepository}@${imageDigest}`,
        },
      },
      expectedRepository,
    }),
  );
  assert.throws(
    () =>
      verifyPromotionAcsSelection({
        manifest: acsOnly,
        artifactIndex: keepIndex,
        expectedRepository,
      }),
    /ACS deploy requires an image/u,
  );
});

test('verified evidence, selected digests, and RC-bound units precede ACS, App, and Web convergence', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  ordered(workflow, [
    'node scripts/release/verify-promotion-entry.mjs "$RUNNER_TEMP/manifest.json"',
    '- name: Fail-closed revalidate deterministic Staging evidence and record human approval',
    '- name: Read authoritative live production prefix before any write',
    '- name: Prefetch, verify, and safely extract selected Manifest artifacts',
    '- name: Mark and persist promotion started before any production write',
    '- name: Upload immutable deploy payload and RC-bound managed units',
    '- name: Deploy exact ACS Orchestrator and Sandbox digest first',
    '- name: Deploy API blue-green and hand off Runtime Worker',
    '- name: Publish Web entry last and retain prior hashed assets',
  ]);
  assert.match(workflow, /components\.acs\.sandboxImageDigest/u);
  assert.match(workflow, /verify-promotion-acs-selection\.mjs/u);
  assert.match(workflow, /"\$RUNNER_TEMP\/built\/artifact-index\.json"/u);
  assert.doesNotMatch(workflow, /release\/wait-for-acr-image\.sh/u);
  assert.doesNotMatch(workflow, /aliyun cr ListRepoTag/u);
  assert.match(workflow, /run_with_web_lock aliyun --secure oss stat/u);
  assert.match(workflow, /PROMOTION_RETRY_MODE/u);
  assert.match(workflow, /--arg recoveryMode "\$PROMOTION_RETRY_MODE"/u);
  assert.match(workflow, /prior post-mutation recovery remains required/u);
  assert.match(workflow, /previous promotion ended after the durable promoting marker/u);
  assert.match(workflow, /--state needs_human --operation "recover-promoting:/u);
  assert.match(workflow, /PRODUCTION_ALREADY_TARGET/u);
  assert.match(workflow, /--state failed_before_change/u);
  assert.match(workflow, /already equals the immutable target/u);
  assert.match(workflow, /scripts\/release\/read-live-production-components\.mjs/u);
  assert.match(workflow, /--recovery-mode "\$PROMOTION_RETRY_MODE"/u);
  assert.match(workflow, /identity_projection=/u);
  assert.doesNotMatch(workflow, /jq -S \.components "\$RUNNER_TEMP\/production-confirmed\.json"/u);
  assert.match(workflow, /verify-promotion-acs-selection\.mjs/u);
  assert.match(workflow, /built\/artifact-index\.json/u);
  assert.match(workflow, /built_base="\$RELEASE_RECORD_OSS_URI\/\$RELEASE_ID"/u);
  assert.match(workflow, /runtimeDependencies\.path/u);
  assert.match(
    workflow,
    /if \[ "\$\(jq -r \.schemaVersion "\$RUNNER_TEMP\/built\/artifact-index\.json"\)" = 2 \]; then/u,
  );
  assert.match(workflow, /\.artifacts\[\] \| \.path/u);
  assert.doesNotMatch(workflow, /selected\/artifact-index\.json/u);
  assert.match(workflow, /runtimeDependencies\.server\.uri/u);
  assert.match(workflow, /Manifest, artifact index and Release record from OSS/u);
  assert.match(workflow, /verify-selected-release-artifacts\.mjs/u);
  assert.ok(
    workflow.indexOf('node scripts/release/verify-artifact.mjs') <
      workflow.indexOf('verify-selected-release-artifacts.mjs'),
  );
  assert.match(
    workflow,
    /node scripts\/release\/verify-promotion-entry\.mjs "\$RUNNER_TEMP\/manifest\.json"/u,
  );
  assert.match(workflow, /release-preflight-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u);
  assert.match(workflow, /agent-saas-promotion-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u);
  assert.match(workflow, /promotion-config-identity-state\.mjs plan/u);
  assert.match(workflow, /reader="\$\(printf '%s' "\$baseline_plan" \| jq -r \.reader\)"/u);
  assert.match(workflow, /reader_stage="\$\(printf '%s' "\$baseline_plan" \| jq -r \.configIdentityStage\)"/u);
  assert.match(
    workflow,
    /node '\$remote\/\$reader' --config-identity-stage '\$reader_stage' --output '\$remote\/production-before\.json/u,
  );
  assert.doesNotMatch(workflow, /install -m 0444 daemon-packaging\/systemd/u);
  assert.match(workflow, /extract_control_file\(\)/u);
  assert.match(workflow, /tar -xOf "\$archive" -- "\$raw" > "\$candidate"/u);
  assert.doesNotMatch(
    workflow,
    /tar -xzf "\$RUNNER_TEMP\/selected\/(?:server-bundle|acs-orchestrator)/u,
  );
  assert.match(
    workflow,
    /server\/daemon-packaging\/systemd\/agent-saas-server@\.service\.template/u,
  );
  assert.match(
    workflow,
    /acs-orchestrator\/daemon-packaging\/systemd\/agent-saas-acs-orchestrator\.service\.template/u,
  );
  assert.match(workflow, /selected-units\/agent-saas-acs-orchestrator\.service\.template/u);
  assert.match(workflow, /app_action="\$\(jq -r \.components\.api\.action/u);
  assert.match(workflow, /acs_action="\$\(jq -r \.components\.acs\.action/u);
  assert.match(workflow, /if \[ "\$app_action" = deploy \]; then/u);
  assert.match(workflow, /if \[ "\$acs_action" = deploy \]; then/u);
  assert.match(workflow, /if \[ -e "\$\{unit_files\[0\]\}" \]; then/u);
  assert.match(workflow, /verify-release-record\.mjs/u);
  assert.match(workflow, /oss-record\/record\.json/u);
  assert.match(
    workflow,
    /READ_LIVE_COMPONENTS_SCRIPT='\$PROMOTION_REMOTE\/read-live-production-components\.mjs'/u,
  );
  assert.match(workflow, /PHASE=web RELEASE_DIR=/u);
  assert.match(
    workflow,
    /VERIFY_PROMOTION_PHASE_SCRIPT='\$PROMOTION_REMOTE\/verify-promotion-phase-state\.mjs'/u,
  );
  assert.match(workflow, /PHASE=app VERIFY_ONLY='\$verify_only'/u);
  assert.match(workflow, /release-identity\.json/u);
  assert.match(workflow, /web-oss-readback/u);
  assert.match(workflow, /release-readback-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u);
  assert.match(workflow, /WEB_LOCK_READY='\$web_lock_ready'/u);
  assert.match(workflow, /timeout-minutes: 180/u);
  assert.match(workflow, /timeout --signal=TERM --kill-after=10 1800 sudo PHASE=web/u);
  assert.match(workflow, /WEB_LOCK_TIMEOUT_SECONDS=1700/u);
  assert.match(workflow, /web_operation_deadline=\$\(\(SECONDS \+ 1200\)\)/u);
  assert.match(workflow, /web_operation_deadline=\$\(\(SECONDS \+ 300\)\)/u);
  assert.match(workflow, /setsid timeout --signal=TERM --kill-after=10 "\$remaining" "\$@"/u);
  assert.match(workflow, /run_with_web_lock/u);
  assert.match(workflow, /release_web_lock/u);
  assert.match(workflow, /keep without restart/u);
  assert.match(workflow, /\boptional_staging_acceptance\b/u);
  assert.doesNotMatch(workflow, /observe-production\.mjs|duration-ms 900000/u);
  assert.doesNotMatch(workflow, /PRODUCTION_OBSERVATION_(?:TOKEN|URL)/u);
  assert.doesNotMatch(workflow, /production-observation(?:\.json|\/)/u);
  assert.doesNotMatch(workflow, /--clobber/u);
  assert.ok(runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\./u.test(line)));
});

test('production ACS promotion enforces lifecycle policy and fails closed on health mismatch', async () => {
  const deploy = await readFile(deployPath, 'utf8');
  assert.match(deploy, /!line\.startsWith\('ACS_SANDBOX_LIFECYCLE_POLICY_MODE='\)/u);
  assert.match(deploy, /!line\.startsWith\('ACS_SANDBOX_LIFECYCLE_ENABLED='\)/u);
  assert.equal(deploy.match(/lines\.push\('ACS_SANDBOX_LIFECYCLE_ENABLED=true'\)/gu)?.length, 1);
  assert.equal(
    deploy.match(/lines\.push\('ACS_SANDBOX_LIFECYCLE_POLICY_MODE=enforce'\)/gu)?.length,
    1,
  );
  assert.match(deploy, /writeFileSync\(`\$\{envPath\}\.candidate`/u);
  assert.match(deploy, /renameSync\(`\$\{envPath\}\.candidate`, envPath\)/u);
  assert.match(deploy, /h\.lifecycle\?\.enabled !== true/u);
  assert.match(deploy, /h\.lifecyclePolicyMode !== 'enforce'/u);
  assert.match(
    deploy,
    /arm_deploy_rollback cleanup_acs_failure[\s\S]*h\.lifecyclePolicyMode !== 'enforce'[\s\S]*then\n    exit 20/u,
  );
});

test('workflow preserves exact retry matrices, locked rollback evidence, migrations, and acceptance boundaries', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const deploy = await readFile(deployPath, 'utf8');
  const buildRelease = await readFile(buildReleasePath, 'utf8');
  const phaseVerifier = await readFile(phaseVerifierPath, 'utf8');
  const acsUnit = await readFile(acsUnitPath, 'utf8');
  const serverUnit = await readFile(serverUnitPath, 'utf8');
  const workerUnit = await readFile(workerUnitPath, 'utf8');
  assert.match(workflow, /read-live-production-components\.mjs/u);
  assert.match(workflow, /promotion-config-identity-state\.mjs plan/u);
  assert.match(workflow, /legacy_api_requires_upgrade/u);
  assert.match(workflow, /\[ "\$legacy_api_requires_upgrade" = false \]/u);
  assert.equal(workflow.match(/config_identity_readback_stage=candidate-readback/gu)?.length, 1);
  assert.match(workflow, /\[ "\$api_action" = deploy \]/u);
  // Web 锁断言只检查发布步骤，避免命中其他 SSH 辅助函数。
  const webStep = workflow.slice(
    workflow.indexOf('- name: Publish Web entry last'),
    workflow.indexOf('- name: Persist Web operation receipt'),
  );
  assert.match(workflow, /scripts\/release\/read-live-production-components\.mjs/u);
  assert.match(
    buildRelease,
    /server\/daemon-packaging\/systemd\/agent-saas-server@\.service\.template/u,
  );
  assert.match(
    buildRelease,
    /server\/daemon-packaging\/systemd\/agent-saas-runtime-worker@\.service\.template/u,
  );
  assert.match(
    buildRelease,
    /acs-orchestrator\/daemon-packaging\/systemd\/agent-saas-acs-orchestrator\.service\.template/u,
  );
  assert.match(workflow, /target_match=false/u);
  assert.match(workflow, /production-before\.json[\s\S]*\.configIdentity\.releaseId/u);
  assert.match(workflow, /\.configIdentity\.releaseId/u);
  assert.match(workflow, /write-production-identity\.mjs/u);
  assert.match(workflow, /verify-installed-release\.mjs/u);
  assert.match(workflow, /separate_release/u);
  assert.doesNotMatch(workflow, /compatibilityEvidenceDigest|appAcsCompatibility/u);
  assert.match(workflow, /separate_confirmation_required/u);
  assert.match(workflow, /\boptional_staging_acceptance\b/u);
  assert.doesNotMatch(workflow, /businessAcceptanceEvidenceDigest|observationReportDigest/u);
  assert.match(workflow, /contractExecuted:false/u);
  assert.match(workflow, /restore_web_entry/u);
  assert.match(workflow, /rollback-attempted-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT-web/u);
  assert.match(workflow, /ROLLBACK_ATTEMPTED_MARKER='\$PROMOTION_REMOTE\/rollback-attempted-acs'/u);
  assert.match(workflow, /ROLLBACK_ATTEMPTED_MARKER='\$PROMOTION_REMOTE\/rollback-attempted-app'/u);
  assert.doesNotMatch(webStep, /^\s+aliyun --secure oss/mu);
  assert.match(webStep, /while kill -0 "\$command_pid"/u);
  assert.match(webStep, /kill -KILL -- "-\$command_pid"/u);
  assert.match(webStep, /run_control_ssh/u);
  assert.match(webStep, /web_lock_ready_confirmed/u);
  assert.match(webStep, /if ! web_lock_is_alive/u);
  assert.match(webStep, /web_lock_is_alive\n\s+web_committed=true/u);
  assert.match(webStep, /Web lock was lost; refusing an unlocked rollback/u);
  assert.match(webStep, /restore_web_entry \|\| rollback_status=\$\?/u);
  assert.match(
    webStep,
    /Web rollback failed; retaining the production lock until its lease expires/u,
  );
  assert.match(webStep, /wait "\$web_lock_pid" 2>\/dev\/null \|\| true/u);
  assert.doesNotMatch(webStep, /--region "\$RELEASE_RECORD_OSS_REGION" \|\| true/u);
  assert.match(workflow, /rollback_attempted=true/u);
  assert.doesNotMatch(
    workflow,
    /steps\.deploy_(?:acs|app|web)\.outcome[\s\S]{0,180}rollback_attempted=true/u,
  );
  assert.match(workflow, /Persist ACS operation receipt/u);
  assert.match(workflow, /Persist ACS operation start receipt/u);
  assert.match(workflow, /Persist API and Worker operation start receipts/u);
  assert.match(workflow, /Persist Web operation start receipt/u);
  assert.match(workflow, /Persist API and Worker operation receipts/u);
  assert.match(workflow, /Persist Web operation receipt/u);
  assert.match(workflow, /PROMOTION_STARTED=true/u);
  assert.match(workflow, /Record fail-closed outcome before production mutation/u);
  assert.match(workflow, /env\.PROMOTION_STARTED == 'true'/u);
  assert.match(deploy, /cleanup_app_failure/u);
  assert.match(deploy, /systemctl reset-failed "agent-saas-server@\$api_active"/u);
  assert.match(deploy, /cleanup_acs_failure/u);
  assert.match(deploy, /mark_rollback_attempted/u);
  assert.equal(deploy.match(/^[ ]{4}mark_rollback_attempted$/gmu)?.length, 1);
  assert.equal(deploy.match(/^[ ]{4}emit_rollback_attempted_sentinel$/gmu)?.length, 1);
  assert.match(deploy, /trap '' HUP INT TERM/u);
  assert.match(
    deploy,
    /AGENT_SAAS_ROLLBACK_ATTEMPTED PHASE=%s GITHUB_RUN_ID=%s GITHUB_RUN_ATTEMPT=%s/u,
  );
  assert.match(
    deploy,
    /agent-saas-app-rollback-\$release_id-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u,
  );
  assert.doesNotMatch(deploy, /\[ -e "\$env_backup" \] \|\| cp/u);
  assert.doesNotMatch(deploy, /\[ -e "\$identity_backup" \] \|\| cp/u);
  assert.match(deploy, /rollback_app_release/u);
  assert.match(deploy, /return 70/u);
  assert.match(deploy, /cleanup_acs_failure/u);
  assert.match(
    deploy,
    /rollback_acs_release\(\) \{[\s\S]*local rollback_status=0[\s\S]*return 70/u,
  );
  assert.match(
    deploy,
    /ACS deployment failed with status \$deploy_status; rollback status \$rollback_status/u,
  );
  assert.match(
    deploy,
    /if \[ "\$rollback_status" -ne 0 \]; then[\s\S]*exit "\$rollback_status"[\s\S]*fi\n  rm -rf "\$rollback_root"/u,
  );
  assert.match(deploy, /local had_previous_unit=false/u);
  assert.match(deploy, /if \[ -f "\$unit_path" \]; then[\s\S]*had_previous_unit=true/u);
  assert.match(
    deploy,
    /if \[ "\$had_previous_unit" = true \]; then[\s\S]*else[\s\S]*rm -f "\$unit_path"/u,
  );
  assert.match(phaseVerifier, /Production changed after promotion gate/u);
  assert.match(phaseVerifier, /PHASES\.slice\(0, phaseIndex\)/u);
  assert.match(phaseVerifier, /PHASES\.slice\(phaseIndex\)/u);
  assert.match(phaseVerifier, /candidates\.push\(structuredClone\(expected\)\)/u);
  assert.ok(deploy.indexOf('flock -n 9') < deploy.indexOf('node "$READ_LIVE_COMPONENTS_SCRIPT"'));
  assert.ok(deploy.indexOf('flock -n 9') < deploy.indexOf('touch "$WEB_LOCK_READY"'));
  assert.ok(
    deploy.indexOf('touch "$WEB_LOCK_READY"') <
      deploy.indexOf('while [ ! -f "$WEB_LOCK_RELEASE" ]'),
  );
  assert.ok(
    workflow.indexOf('test "$lock_ready" = true') <
      workflow.indexOf('aliyun --secure oss cp "$RUNNER_TEMP/web-assets/"'),
  );
  assert.ok(workflow.indexOf('web_committed=true') < workflow.indexOf('release_web_lock\n'));
  assert.ok(
    deploy.indexOf('node "$VERIFY_PROMOTION_PHASE_SCRIPT"') < deploy.indexOf('deploy_acs()'),
  );
  assert.ok(
    deploy.indexOf('trap cleanup_acs_failure EXIT') <
      deploy.indexOf('install -m 0644 "$ACS_UNIT_TEMPLATE" "$unit_path"'),
  );
  assert.ok(
    deploy.indexOf('trap cleanup_app_failure EXIT') <
      deploy.indexOf('install -m 0644 "$SERVER_UNIT_TEMPLATE" "$server_unit"'),
  );
  assert.doesNotMatch(deploy, /\.before-\$release_id/u);
  assert.match(deploy, /if \[ -L "\$ACS_CURRENT_PATH" \]; then/u);
  assert.match(deploy, /Existing ACS release path must be a symlink/u);
  assert.match(deploy, /Existing ACS managed unit must be absent or a regular file/u);
  assert.match(deploy, /systemctl daemon-reload \|\| rollback_status=1/u);
  assert.match(deploy, /systemctl restart "\$ACS_SERVICE_NAME" \|\| rollback_status=1/u);
  assert.doesNotMatch(
    deploy,
    /previous="\$\(readlink -f "\$ACS_CURRENT_PATH" 2>\/dev\/null \|\| true\)"/u,
  );
  assert.match(deploy, /verify --root "\$target" --component acs >\/dev\/null/u);
  assert.match(deploy, /verify --root "\$target" --component server >\/dev\/null/u);
  assert.match(deploy, /verify --root "\$target" --component server/u);
  assert.match(deploy, /releases\/\$artifact_digest/u);
  assert.match(deploy, /mkdir -p "\$target\/server\/data" "\$target\/workspace-shared"/u);
  assert.match(deploy, /validateCandidateReleaseReadiness/u);
  assert.match(deploy, /agent-saas-server-\$api_idle\.config-identity\.json/u);
  assert.doesNotMatch(deploy, /ready\.configIdentity/u);
  assert.match(
    deploy,
    /systemctl show "agent-saas-runtime-worker@\$color" --property Environment --value/u,
  );
  assert.match(deploy, /grep -Fx 'AGENT_SAAS_ENVIRONMENT=production'/u);
  assert.match(deploy, /runtime_data_root\/config-governance\/config\.lock/u);
  assert.match(deploy, /acquire_config_governance_fence \\\n\s+"\$\{AGENT_SAAS_RUNTIME_DATA_ROOT:-\/mnt\/agent-saas\/server-data\}"/u);
  assert.match(deploy, /Candidate App final API ConfigIdentity/u);
  assert.match(deploy, /Candidate App final Worker ConfigIdentity/u);
  assert.match(deploy, /Rollback Worker final ConfigIdentity/u);
  assert.match(deploy, /\[ "\$disable_status" -ne 0 \]/u);
  assert.match(deploy, /DEPLOY_APP_ROLLBACK_COMMITTED=true/u);
  assert.match(
    deploy,
    /systemctl disable --now "agent-saas-server@\$candidate_color"[\s\S]{0,240}systemctl is-active --quiet "agent-saas-server@\$candidate_color"/u,
  );
  assert.match(
    deploy,
    /agent-saas-server-\$api_active\.draining[\s\S]{0,240}systemctl restart "agent-saas-server@\$api_active"/u,
  );
  assert.match(
    deploy,
    /systemctl disable --now "agent-saas-runtime-worker@\$candidate_color"[\s\S]{0,240}systemctl is-active --quiet "agent-saas-runtime-worker@\$candidate_color"/u,
  );
  assert.match(deploy, /commit_rollback_api_authority "\$api_active" "\$api_idle"/u);
  assert.match(deploy, /restore_candidate_app_authority/u);
  assert.match(deploy, /app_committed=true/u);
  assert.match(
    deploy,
    /&& commit_app_active_colors "\$api_active" "\$worker_active" "\$api_idle"/u,
  );
  assert.match(deploy, /rollback_root\/nginx-upstream\.conf/u);
  assert.match(deploy, /nginx-candidate-upstream\.conf/u);
  assert.match(deploy, /had_nginx=false/u);
  assert.match(deploy, /rm -f "\$upstream"/u);
  assert.match(deploy, /exit 20/u);
  assert.doesNotMatch(deploy, /pnpm (?:install|build)/u);
  assert.match(acsUnit, /^User=root$/mu);
  assert.match(acsUnit, /^Group=root$/mu);
  assert.match(
    acsUnit,
    /^Environment=ACS_RELEASE_IDENTITY_FILE=\/etc\/agent-saas\/acs-release-identity\.json$/mu,
  );
  assert.match(
    serverUnit,
    /^BindPaths=\/mnt\/agent-saas\/server-data:\/opt\/agent-saas-app\/color\/%i\/server\/data$/mu,
  );
  assert.match(
    serverUnit,
    /^BindPaths=\/opt\/agent-saas\/workspace-shared:\/opt\/agent-saas-app\/color\/%i\/workspace-shared$/mu,
  );
  assert.match(
    workerUnit,
    /^BindPaths=\/mnt\/agent-saas\/server-data:\/opt\/agent-saas-app\/worker\/%i\/server\/data$/mu,
  );
  assert.match(
    workerUnit,
    /^BindPaths=\/opt\/agent-saas\/workspace-shared:\/opt\/agent-saas-app\/worker\/%i\/workspace-shared$/mu,
  );
  execFileSync('bash', ['-n', deployPath.pathname]);
});
