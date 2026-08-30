import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../../.github/workflows/promote-release.yml', import.meta.url);
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

test('promotion accepts only an approved release id and serializes production mutation', async () => {
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
  assert.match(workflow, /\.acsImage\.sourceSha/u);
  assert.match(workflow, /\.acsImage\.digest/u);
  assert.match(workflow, /\.acsImage\.reference/u);
  assert.match(workflow, /expected_repository@\$expected_image_digest/u);
  assert.doesNotMatch(workflow, /release\/wait-for-acr-image\.sh/u);
  assert.doesNotMatch(workflow, /aliyun cr ListRepoTag/u);
  assert.match(workflow, /run_with_web_lock aliyun --secure oss stat/u);
  assert.match(workflow, /PROMOTION_RETRY_MODE/u);
  assert.match(workflow, /--arg recoveryMode "\$PROMOTION_RETRY_MODE"/u);
  assert.match(workflow, /prior post-mutation recovery remains required/u);
  assert.match(workflow, /PRODUCTION_ALREADY_TARGET/u);
  assert.match(workflow, /--state failed_before_change/u);
  assert.match(workflow, /already equals the immutable target/u);
  assert.match(workflow, /scripts\/release\/read-live-production-components\.mjs/u);
  assert.match(workflow, /--recovery-mode "\$PROMOTION_RETRY_MODE"/u);
  assert.match(workflow, /identity_projection=/u);
  assert.doesNotMatch(workflow, /jq -S \.components "\$RUNNER_TEMP\/production-confirmed\.json"/u);
  assert.match(workflow, /\.acsImage\.digest "\$RUNNER_TEMP\/built\/artifact-index\.json"/u);
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
  assert.match(workflow, /reader=read-production-state\.mjs/u);
  assert.match(
    workflow,
    /\[ "\$PROMOTION_RETRY_MODE" = retry_after_change \] && reader=read-live-production-components\.mjs/u,
  );
  assert.match(workflow, /node '\$remote\/\$reader' --output '\$remote\/production-before\.json/u);
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

test('workflow preserves exact retry matrices, locked rollback evidence, migrations, and acceptance boundaries', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const deploy = await readFile(deployPath, 'utf8');
  const buildRelease = await readFile(buildReleasePath, 'utf8');
  const phaseVerifier = await readFile(phaseVerifierPath, 'utf8');
  const acsUnit = await readFile(acsUnitPath, 'utf8');
  const serverUnit = await readFile(serverUnitPath, 'utf8');
  const workerUnit = await readFile(workerUnitPath, 'utf8');
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
  assert.match(workflow, /write-production-identity\.mjs/u);
  assert.match(workflow, /verify-installed-release\.mjs/u);
  assert.match(workflow, /separate_release/u);
  assert.doesNotMatch(workflow, /compatibilityEvidenceDigest|appAcsCompatibility/u);
  assert.match(workflow, /separate_confirmation_required/u);
  assert.match(workflow, /\boptional_staging_acceptance\b/u);
  assert.doesNotMatch(workflow, /businessAcceptanceEvidenceDigest|observationReportDigest/u);
  assert.match(workflow, /contractExecuted:false/u);
  assert.match(workflow, /restore_web_entry/u);
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
  assert.match(deploy, /r\.environment !== 'production'/u);
  assert.match(
    deploy,
    /systemctl show "agent-saas-runtime-worker@\$worker_idle" --property Environment --value/u,
  );
  assert.match(deploy, /grep -Fx 'AGENT_SAAS_ENVIRONMENT=production'/u);
  assert.match(deploy, /app_committed=true/u);
  assert.match(
    deploy,
    /printf '%s\\n' "\$api_active" >"\$ACTIVE_COLOR_PATH" \|\| rollback_status=1/u,
  );
  assert.match(deploy, /rollback_root\/nginx-upstream\.conf/u);
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
