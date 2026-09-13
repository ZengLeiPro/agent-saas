import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertPromotionRetryable } from './assert-promotion-retry.mjs';
import { planPromotionConfigIdentityBaseline } from './promotion-config-identity-state.mjs';
import { verifyPromotionAcsSelection } from './verify-promotion-acs-selection.mjs';

const workflowPath = new URL('../../.github/workflows/promote-release.yml', import.meta.url);
const promotionGatePath = new URL('../../server/src/release/promotionGateCli.ts', import.meta.url);
const finalizeExpandPath = new URL('./finalize-expand-migration.sh', import.meta.url);
const deployPath = new URL('./deploy-production-release.sh', import.meta.url);

function ordered(text, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `${marker} must appear in the required order`);
    cursor = next;
  }
}

function job(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} must exist`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z_]+:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function steps(jobText) {
  return [...jobText.matchAll(/^ {6}- name: (.+)$/gmu)].map((match) => match[1]);
}

test('主干只有一条顺序：解析 RC → 证据 → 读生产 → ACS → App → Web → 回读 → checkpoint → OSS 记录', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const promote = job(workflow, 'promote');
  ordered(promote, [
    '解析发布目标并下载不可变 RC 证据',
    '复核测试环境证据并记录批准',
    '配置生产环境 SSH',
    '读取在线生产现状并校验可发布',
    '校验 OSS 中的不可变清单、产物索引与 Release 记录',
    '预取、校验并安全解压清单选定产物与 ACS 身份',
    '在组件变更前预检生产 Web 冷备',
    '上传不可变部署载荷与 RC 绑定的托管单元',
    '记录发布已开始',
    '部署 ACS 编排器与沙箱镜像',
    '蓝绿部署 API 并交接运行时 Worker',
    '发布 Web 入口并保留旧版哈希资源',
    '回读全部在线组件并在完全收敛后提交可信身份',
    '记录发布终态',
    '自动核验扩展迁移并完成发布',
    '保存最近成功的生产基线',
    '写入 OSS 发布记录',
    '写入 GitHub 标签、Release 与部署记录',
    '旁证未完整写入时告警',
    '上传生产发布证据',
  ]);
  // 部署步骤是普通步骤：失败即失败，不再靠 continue-on-error + 回执 + 状态机去猜。
  const deploySteps = promote.slice(
    promote.indexOf('部署 ACS 编排器与沙箱镜像'),
    promote.indexOf('记录发布终态'),
  );
  assert.doesNotMatch(deploySteps, /continue-on-error/u);
  assert.doesNotMatch(
    promote,
    /write-operation-receipt|read-rollback-receipt|reconcile-promotion|promotion-finalization-mode|assert-checkpoint-repair/u,
  );
  assert.doesNotMatch(
    workflow,
    /checkpoint-repair|automation_id|automation_key|automatic-release\.mjs/u,
  );
});

test('生产真相只来自回读：不收敛就失败，收敛后才写 checkpoint、OSS 记录与 GitHub 旁证', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const promote = job(workflow, 'promote');
  const readback = promote.slice(
    promote.indexOf('回读全部在线组件并在完全收敛后提交可信身份'),
    promote.indexOf('记录发布终态'),
  );
  assert.match(readback, /read-live-production-components\.mjs/u);
  assert.match(readback, /verify-promotion-observation\.mjs/u);
  assert.match(
    readback,
    /diff -u <\(jq -S \.components "\$RUNNER_TEMP\/production-after\.json"\)/u,
  );
  assert.match(readback, /生产未收敛到 \$RELEASE_ID/u);
  assert.match(readback, /hold-production-observation-lock\.sh/u);
  assert.match(readback, /write-production-identity\.mjs/u);
  assert.match(readback, /PRODUCTION_CONVERGED=true/u);
  assert.doesNotMatch(
    readback,
    /continue-on-error|target_match=false|write-live-production-identity/u,
  );
  for (const name of ['写入 GitHub 标签、Release 与部署记录', '写入发布摘要']) {
    const index = promote.indexOf(name);
    assert.match(promote.slice(index, index + 400), /if: env\.PRODUCTION_CONVERGED == 'true'/u);
  }
  const checkpoint = promote.slice(
    promote.indexOf('保存最近成功的生产基线'),
    promote.indexOf('写入 OSS 发布记录'),
  );
  assert.match(checkpoint, /= completed/u);
  assert.match(checkpoint, /save-production-checkpoint\.sh/u);
  assert.doesNotMatch(checkpoint, /continue-on-error/u);
});

test('GitHub 记录是旁证：带重试、失败只告警，不改变发布结论；OSS 记录在主干且带重试', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const promote = job(workflow, 'promote');
  const evidence = promote.slice(
    promote.indexOf('写入 GitHub 标签、Release 与部署记录'),
    promote.indexOf('旁证未完整写入时告警'),
  );
  assert.match(evidence, /continue-on-error: true/u);
  assert.match(evidence, /for attempt in 1 2 3; do/u);
  assert.match(evidence, /git push origin "refs\/tags\/\$RELEASE_ID"/u);
  assert.match(evidence, /gh release create "\$RELEASE_ID" --verify-tag --latest/u);
  assert.match(evidence, /repos\/\$GITHUB_REPOSITORY\/deployments/u);
  assert.match(evidence, /evidence-status\.json/u);
  const warn = promote.slice(
    promote.indexOf('旁证未完整写入时告警'),
    promote.indexOf('写入发布摘要'),
  );
  assert.match(warn, /if: always\(\) && steps\.evidence\.outcome == 'failure'/u);
  assert.match(warn, /::warning title=发布成功/u);
  assert.doesNotMatch(warn, /exit 1/u);
  const history = promote.slice(
    promote.indexOf('写入 OSS 发布记录'),
    promote.indexOf('写入 GitHub 标签、Release 与部署记录'),
  );
  assert.doesNotMatch(history, /continue-on-error/u);
  assert.match(history, /upload-oss-object-immutable\.sh/u);
  assert.match(history, /for attempt in 1 2 3; do/u);
  // GitHub Deployment 记录不再出现在部署动作之前。
  assert.ok(
    promote.indexOf('repos/$GITHUB_REPOSITORY/deployments') >
      promote.indexOf('回读全部在线组件并在完全收敛后提交可信身份'),
  );
});

test('主干幂等：写入前读真实在线组件、按前缀放行、已在目标的组件跳过，重跑等于恢复', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const promote = job(workflow, 'promote');
  const before = promote.slice(
    promote.indexOf('读取在线生产现状并校验可发布'),
    promote.indexOf('校验 OSS 中的不可变清单、产物索引与 Release 记录'),
  );
  assert.match(before, /--retry-mode retry_after_change/u);
  for (const flag of [
    'ACS_ALREADY_TARGET',
    'APP_ALREADY_TARGET',
    'WEB_ALREADY_TARGET',
    'PRODUCTION_ALREADY_TARGET',
  ])
    assert.match(before, new RegExp(`echo "${flag}=`, 'u'));
  assert.match(before, /promotionGateCli\.ts/u);
  assert.match(before, /assert-write-gate/u);
  assert.deepEqual(
    planPromotionConfigIdentityBaseline({
      retryMode: 'retry_after_change',
      apiAction: 'deploy',
      runtimeWorkerAction: 'deploy',
    }),
    { reader: 'read-live-production-components.mjs', configIdentityStage: 'candidate-readback' },
  );
  const gate = await readFile(promotionGatePath, 'utf8');
  assert.match(
    gate,
    /productionStateIsResumable: productionStateMatchesManifestPrefix\(manifest, state\)/u,
  );
  assert.doesNotMatch(gate, /recovery-mode/u);
  const acs = promote.slice(
    promote.indexOf('部署 ACS 编排器与沙箱镜像'),
    promote.indexOf('蓝绿部署 API 并交接运行时 Worker'),
  );
  assert.match(acs, /if \[ "\$ACS_ALREADY_TARGET" = true \]; then/u);
  const app = promote.slice(
    promote.indexOf('蓝绿部署 API 并交接运行时 Worker'),
    promote.indexOf('发布 Web 入口并保留旧版哈希资源'),
  );
  assert.match(app, /if \[ "\$APP_ALREADY_TARGET" = true \]; then/u);
  assert.match(app, /resume_handoff=true/u);
  // 发布模式：completed → verify，awaiting_expand_confirmation → confirm，其余可发布状态 → promote。
  const resolve = promote.slice(
    promote.indexOf('解析发布目标并下载不可变 RC 证据'),
    promote.indexOf('复核测试环境证据并记录批准'),
  );
  assert.match(resolve, /completed\) mode=verify ;;/u);
  assert.match(resolve, /awaiting_expand_confirmation\) mode=confirm ;;/u);
  assert.match(
    resolve,
    /verified\|approved\|promoting\|needs_human\|failed_before_change\) mode=promote ;;/u,
  );
  assert.match(resolve, /sort -u -t- -k2,2n -k3,3n \| tail -n1/u);
  for (const name of [
    '记录发布已开始',
    '部署 ACS 编排器与沙箱镜像',
    '蓝绿部署 API 并交接运行时 Worker',
    '发布 Web 入口并保留旧版哈希资源',
    '复核测试环境证据并记录批准',
  ]) {
    const index = promote.indexOf(name);
    assert.match(promote.slice(index, index + 300), /if: env\.PROMOTION_MODE == 'promote'/u, name);
  }
});

