import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertPromotionRetryable } from './assert-promotion-retry.mjs';
import { planPromotionConfigIdentityBaseline } from './promotion-config-identity-state.mjs';
import { reconcilePromotion } from './reconcile-promotion.mjs';
import { verifyPromotionAcsSelection } from './verify-promotion-acs-selection.mjs';

const workflowPath = new URL('../../.github/workflows/promote-release.yml', import.meta.url);
const confirmationWorkflowPath = new URL('./finalize-expand-migration.sh', import.meta.url);
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

function productionWebEntrypoints(workflow) {
  return workflow
    .split('\n')
    .filter(
      (line) =>
        line.includes('sudo PHASE=web ') &&
        line.includes("bash '$PROMOTION_REMOTE/deploy-production-release.sh'"),
    );
}

test('durable promoting marker interruptions always converge through needs_human', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const approvalStep = workflow.slice(
    workflow.indexOf('- name: 以失败关闭方式复核确定性测试环境证据并记录人工批准'),
    workflow.indexOf('- name: 配置生产环境 SSH'),
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
    workflow.indexOf('- name: 生产写入前标记并持久化发布已开始状态'),
    workflow.indexOf('- name: 创建 GitHub 生产部署记录'),
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
  assert.match(workflow, /^name: Release · 发布到生产环境$/mu);
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
  assert.match(workflow, /--arg releaseSha "\$RELEASE_SHA"/u);
  assert.match(workflow, /releaseSha:\$releaseSha/u);
  assert.match(workflow, /--arg migrationPhase "\$MIGRATION_PHASE"/u);
  assert.match(workflow, /migrationPhase:\$migrationPhase/u);
});

test('Web rollback marker is written only by the armed restore path', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const start = workflow.indexOf('- name: 最后发布 Web 入口并保留旧版哈希资源');
  const end = workflow.indexOf('- name: 持久化 Web 操作回执', start);
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
        ? '- name: 优先部署精确的 ACS 编排器与沙箱摘要'
        : '- name: 蓝绿部署 API 并交接运行时 Worker',
    );
    const end = workflow.indexOf(
      phase === 'acs'
        ? '- name: 持久化 ACS 操作回执'
        : '- name: 持久化 API 与 Worker 操作回执',
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

test('reconcile derives strict ACS/App/Web rollback receipts', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const start = workflow.indexOf('- name: 核对组件结果');
  const end = workflow.indexOf('- name: 记录真实最终结果', start);
  const reconcile = workflow.slice(start, end);
  assert.match(reconcile, /rollback-web\.attempted/u);
  assert.match(reconcile, /rollback-web\.succeeded/u);
  assert.match(reconcile, /remote_receipt_exists/u);
  assert.match(reconcile, /rollback-acs\.attempted/u);
  assert.match(reconcile, /rollback-acs\.succeeded/u);
  assert.match(reconcile, /rollback-app\.attempted/u);
  assert.match(reconcile, /rollback-app\.succeeded/u);
  assert.match(reconcile, /rollback_receipts=/u);
  assert.match(reconcile, /rollbackReceipts:\$rollbackReceipts/u);
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
  ]);
  assert.match(
    workflow,
    /agent-saas-promotion-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT-identity-lock\.ready/u,
  );
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
    '- name: 读取全部在线组件并仅在完全收敛后提交可信身份',
  );
  const end = workflow.indexOf('- name: 核对组件结果', start);
  assert.ok(start >= 0 && end > start, 'readback step must be present');
  const readback = workflow.slice(start, end);
  assert.match(
    readback,
    /config_identity_projection='\.configIdentity \| \{schemaVersion,status,expected,observed,releaseId\}'/u,
  );
  ordered(readback, [
    'test "$(jq -r .configIdentity.releaseId "$RUNNER_TEMP/production-after.json")" = "$expected_config_release_id"',
    'write-production-identity.mjs',
    "read-production-state.mjs' --config-identity-stage steady-state",
    'test "$(jq -r .configIdentity.status "$RUNNER_TEMP/production-confirmed.json")" = consistent',
    'test "$(jq -r .configIdentity.releaseId "$RUNNER_TEMP/production-confirmed.json")" =',
    'config_identity_projection=',
    '<(jq -S "$config_identity_projection" "$RUNNER_TEMP/production-confirmed.json")',
    '<(jq -S "$config_identity_projection" "$RUNNER_TEMP/production-after.json")',
  ]);

  const reconcileEnd = workflow.indexOf('- name: 记录真实最终结果', end);
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

