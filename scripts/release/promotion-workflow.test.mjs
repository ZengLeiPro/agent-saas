import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../../.github/workflows/promote-release.yml', import.meta.url);
const confirmationWorkflowPath = new URL(
  '../../.github/workflows/confirm-expand-migration.yml',
  import.meta.url,
);
const deployPath = new URL('./deploy-production-release.sh', import.meta.url);
const attestationCliPath = new URL(
  '../../server/src/release/releaseAttestationCli.ts',
  import.meta.url,
);
const releaseDocsPath = new URL(
  '../../docs/agent-saas-GitHub测试预览与正式发布流程说明.md',
  import.meta.url,
);
const releaseConfigDocsPath = new URL(
  '../../docs/release-workflow-configuration.md',
  import.meta.url,
);
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
    const next = text.indexOf(marker, cursor + 1);
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
  assert.match(workflow, /retry-before-change:\$GITHUB_RUN_ID/u);
  assert.match(workflow, /APPROVAL_RECORDED=true/u);
  assert.match(workflow, /--arg releaseSha "\$RELEASE_SHA"/u);
  assert.match(workflow, /releaseSha:\$releaseSha/u);
  assert.match(workflow, /--arg migrationPhase "\$MIGRATION_PHASE"/u);
  assert.match(workflow, /migrationPhase:\$migrationPhase/u);
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

