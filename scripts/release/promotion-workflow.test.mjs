import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertPromotionRetryable } from './assert-promotion-retry.mjs';
import { planPromotionConfigIdentityBaseline } from './promotion-config-identity-state.mjs';
import { reconcilePromotion } from './reconcile-promotion.mjs';

const workflowPath = new URL('../../.github/workflows/promote-release.yml', import.meta.url);
const rollbackRetryFixturePath = new URL(
  './fixtures/promotion-rollback-retry.json',
  import.meta.url,
);
const deployPath = new URL('./deploy-production-release.sh', import.meta.url);
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

test('promotion accepts only an approved release id and shares the production mutation lock', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /release_id:/u);
  assert.doesNotMatch(workflow, /^\s+(?:release_sha|artifact_url|image_tag):/mu);
  assert.match(workflow, /group: production-runtime/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /PRODUCTION_SSH_HOST_KEY_SHA256/u);
  assert.match(workflow, /RELEASE_ID_INPUT: \$\{\{ inputs\.release_id \}\}/u);
  assert.match(workflow, /\[\[ "\$RELEASE_ID_INPUT" =~ \^rc-/u);
  assert.match(workflow, /tr -d '\[:space:\]'/u);
  assert.doesNotMatch(workflow, /printf[^\n]*\$\{\{ inputs\./u);
  assert.match(workflow, /Latest release attestation is not approved|--state approved/u);
  assert.match(workflow, /deployments\/\$deployment_id\/statuses/u);
  assert.match(workflow, /actions\/runs\/\$staging_run_id/u);
  assert.match(workflow, /deterministic-deployment-gates-v1/u);
  assert.match(workflow, /verificationSummary/u);
  assert.doesNotMatch(workflow, /e2eRunId|e2eSummary|summarize-e2e/u);
  assert.match(workflow, /runtime_summary=/u);
  assert.match(workflow, /stagingRuntimeAssetsDigest/u);
  assert.match(workflow, /expected_runtime_summary/u);
  assert.match(workflow, /assert-promotion-retry\.mjs/u);
  assert.match(workflow, /retry-before-change:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT/u);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT/u);
  assert.match(workflow, /APPROVAL_RECORDED=true/u);
});

test('rolled-back App and Web failures require staging revalidation and reviewed retry_after_change', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const fixture = JSON.parse(await readFile(rollbackRetryFixturePath, 'utf8'));
  const approvalStart = workflow.indexOf(
    '- name: Validate deterministic Staging evidence and record human approval',
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
    '- name: Validate deterministic Staging evidence and record human approval',
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
    'aliyun --secure oss cp "$PRODUCTION_WEB_OSS_URI/release-identity.json"',
    'restore_web_entry() {',
    markerWrite,
    'trap cleanup_web_on_exit EXIT',
  ]);
  assert.ok(web.indexOf(markerWrite) < web.indexOf('trap cleanup_web_on_exit EXIT'));
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

test('all validation and prefetch precede mutation, then ACS, App, and Web converge in order', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  ordered(workflow, [
    '- name: Read authoritative production baseline before any write',
    'promotion-config-identity-state.mjs assert-write-gate',
    '- name: Prefetch and verify all selected artifacts',
    '- name: Mark and persist promotion started before any production write',
    '- name: Upload immutable deploy payload and managed units',
    '- name: Deploy exact ACS Orchestrator and Sandbox digest first',
    '- name: Deploy API blue-green and hand off Runtime Worker',
    '- name: Publish Web entry last and retain prior hashed assets',
  ]);
  assert.match(workflow, /components\.acs\.sandboxImageDigest/u);
  assert.match(workflow, /\.acsImage\.sourceSha/u);
  assert.match(workflow, /\.acsImage\.digest/u);
  assert.match(workflow, /\.acsImage\.reference/u);
  assert.match(workflow, /expected_repository@\$expected_image_digest/u);
  assert.doesNotMatch(workflow, /wait-for-acr-image\.sh/u);
  assert.doesNotMatch(workflow, /aliyun cr ListRepoTag/u);
  assert.doesNotMatch(workflow, /oss stat/u);
  assert.match(workflow, /PROMOTION_RETRY_MODE/u);
  assert.match(workflow, /PRODUCTION_ALREADY_TARGET/u);
  assert.match(workflow, /already equals the immutable target/u);
  assert.match(workflow, /read-live-production-components\.mjs/u);
  assert.match(workflow, /--recovery-mode "\$PROMOTION_RETRY_MODE"/u);
  assert.match(workflow, /identity_projection=/u);
  assert.doesNotMatch(workflow, /jq -S \.components "\$RUNNER_TEMP\/production-confirmed\.json"/u);
  assert.match(workflow, /sha256sum/u);
  assert.match(workflow, /built\/artifact-index\.json/u);
  assert.match(workflow, /built_base="\$RELEASE_RECORD_OSS_URI\/\$RELEASE_ID"/u);
  assert.match(workflow, /\.artifacts\[\] \| \.path/u);
  assert.doesNotMatch(workflow, /selected\/artifact-index\.json/u);
  assert.match(workflow, /release-identity\.json/u);
  assert.match(workflow, /web-oss-readback/u);
  assert.match(workflow, /keep without restart/u);
  assert.match(workflow, /optional_staging_acceptance/u);
  assert.doesNotMatch(workflow, /observe-production\.mjs|duration-ms 900000/u);
  assert.doesNotMatch(workflow, /PRODUCTION_OBSERVATION_(?:TOKEN|URL)/u);
  assert.doesNotMatch(workflow, /production-observation\.json/u);
  assert.doesNotMatch(workflow, /--clobber/u);
  assert.ok(runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\./u.test(line)));
});