test('final outcome preserves fail-closed reconciliation and trusted identity evidence', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const start = workflow.indexOf('- name: 记录真实最终结果');
  const end = workflow.indexOf(
    '- name: 在生产变更前记录失败关闭结果',
    start,
  );
  assert.ok(start >= 0 && end > start, 'final outcome step must be present');
  const finalOutcome = workflow.slice(start, end);
  ordered(finalOutcome, [
    'outcome=needs_human',
    'outcome="$(jq -r .outcome "$RUNNER_TEMP/reconcile.json")"',
    'if [ "$outcome" = completed ]',
    'component convergence lacks one or more durable operation receipts',
    'component convergence lacks a confirmed trusted production identity',
    '--state "$outcome"',
    'state=failure',
    'case "$outcome" in completed) state=success ;; awaiting_expand_confirmation) state=in_progress ;; esac',
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
    '- name: 以失败关闭方式复核确定性测试环境证据并记录人工批准',
    '- name: 写入前读取权威在线生产前缀',
    '- name: 预取、校验并安全解压清单选定产物与 ACS 身份',
    '- name: 生产写入前标记并持久化发布已开始状态',
    '- name: 上传不可变部署载荷与 RC 绑定的托管单元',
    '- name: 优先部署精确的 ACS 编排器与沙箱摘要',
    '- name: 蓝绿部署 API 并交接运行时 Worker',
    '- name: 最后发布 Web 入口并保留旧版哈希资源',
  ]);
  assert.match(workflow, /components\.acs\.sandboxImageDigest/u);
  assert.match(workflow, /verify-promotion-acs-selection\.mjs/u);
  assert.match(workflow, /"\$RUNNER_TEMP\/built\/artifact-index\.json"/u);
  assert.doesNotMatch(workflow, /release\/wait-for-acr-image\.sh/u);
  assert.doesNotMatch(workflow, /aliyun cr ListRepoTag/u);
  assert.match(workflow, /run_with_web_lock aliyun --secure oss ls/u);
  assert.doesNotMatch(workflow, /run_with_web_lock aliyun --secure oss stat/u);
  assert.match(workflow, /PROMOTION_RETRY_MODE/u);
  assert.match(workflow, /OSS attestation mirror/u);
  assert.match(workflow, /OSS operation mirror/u);
  assert.match(workflow, /--arg recoveryMode "\$PROMOTION_RETRY_MODE"/u);
  assert.match(workflow, /prior post-mutation recovery remains required/u);
  assert.match(workflow, /previous promotion ended after the durable promoting marker/u);
  assert.match(workflow, /--state needs_human --operation "recover-promoting:/u);
  assert.match(workflow, /PRODUCTION_ALREADY_TARGET/u);
  assert.match(workflow, /--state failed_before_change/u);
  assert.match(workflow, /already equals the immutable target/u);
  assert.match(workflow, /read-live-production-components\.mjs/u);
  assert.match(
    workflow,
    /读取全部在线组件并仅在完全收敛后提交可信身份[\s\S]*if: [^\n]*always\(\) && env\.PROMOTION_STARTED == 'true'/u,
  );
  assert.match(workflow, /steps\.deploy_acs\.outcome[^\n]*!= skipped/u);
  const readbackBlock = workflow
    .split('读取全部在线组件并仅在完全收敛后提交可信身份', 2)[1]
    .split('核对组件结果', 1)[0];
  assert.match(readbackBlock, /remote="\$PROMOTION_REMOTE"/u);
  assert.doesNotMatch(readbackBlock, /release-preflight-/u);
  assert.doesNotMatch(readbackBlock, /mkdir -p|scp -i/u);
  assert.match(
    readbackBlock,
    /\/tmp\/agent-saas-promotion-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT-identity-lock\.ready/u,
  );
  assert.doesNotMatch(readbackBlock, /\$PROMOTION_REMOTE\/identity-lock/u);
  assert.match(readbackBlock, /WEB_LOCK_TIMEOUT_SECONDS=900/u);
  assert.match(readbackBlock, /PHASE=web/u);
  assert.match(readbackBlock, /trap cleanup_identity_lock EXIT/u);
  assert.match(readbackBlock, /run_identity_ssh\(\)/u);
  assert.match(
    readbackBlock,
    /sudo node '\$remote\/read-live-production-components\.mjs'[^\n]*\n[^\n]*production-after\.json/u,
  );
  assert.ok(
    readbackBlock.indexOf("read-live-production-components.mjs'") <
      readbackBlock.indexOf("write-production-identity.mjs'"),
  );
  assert.ok(
    readbackBlock.indexOf("write-production-identity.mjs'") <
      readbackBlock.indexOf("read-production-state.mjs'"),
  );
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
  assert.match(workflow, /校验 OSS 中的不可变清单、产物索引与 Release 记录/u);
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
  assert.match(
    workflow,
    /reader_stage="\$\(printf '%s' "\$baseline_plan" \| jq -r \.configIdentityStage\)"/u,
  );
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
  assert.match(workflow, /release-preflight-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/u);
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
  assert.match(
    workflow,
    /GitHub Release is authoritative; retry OSS mirror maintenance separately/u,
  );
  assert.ok(runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\./u.test(line)));
});