test('中断后的记录能重新批准；已进入生产写入的记录只能按 post-mutation 路径恢复', () => {
  const digest = 'sha256:' + 'a'.repeat(64);
  const base = { releaseId: 'rc-20260913-01', manifestDigest: digest };
  const entry = (state, operationKey, offset, reason) => ({
    ...base,
    state,
    operationKey,
    recordedAt: new Date(1_700_000_000_000 + offset).toISOString(),
    ...(reason ? { reason: JSON.stringify(reason) } : {}),
  });
  const promoting = entry('promoting', 'p', 2, {
    releaseId: base.releaseId,
    releaseSha: 'b'.repeat(40),
    manifestDigest: digest,
    migrationPhase: 'none',
    migrationPlanDigest: digest,
    productionBeforeDigest: digest,
    productionTargetDigest: digest,
  });
  assert.equal(assertPromotionRetryable([entry('verified', 'v', 0)]).mode, 'fresh');
  assert.equal(
    assertPromotionRetryable([
      entry('verified', 'v', 0),
      entry('approved', 'a', 1),
      entry('failed_before_change', 'f', 2),
    ]).mode,
    'retry_before_change',
  );
  assert.equal(
    assertPromotionRetryable([
      entry('verified', 'v', 0),
      entry('approved', 'a', 1),
      promoting,
      entry('needs_human', 'n', 3),
    ]).mode,
    'retry_after_change',
  );
  assert.throws(() =>
    assertPromotionRetryable([
      entry('verified', 'v', 0),
      entry('approved', 'a', 1),
      promoting,
      entry('completed', 'c', 3),
    ]),
  );
});