test('workflow preserves partial matrices, rollback evidence, migrations, and acceptance boundaries', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const deploy = await readFile(deployPath, 'utf8');
  const acsUnit = await readFile(acsUnitPath, 'utf8');
  const serverUnit = await readFile(serverUnitPath, 'utf8');
  const workerUnit = await readFile(workerUnitPath, 'utf8');
  assert.match(workflow, /read-live-production-components\.mjs/u);
  assert.match(workflow, /promotion-config-identity-state\.mjs plan/u);
  assert.match(workflow, /legacy_api_requires_upgrade/u);
  assert.match(workflow, /\[ "\$legacy_api_requires_upgrade" = false \]/u);
  assert.equal(workflow.match(/config_identity_readback_stage=candidate-readback/gu)?.length, 1);
  assert.match(workflow, /\[ "\$api_action" = deploy \]/u);
  assert.match(workflow, /target_match=false/u);
  assert.match(workflow, /production-before\.json[\s\S]*\.configIdentity\.releaseId/u);
  assert.match(workflow, /\.configIdentity\.releaseId/u);
  assert.match(workflow, /write-production-identity\.mjs/u);
  assert.match(workflow, /verify-installed-release\.mjs/u);
  assert.match(workflow, /separate_release/u);
  assert.doesNotMatch(workflow, /compatibilityEvidenceDigest|appAcsCompatibility/u);
  assert.match(workflow, /separate_confirmation_required/u);
  assert.match(workflow, /optional_staging_acceptance/u);
  assert.doesNotMatch(workflow, /businessAcceptanceEvidenceDigest|observationReportDigest/u);
  assert.match(workflow, /contractExecuted:false/u);
  assert.match(workflow, /restore_web_entry/u);
  assert.match(workflow, /rollback-attempted-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT-web/u);
  assert.match(workflow, /ROLLBACK_ATTEMPTED_MARKER='\$PROMOTION_REMOTE\/rollback-attempted-acs'/u);
  assert.match(workflow, /ROLLBACK_ATTEMPTED_MARKER='\$PROMOTION_REMOTE\/rollback-attempted-app'/u);
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
    /acs-orchestrator\.env\.before-\$release_id-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u,
  );
  assert.match(
    deploy,
    /acs-release-identity\.json\.before-\$release_id-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u,
  );
  assert.match(
    deploy,
    /agent-saas-app-rollback-\$release_id-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u,
  );
  assert.doesNotMatch(deploy, /\[ -e "\$env_backup" \] \|\| cp/u);
  assert.doesNotMatch(deploy, /\[ -e "\$identity_backup" \] \|\| cp/u);
  assert.match(deploy, /if \[ -L \/opt\/agent-saas\/acs-current \]; then/u);
  assert.match(deploy, /Existing ACS release path must be a symlink/u);
  assert.doesNotMatch(
    deploy,
    /previous="\$\(readlink -f \/opt\/agent-saas\/acs-current 2>\/dev\/null \|\| true\)"/u,
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
  assert.match(deploy, /acquire_config_governance_fence \/mnt\/agent-saas\/server-data/u);
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