test('both Production Web shell entrypoints satisfy the real deploy script parameter contract', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const entrypoints = productionWebEntrypoints(workflow);
  assert.equal(entrypoints.length, 2);
  const values = {
    PHASE: 'web',
    RELEASE_DIR: '/nonexistent/release',
    MANIFEST_PATH: '/nonexistent/manifest.json',
    EXPECTED_MANIFEST_DIGEST: `sha256:${'a'.repeat(64)}`,
    VERIFY_INSTALLED_SCRIPT: '/nonexistent/verify-installed-release.mjs',
    READ_LIVE_COMPONENTS_SCRIPT: '/nonexistent/read-live-production-components.mjs',
    VERIFY_PROMOTION_PHASE_SCRIPT: '/nonexistent/verify-promotion-phase-state.mjs',
    WEB_LOCK_READY: '/tmp/agent-saas-promotion-test-ready',
    WEB_LOCK_RELEASE: '/tmp/agent-saas-promotion-test-release',
    WEB_LOCK_TIMEOUT_SECONDS: '1',
    GITHUB_RUN_ID: '123456',
    GITHUB_RUN_ATTEMPT: '2',
  };
  for (const entrypoint of entrypoints) {
    const lockValues = [...entrypoint.matchAll(/WEB_LOCK_(READY|RELEASE)='\$(\w+)'/gu)];
    assert.equal(lockValues.length, 2);
    const assignments = lockValues.map(([, , variable]) => {
      const line = workflow.split('\n').find((line) => line.trimStart().startsWith(variable + '='));
      assert.ok(line, variable);
      return line.trim();
    });
    const resolveLocks = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          ...assignments,
          ...lockValues.map(([, , variable]) => "printf '%s\\n' \"$" + variable + '"'),
        ].join('\n'),
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, ...values, PROMOTION_REMOTE: '/tmp/agent-saas-promotion-123456-2' },
      },
    );
    assert.equal(resolveLocks.status, 0, resolveLocks.stderr);
    const paths = resolveLocks.stdout.trim().split('\n');
    const actualValues = { ...values };
    lockValues.forEach(([, key], index) => {
      actualValues['WEB_LOCK_' + key] = paths[index];
    });
    const assigned = new Set(
      [...entrypoint.matchAll(/\b([A-Z][A-Z0-9_]*)=(?:'[^']*'|web)(?=\s|$)/gu)].map(
        (match) => match[1],
      ),
    );
    const env = { ...process.env };
    for (const [key, value] of Object.entries(actualValues))
      if (assigned.has(key)) env[key] = value;
    const result = spawnSync('bash', [deployPath.pathname], { encoding: 'utf8', env });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(
      result.stderr,
      /(?:PHASE|RELEASE_DIR|MANIFEST_PATH|EXPECTED_MANIFEST_DIGEST|VERIFY_INSTALLED_SCRIPT|READ_LIVE_COMPONENTS_SCRIPT|VERIFY_PROMOTION_PHASE_SCRIPT|WEB_LOCK_READY|WEB_LOCK_RELEASE|GITHUB_RUN_ID|GITHUB_RUN_ATTEMPT) is required/u,
    );
    assert.match(result.stderr, /Cannot find module|MODULE_NOT_FOUND/u);
  }
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
  assert.match(workflow, /assert-write-gate/u);
  assert.doesNotMatch(workflow, /legacy_api_requires_upgrade/u);
  assert.equal(workflow.match(/config_identity_readback_stage=candidate-readback/gu)?.length, 1);
  assert.match(workflow, /\[ "\$api_action" = deploy \]/u);
  // Web 锁断言只检查发布步骤，避免命中其他 SSH 辅助函数。
  const webStep = workflow.slice(
    workflow.indexOf('- name: 最后发布 Web 入口并保留旧版哈希资源'),
    workflow.indexOf('- name: 持久化 Web 操作回执'),
  );
  assert.equal(webStep.match(/cleanup_web_on_exit\(\)/gu)?.length, 1);
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
  assert.match(workflow, /steps\.readback\.outcome.*!= success/su);
  assert.match(workflow, /steps\.readback\.outputs\.target_match.*!= true/su);
  assert.match(workflow, /component convergence lacks a confirmed trusted production identity/u);
  assert.match(workflow, /write-production-identity\.mjs/u);
  assert.match(workflow, /verify-installed-release\.mjs/u);
  assert.match(workflow, /promotion-upload\.tgz/u);
  assert.match(workflow, /archive_digest="\$\(sha256sum/u);
  assert.match(
    workflow,
    /root_archive="\/run\/agent-saas-locks\/promotion-payload-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT\.tgz"/u,
  );
  assert.match(workflow, /sudo install -m 0400 '\$remote_archive' '\$root_archive'/u);
  assert.match(workflow, /sudo sha256sum '\$root_archive'/u);
  assert.match(workflow, /sudo install -d -m 0700 '\$remote'/u);
  assert.match(workflow, /sudo tar --no-same-owner --no-same-permissions/u);
  assert.match(workflow, /sudo chown -R root:root '\$remote'/u);
  assert.match(workflow, /sudo chmod -R a-w '\$remote'/u);
  assert.match(workflow, /sudo rm -rf '\$remote' '\$root_archive'/u);
  assert.match(workflow, /rm -f '\$remote_archive'/u);
  assert.match(workflow, /separate_release/u);
  assert.doesNotMatch(workflow, /compatibilityEvidenceDigest|appAcsCompatibility/u);
  assert.match(workflow, /automatic_readback_required/u);
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
  assert.doesNotMatch(
    workflow,
    /steps\.deploy_(?:acs|app|web)\.outcome[^\n]*failure[\s\S]{0,180}rollback_attempted=true/u,
  );
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
  assert.match(workflow, /持久化 ACS 操作回执/u);
  assert.match(workflow, /持久化 ACS 操作开始回执/u);
  assert.match(workflow, /持久化 API 与 Worker 操作开始回执/u);
  assert.match(workflow, /持久化 Web 操作开始回执/u);
  assert.match(workflow, /持久化 API 与 Worker 操作回执/u);
  assert.match(workflow, /持久化 Web 操作回执/u);
  assert.match(workflow, /PROMOTION_STARTED=true/u);
  assert.match(workflow, /在生产变更前记录失败关闭结果/u);
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
  assert.match(deploy, /cleanup_acs_failure/u);
  assert.match(deploy, /record_rollback_attempt/u);
  assert.match(deploy, /record_rollback_success/u);
  assert.match(deploy, /ROLLBACK_ATTEMPTED_RECEIPT_PATH/u);
  assert.match(deploy, /ROLLBACK_SUCCEEDED_RECEIPT_PATH/u);
  assert.match(deploy, /return 70/u);
  const acsRollbackStart = deploy.indexOf('rollback_acs_release()');
  const acsRollbackEnd = deploy.indexOf('cleanup_acs_failure()', acsRollbackStart);
  const acsRollback = deploy.slice(acsRollbackStart, acsRollbackEnd);
  assert.ok(
    acsRollback.indexOf('record_rollback_attempt') < acsRollback.indexOf('ln -sfn "$previous"'),
  );
  assert.ok(
    acsRollback.indexOf('record_rollback_success') >
      acsRollback.indexOf('curl -fsS http://127.0.0.1:3400/health'),
  );
  assert.match(
    deploy,
    /ACS deployment failed with status \$deploy_status; rollback status \$rollback_status/u,
  );
  assert.match(
    deploy,
    /if \[ "\$rollback_status" -ne 0 \]; then[\s\S]*exit "\$rollback_status"[\s\S]*fi\n  rm -rf "\$rollback_root"/u,
  );
  assert.match(deploy, /local had_previous_identity=false had_previous_unit=false/u);
  assert.match(deploy, /if \[ -f "\$unit_path" \]; then[\s\S]*had_previous_unit=true/u);
  assert.match(
    acsRollback,
    /if \[ "\$had_previous_unit" = true \]; then[\s\S]*else[\s\S]*rm -f "\$unit_path"/u,
  );
  const appRollbackStart = deploy.indexOf('rollback_app_release()');
  const appRollbackEnd = deploy.indexOf('cleanup_app_failure()', appRollbackStart);
  const appRollback = deploy.slice(appRollbackStart, appRollbackEnd);
  assert.ok(
    appRollback.indexOf('record_rollback_attempt') <
      appRollback.indexOf('cp -a "$rollback_root/api.release.env"'),
  );
  assert.doesNotMatch(
    appRollback,
    /systemctl (?:restart|enable|disable)|nginx -t|commit_app_active_colors/u,
  );

  const appDeployStart = deploy.indexOf('deploy_app() {');
  const appCleanupStart = deploy.indexOf('  cleanup_app_failure() {', appDeployStart);
  const appCleanupEnd = deploy.indexOf(
    '  arm_deploy_rollback cleanup_app_failure',
    appCleanupStart,
  );
  const appCleanup = deploy.slice(appCleanupStart, appCleanupEnd);
  const oldApiRestart = appCleanup.indexOf('systemctl restart "agent-saas-server@$api_active"');
  const rollbackWorkerCall = appCleanup.indexOf('commit_rollback_worker_authority');
  const rollbackApiCall = appCleanup.indexOf('commit_rollback_api_authority');
  const atomicMarkerCommit = appCleanup.indexOf('commit_app_active_colors');
  const successReceipt = appCleanup.lastIndexOf('record_rollback_success');
  assert.ok(oldApiRestart > appCleanup.indexOf('rollback_app_release'));
  assert.ok(rollbackWorkerCall > oldApiRestart);
  assert.ok(rollbackApiCall > rollbackWorkerCall);
  assert.ok(atomicMarkerCommit > rollbackApiCall);
  assert.ok(successReceipt > atomicMarkerCommit);
  assert.match(appCleanup, /transaction_rollback_status=70/u);
  assert.match(appCleanup, /app_candidate_restored/u);
  assert.match(appCleanup, /app_old_compensated/u);

  const workerRollbackStart = deploy.indexOf('commit_rollback_worker_authority() {');
  const workerRollbackEnd = deploy.indexOf('restore_candidate_worker_authority() {');
  const workerRollback = deploy.slice(workerRollbackStart, workerRollbackEnd);
  assert.match(workerRollback, /systemctl restart "agent-saas-runtime-worker@\$active_color"/u);
  assert.match(
    workerRollback,
    /systemctl disable --now "agent-saas-runtime-worker@\$candidate_color"/u,
  );
  assert.ok(
    workerRollback.indexOf('Rollback Worker final ConfigIdentity') <
      workerRollback.indexOf('commit_worker_active_color'),
  );

  const apiRollbackStart = deploy.indexOf('commit_rollback_api_authority() {');
  const apiRollbackEnd = deploy.indexOf('restore_candidate_api_authority() {');
  const apiRollback = deploy.slice(apiRollbackStart, apiRollbackEnd);
  assert.match(apiRollback, /nginx -t/u);
  assert.match(apiRollback, /systemctl disable --now "agent-saas-server@\$candidate_color"/u);
  assert.ok(
    apiRollback.indexOf('Rollback old API final ConfigIdentity') <
      apiRollback.indexOf('commit_api_active_color'),
  );
  assert.ok(
    workflow.indexOf('rollback-web.attempted', workflow.indexOf('restore_web_entry()')) <
      workflow.indexOf(
        'run_with_web_lock aliyun --secure oss cp',
        workflow.indexOf('restore_web_entry()'),
      ),
  );
  assert.ok(
    workflow.indexOf(
      'cmp "$RUNNER_TEMP/web-before/index.html"',
      workflow.indexOf('restore_web_entry()'),
    ) < workflow.indexOf('rollback-web.succeeded', workflow.indexOf('restore_web_entry()')),
  );
  assert.match(deploy, /acs_mutation_started=true/u);
  assert.match(deploy, /app_mutation_started=true/u);
  assert.match(deploy, /正式路径始终执行现场 readback[\s\S]*ROLLBACK_RUNTIME_VERIFY=true/u);
  assert.match(deploy, /systemctl reload nginx[\s\S]*validate_api_routing_boundary/u);
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
      workflow.indexOf('run_with_web_lock aliyun --secure oss cp "$RUNNER_TEMP/web-assets/"'),
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
  assert.match(deploy, /systemctl daemon-reload/u);
  assert.match(deploy, /systemctl restart "\$ACS_SERVICE_NAME"/u);
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
  assert.match(
    deploy,
    /acquire_config_governance_fence \\\n\s+"\$\{AGENT_SAAS_RUNTIME_DATA_ROOT:-\/mnt\/agent-saas\/server-data\}"/u,
  );
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

test('expand confirmation runs automatically with the existing release-bound evidence and lock', async () => {
  const [workflow, attestationCli, releaseDocs, releaseConfigDocs] = await Promise.all([
    readFile(confirmationWorkflowPath, 'utf8'),
    readFile(attestationCliPath, 'utf8'),
    readFile(releaseDocsPath, 'utf8'),
    readFile(releaseConfigDocsPath, 'utf8'),
  ]);
  const promotion = await readFile(workflowPath, 'utf8');
  assert.match(promotion, /group: production-runtime\s+cancel-in-progress: false/u);
  assert.match(promotion, /自动核验扩展迁移并完成发布/u);
  assert.match(
    promotion,
    /timeout --signal=TERM --kill-after=10 1800 bash scripts\/release\/finalize-expand-migration\.sh/u,
  );
  assert.match(workflow, /read-live-production-components\.mjs/u);
  assert.match(workflow, /production-api-ready\.json/u);
  assert.match(workflow, /production-lock-lease\.sh/u);
  assert.match(workflow, /bash -s -- hold '\$lock_token'/u);
  assert.match(workflow, /bash -s -- assert '\$lock_token'/u);
  assert.match(workflow, /bash -s -- release '\$lock_token'/u);
  ordered(workflow, [
    'setsid timeout --signal=TERM --kill-after=10 7250 ssh',
    'live-initial.json',
    'migration-confirmation-initial.json',
    'live-final.json',
    'migration-confirmation.json',
    '先按内容 digest 持久化最终锁内读回',
    '--state completed',
  ]);
  assert.match(workflow, /PRODUCTION_LOCK_TIMEOUT_SECONDS=7200/u);
  assert.match(workflow, /run_guarded\(\)[\s\S]*setsid "\$@"/u);
  assert.match(workflow, /terminate_guarded\(\)[\s\S]*kill -0 -- "-\$guarded_pid"/u);
  assert.match(workflow, /terminate_guarded\(\)[\s\S]*kill -KILL -- "-\$guarded_pid"/u);
  assert.match(workflow, /cleanup\(\)[\s\S]*terminate_guarded[\s\S]*bash -s -- release/u);
  assert.match(workflow, /run_guarded\(\)[\s\S]*kill -0 "\$lock_pid"/u);
  assert.match(workflow, /next_owner_check[\s\S]*if ! assert_lock/u);
  assert.match(workflow, /run_guarded pnpm exec tsx[\s\S]*--state completed/u);
  assert.match(
    workflow,
    /run_guarded bash scripts\/release\/upload-github-release-asset-immutable\.sh/u,
  );
  assert.match(workflow, /run_guarded bash scripts\/release\/upload-oss-object-immutable\.sh/u);
  assert.match(workflow, /diff -u[\s\S]*del\(\.liveObservedAt,\.confirmedAt\)/u);
  assert.match(workflow, /upload-oss-object-immutable\.sh[\s\S]*--state completed/u);
  assert.match(workflow, /promotion-finalization-mode\.mjs/u);
  assert.doesNotMatch(workflow, /--state completed[\s\S]*migration-confirmations\/confirmation-/u);
  assert.match(workflow, /--api-ready/u);
  assert.match(workflow, /--state completed/u);
  assert.match(workflow, /expand-confirmation:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT/u);
  assert.match(workflow, /migration-confirmations\/\$\{confirmation_digest#sha256:\}\.json/u);
  assert.match(workflow, /api\.agent\.kaiyan\.net\/api\/healthz\/ready/u);
  ordered(workflow, [
    '先按内容 digest 持久化最终锁内读回',
    '--state completed',
    'GitHub Release 是重跑读取源',
    'upload-github-release-asset-immutable.sh',
  ]);
  assert.match(workflow, /--confirmation-evidence/u);
  assert.match(attestationCli, /confirmation-evidence/u);
  assert.match(attestationCli, /currentState === 'awaiting_expand_confirmation'/u);
  assert.match(attestationCli, /confirmationEvidenceDigest !== evidenceDigest/u);
  assert.match(releaseDocs, /GitHub 上五个 Workflow/u);
  assert.match(releaseDocs, /自动收尾/u);
  assert.match(releaseDocs, /2 小时确认窗口和 5 分钟现场\/证据新鲜度/u);
  assert.match(releaseDocs, /psql 反斜杠元命令均拒绝/u);
  assert.match(releaseDocs, /全部 INSERT/u);
  assert.match(releaseDocs, /未自愿标 metadata 也会先进入闭包/u);
  assert.match(releaseDocs, /确认窗口一旦过期即 fail closed/u);
  assert.doesNotMatch(releaseDocs, /expand-reobservation/u);
  assert.match(releaseConfigDocs, /target_match=true/u);
  assert.match(releaseConfigDocs, /identity 写入或 `production-confirmed\.json` 回读失败/u);
  assert.match(releaseConfigDocs, /producer 仅用写 Token/u);
  assert.match(releaseConfigDocs, /publisher 仅用读 Token/u);
  assert.doesNotMatch(releaseConfigDocs, /准备发布证据` 只持有读身份/u);
  assert.match(workflow, /\[ "\$mode" = repair \]/u);
  assert.match(workflow, /修复 OSS 镜像/u);
  assert.doesNotMatch(workflow, /--clobber/u);
  assert.ok(runScriptLines(workflow).every((line) => !/\$\{\{\s*inputs\./u.test(line)));
});

test('App cleanup after Worker drain restores both sides before the success receipt', async () => {
  const deploy = await readFile(deployPath, 'utf8');
  const appDeployStart = deploy.indexOf('deploy_app() {');
  const cleanupStart = deploy.indexOf('  cleanup_app_failure() {', appDeployStart);
  const cleanupEnd = deploy.indexOf('  arm_deploy_rollback cleanup_app_failure', cleanupStart);
  const cleanup = deploy.slice(cleanupStart, cleanupEnd);
  const workerDrain = deploy.indexOf(
    'hand_off_retired_authority "agent-saas-runtime-worker@$worker_active"',
    cleanupEnd,
  );
  const apiDrain = deploy.indexOf(
    'hand_off_retired_authority "agent-saas-server@$api_active"',
    workerDrain,
  );
  assert.ok(workerDrain > cleanupEnd && apiDrain > workerDrain);
  assert.ok(cleanup.indexOf('agent-saas-server-$api_active.draining') >= 0);
  assert.ok(cleanup.indexOf('commit_rollback_worker_authority') >= 0);
  assert.ok(cleanup.indexOf('commit_rollback_api_authority') >= 0);
  assert.ok(cleanup.indexOf('commit_app_active_colors') >= 0);
  assert.ok(
    cleanup.lastIndexOf('record_rollback_success') > cleanup.indexOf('commit_app_active_colors'),
  );
});