test('all validation and prefetch precede mutation, then ACS, App, and Web converge in order', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  ordered(workflow, [
    '- name: Read authoritative production baseline before any write',
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
  assert.match(workflow, /OSS attestation mirror/u);
  assert.match(workflow, /OSS operation mirror/u);
  assert.match(workflow, /PRODUCTION_ALREADY_TARGET/u);
  assert.match(workflow, /already equals the immutable target/u);
  assert.match(workflow, /read-live-production-components\.mjs/u);
  assert.match(
    workflow,
    /Read every live component[\s\S]*if: always\(\) && env\.PROMOTION_STARTED == 'true'/u,
  );
  assert.match(workflow, /steps\.deploy_acs\.outcome[^\n]*!= skipped/u);
  assert.match(workflow, /remote="\/tmp\/release-preflight-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u);
  const readbackBlock = workflow
    .split('Read every live component', 2)[1]
    .split('Reconcile component outcome', 1)[0];
  assert.doesNotMatch(readbackBlock, /mkdir -p|scp -i/u);
  assert.match(
    readbackBlock,
    /node '\$remote\/read-live-production-components\.mjs'[^\n]*\n[^\n]*production-after\.json/u,
  );
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
  assert.match(
    workflow,
    /GitHub Release is authoritative; retry OSS mirror maintenance separately/u,
  );
  assert.ok(runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\./u.test(line)));
});

test('workflow preserves partial matrices, rollback evidence, migrations, and acceptance boundaries', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const deploy = await readFile(deployPath, 'utf8');
  const acsUnit = await readFile(acsUnitPath, 'utf8');
  const serverUnit = await readFile(serverUnitPath, 'utf8');
  const workerUnit = await readFile(workerUnitPath, 'utf8');
  assert.match(workflow, /read-live-production-components\.mjs/u);
  assert.match(workflow, /target_match=false/u);
  assert.match(workflow, /steps\.readback\.outcome.*!= success/su);
  assert.match(workflow, /steps\.readback\.outputs\.target_match.*!= true/su);
  assert.match(workflow, /component convergence lacks a confirmed trusted production identity/u);
  assert.match(workflow, /write-production-identity\.mjs/u);
  assert.match(workflow, /verify-installed-release\.mjs/u);
  assert.match(workflow, /separate_release/u);
  assert.doesNotMatch(workflow, /compatibilityEvidenceDigest|appAcsCompatibility/u);
  assert.match(workflow, /separate_confirmation_required/u);
  assert.match(workflow, /awaiting_expand_confirmation/u);
  assert.match(workflow, /promoting:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT/u);
  assert.match(workflow, /migrationPlanDigest/u);
  assert.match(workflow, /productionBeforeDigest/u);
  assert.match(workflow, /productionTargetDigest/u);
  assert.match(workflow, /optional_staging_acceptance/u);
  assert.doesNotMatch(workflow, /businessAcceptanceEvidenceDigest|observationReportDigest/u);
  assert.match(workflow, /contractExecuted:false/u);
  assert.match(workflow, /restore_web_entry/u);
  assert.match(workflow, /rollback-web\.attempted/u);
  assert.match(workflow, /rollback-web\.succeeded/u);
  assert.match(workflow, /rollback-acs\.attempted/u);
  assert.match(workflow, /rollback-acs\.succeeded/u);
  assert.match(workflow, /rollback-app\.attempted/u);
  assert.match(workflow, /rollback-app\.succeeded/u);
  assert.doesNotMatch(workflow, /rollback-(?:acs|app)\.receipt/u);
  assert.match(workflow, /remote_receipt_exists\(\)/u);
  assert.match(workflow, /case "\$rc" in/u);
  assert.match(workflow, /remote rollback receipt query failed/u);
  assert.match(workflow, /return "\$rc"/u);
  assert.match(workflow, /rollback_receipts=/u);
  assert.match(workflow, /webAttempted.*webSucceeded/su);
  assert.match(workflow, /acsAttempted.*acsSucceeded/su);
  assert.match(workflow, /appAttempted.*appSucceeded/su);
  assert.match(workflow, /rollbackReceipts:\$rollbackReceipts/u);
  assert.doesNotMatch(workflow, /--argjson rollbackSucceeded/u);
  assert.match(workflow, /agent-saas-promotion-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u);
  assert.match(workflow, /release-preflight-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u);
  assert.doesNotMatch(workflow, /release-readback-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u);
  assert.match(deploy, /candidate-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u);
  assert.match(deploy, /rollback-\$release_id-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u);
  assert.match(deploy, /before-\$release_id-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u);
  assert.doesNotMatch(
    workflow,
    /steps\.deploy_(?:acs|app|web)\.outcome[^\n]*failure[\s\S]{0,180}rollback_attempted=true/u,
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
  assert.match(deploy, /cleanup_acs_failure/u);
  assert.match(deploy, /record_rollback_attempt/u);
  assert.match(deploy, /record_rollback_success/u);
  assert.match(deploy, /ROLLBACK_ATTEMPTED_RECEIPT_PATH/u);
  assert.match(deploy, /ROLLBACK_SUCCEEDED_RECEIPT_PATH/u);
  assert.ok(
    deploy.indexOf('record_rollback_attempt', deploy.indexOf('cleanup_acs_failure()')) <
      deploy.indexOf('ln -sfn "$previous"', deploy.indexOf('cleanup_acs_failure()')),
  );
  assert.ok(
    deploy.indexOf('record_rollback_attempt', deploy.indexOf('cleanup_app_failure()')) <
      deploy.indexOf('systemctl disable --now', deploy.indexOf('cleanup_app_failure()')),
  );
  assert.ok(
    deploy.indexOf('record_rollback_success', deploy.indexOf('cleanup_acs_failure()')) >
      deploy.indexOf(
        'curl -fsS http://127.0.0.1:3400/health',
        deploy.indexOf('cleanup_acs_failure()'),
      ),
  );
  assert.ok(
    deploy.indexOf('record_rollback_success', deploy.indexOf('cleanup_app_failure()')) >
      deploy.indexOf(
        "curl -kfsS -H 'Host: api.agent.kaiyan.net'",
        deploy.indexOf('cleanup_app_failure()'),
      ),
  );
  const appCleanupStart = deploy.indexOf('cleanup_app_failure()');
  const appCleanupEnd = deploy.indexOf('trap cleanup_app_failure EXIT', appCleanupStart);
  const appCleanup = deploy.slice(appCleanupStart, appCleanupEnd);
  const workerDrainStart = deploy.indexOf(
    'install -m 0644 /dev/null "/run/agent-saas-runtime-worker-$worker_active.draining"',
  );
  const apiDrainStart = deploy.indexOf(
    'install -m 0644 /dev/null "/run/agent-saas-server-$api_active.draining"',
  );
  assert.ok(workerDrainStart > appCleanupEnd && apiDrainStart > workerDrainStart);
  assert.match(
    appCleanup,
    /rm -f[\s\S]*agent-saas-server-\$api_active\.draining[\s\S]*agent-saas-runtime-worker-\$worker_active\.draining/u,
  );
  assert.match(appCleanup, /systemctl restart "agent-saas-server@\$api_active"/u);
  assert.match(appCleanup, /systemctl restart "agent-saas-runtime-worker@\$worker_active"/u);
  assert.match(appCleanup, /api-active-ready\.json/u);
  assert.match(appCleanup, /worker_rollback_pid.*worker_rollback_ready/su);
  assert.match(appCleanup, /test ! -e "\/run\/agent-saas-server-\$api_active\.draining"/u);
  assert.match(
    appCleanup,
    /test ! -e "\/run\/agent-saas-runtime-worker-\$worker_active\.draining"/u,
  );
  const previousApiRestart = appCleanup.indexOf(
    'systemctl restart "agent-saas-server@$api_active"',
  );
  const nginxRestore = appCleanup.indexOf('cp -a "$rollback_root/nginx-upstream.conf"');
  const candidateApiStop = appCleanup.indexOf(
    'systemctl disable --now "agent-saas-server@$api_idle"',
  );
  assert.ok(previousApiRestart >= 0 && nginxRestore > previousApiRestart);
  assert.ok(candidateApiStop > nginxRestore);
  assert.ok(appCleanup.indexOf('record_rollback_success') > candidateApiStop);
  assert.ok(
    workflow.indexOf('rollback-web.attempted', workflow.indexOf('restore_web_entry()')) <
      workflow.indexOf('aliyun --secure oss cp', workflow.indexOf('restore_web_entry()')),
  );
  assert.ok(
    workflow.indexOf(
      'cmp "$RUNNER_TEMP/web-before/index.html"',
      workflow.indexOf('restore_web_entry()'),
    ) < workflow.indexOf('rollback-web.succeeded', workflow.indexOf('restore_web_entry()')),
  );
  assert.match(deploy, /acs_mutation_started=true/u);
  assert.match(deploy, /app_mutation_started=true/u);
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
  assert.match(deploy, /r\.environment !== 'production'/u);
  assert.match(
    deploy,
    /systemctl show "agent-saas-runtime-worker@\$worker_idle" --property Environment --value/u,
  );
  assert.match(deploy, /grep -Fx 'AGENT_SAAS_ENVIRONMENT=production'/u);
  assert.match(deploy, /app_committed=true/u);
  assert.match(deploy, /printf '%s\\n' "\$api_active" >\/etc\/agent-saas\/active-color/u);
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

test('expand confirmation is a separate release-bound and production-serialized workflow', async () => {
  const [workflow, attestationCli, releaseDocs, releaseConfigDocs] = await Promise.all([
    readFile(confirmationWorkflowPath, 'utf8'),
    readFile(attestationCliPath, 'utf8'),
    readFile(releaseDocsPath, 'utf8'),
    readFile(releaseConfigDocsPath, 'utf8'),
  ]);
  assert.match(workflow, /name: 确认扩展迁移/u);
  assert.match(workflow, /name: 校验确认请求/u);
  assert.match(workflow, /group: production-runtime\s+cancel-in-progress: false/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /release_id:/u);
  assert.match(workflow, /attestation-snapshot\.mjs select/u);
  assert.match(workflow, /confirm-expand-migration\.mjs/u);
  assert.match(workflow, /REFRESH_CONFIRMATION_WINDOW/u);
  assert.match(workflow, /expand-reobservation:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT/u);
  assert.match(workflow, /status:"confirmation_window_refreshed"/u);
  assert.match(workflow, /Refresh expired confirmation window with an immutable attestation/u);
  ordered(workflow, [
    'expand-reobservation:$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT',
    'upload-github-release-asset-immutable.sh',
    'Read production components and verify migration confirmation binding',
  ]);
  assert.match(workflow, /read-live-production-components\.mjs/u);
  assert.match(workflow, /production-api-ready\.json/u);
  assert.match(workflow, /upload-oss-object-immutable\.sh[\s\S]*--state completed/u);
  assert.match(workflow, /Release was already confirmed by another workflow run/u);
  assert.doesNotMatch(workflow, /--state completed[\s\S]*migration-confirmations\/confirmation-/u);
  assert.match(workflow, /--api-ready/u);
  assert.match(workflow, /--state completed/u);
  assert.match(workflow, /expand-confirmation:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT/u);
  assert.match(workflow, /migration-confirmations\/\$\{confirmation_digest#sha256:\}\.json/u);
  assert.match(workflow, /api\.agent\.kaiyan\.net\/api\/healthz\/ready/u);
  ordered(workflow, [
    '先按内容 digest 持久化独立读回',
    '--state completed',
    'GitHub Release 是重跑读取源',
    'upload-github-release-asset-immutable.sh',
  ]);
  assert.match(workflow, /--confirmation-evidence/u);
  assert.match(attestationCli, /confirmation-evidence/u);
  assert.match(attestationCli, /currentState === 'awaiting_expand_confirmation'/u);
  assert.match(attestationCli, /confirmationEvidenceDigest !== evidenceDigest/u);
  assert.match(releaseDocs, /GitHub 上六个 Workflow/u);
  assert.match(releaseDocs, /`Confirm Expand Migration`/u);
  assert.match(releaseDocs, /2 小时确认窗口和 5 分钟现场\/证据新鲜度/u);
  assert.match(releaseDocs, /psql 反斜杠元命令均拒绝/u);
  assert.match(releaseDocs, /全部 INSERT/u);
  assert.match(releaseDocs, /未自愿标 metadata 也会先进入闭包/u);
  assert.match(releaseDocs, /expand-reobservation/u);
  assert.match(releaseConfigDocs, /target_match=true/u);
  assert.match(releaseConfigDocs, /identity 写入或 `production-confirmed\.json` 回读失败/u);
  assert.match(releaseConfigDocs, /producer 仅用写 Token/u);
  assert.match(releaseConfigDocs, /publisher 仅用读 Token/u);
  assert.doesNotMatch(releaseConfigDocs, /准备发布证据` 只持有读身份/u);
  assert.match(workflow, /CONFIRMATION_REPAIR=true/u);
  assert.match(workflow, /Repair OSS attestation mirror/u);
  assert.doesNotMatch(workflow, /--clobber/u);
  assert.ok(runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\./u.test(line)));
});

test('App cleanup after Worker drain restarts the previous API and Worker before success receipt', async () => {
  const deploy = await readFile(deployPath, 'utf8');
  const cleanupStart = deploy.indexOf('cleanup_app_failure()');
  const cleanupEnd = deploy.indexOf('trap cleanup_app_failure EXIT', cleanupStart);
  const cleanup = deploy.slice(cleanupStart, cleanupEnd);
  const workerDrain = deploy.indexOf(
    'install -m 0644 /dev/null "/run/agent-saas-runtime-worker-$worker_active.draining"',
    cleanupEnd,
  );
  const apiDrain = deploy.indexOf(
    'install -m 0644 /dev/null "/run/agent-saas-server-$api_active.draining"',
    workerDrain,
  );
  assert.ok(workerDrain > cleanupEnd && apiDrain > workerDrain);
  assert.ok(cleanup.indexOf('agent-saas-runtime-worker-$worker_active.draining') >= 0);
  assert.ok(cleanup.indexOf('systemctl restart "agent-saas-runtime-worker@$worker_active"') >= 0);
  assert.ok(cleanup.indexOf('worker_rollback_pid') >= 0);
  assert.ok(cleanup.indexOf('worker_rollback_ready') >= 0);
  assert.ok(cleanup.indexOf('record_rollback_success') > cleanup.indexOf('sleep 2'));
});