test('expand 迁移在同一次运行内自动核验并在本地记录 completed；上传由 workflow 统一负责', async () => {
  const finalize = await readFile(finalizeExpandPath, 'utf8');
  assert.match(finalize, /awaiting_expand_confirmation/u);
  assert.match(finalize, /confirm-expand-migration\.mjs/u);
  assert.match(finalize, /--state completed/u);
  assert.doesNotMatch(
    finalize,
    /promotion-finalization-mode|upload-github-release-asset-immutable/u,
  );
  assert.match(finalize, /retirement_id="\$\(printf '%s' "\$awaiting" \| jq -r \.operationKey/u);
  const workflow = await readFile(workflowPath, 'utf8');
  const promote = job(workflow, 'promote');
  const outcome = promote.slice(
    promote.indexOf('记录发布终态'),
    promote.indexOf('自动核验扩展迁移并完成发布'),
  );
  assert.match(outcome, /outcome=awaiting_expand_confirmation/u);
  assert.match(outcome, /--operation "outcome:\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT"/u);
  const expand = promote.slice(
    promote.indexOf('自动核验扩展迁移并完成发布'),
    promote.indexOf('保存最近成功的生产基线'),
  );
  assert.match(expand, /if: env\.MIGRATION_PHASE == 'expand' && env\.PROMOTION_MODE != 'verify'/u);
});

test('Web 发布沿用同锁内 OSS+冷备事务与失败回滚；ACS/App 部署脚本契约未变', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const promote = job(workflow, 'promote');
  const web = promote.slice(
    promote.indexOf('发布 Web 入口并保留旧版哈希资源'),
    promote.indexOf('回读全部在线组件并在完全收敛后提交可信身份'),
  );
  for (const text of [
    'web-shell-transaction.mjs snapshot',
    'upload-web-assets-immutable.sh',
    'verify-public-web.mjs',
    'publish_recovery_web',
    'verify_recovery_web',
    'cleanup_web_on_exit',
    'finish_web_recovery committed',
    'WEB_LOCK_TIMEOUT_SECONDS=1700',
  ])
    assert.ok(web.includes(text), text);
  const deploy = await readFile(deployPath, 'utf8');
  for (const phase of ['acs', 'app', 'web'])
    assert.match(deploy, new RegExp(`PHASE.*${phase}`, 'u'));
  assert.equal(
    steps(promote).filter((name) => name.includes('deploy-production-release.sh')).length,
    0,
  );
  assert.equal(
    (promote.match(/bash '\$PROMOTION_REMOTE\/deploy-production-release\.sh'/gu) ?? []).length,
    3,
  );
});

test('ACS 选型校验与 Manifest 绑定不变', () => {
  const manifest = {
    schemaVersion: 2,
    components: {
      acs: {
        action: 'deploy',
        sourceSha: 'a'.repeat(40),
        orchestratorArtifactDigest: 'sha256:' + 'b'.repeat(64),
        sandboxImageDigest: 'sha256:' + 'c'.repeat(64),
        sandboxImageReference: 'registry.example/agent-saas/acs-sandbox@sha256:' + 'c'.repeat(64),
      },
    },
  };
  assert.equal(typeof verifyPromotionAcsSelection, 'function');
  assert.ok(
    manifest.components.acs.sandboxImageReference.endsWith(
      manifest.components.acs.sandboxImageDigest,
    ),
  );
});
