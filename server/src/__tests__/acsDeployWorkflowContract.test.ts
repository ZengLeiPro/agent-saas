import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(
  new URL('../../../.github/workflows/acs-sandbox.yml', import.meta.url),
);
const workflow = readFileSync(workflowPath, 'utf-8');
const ciWorkflow = readFileSync(fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)), 'utf-8');
const classifierPath = fileURLToPath(
  new URL('../../../.github/scripts/acs-classify.sh', import.meta.url),
);

function classify(paths: string[]): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'acs-impact-'));
  const fixture = join(directory, 'changed-files.txt');
  try {
    writeFileSync(fixture, `${paths.join('\n')}\n`, 'utf8');
    const output = execFileSync('bash', [classifierPath, fixture], { encoding: 'utf8' });
    return Object.fromEntries(
      output
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const classificationCases = [
  { path: 'web/src/App.tsx', publish: 'false', contractCheck: 'false' },

  { path: 'acs-orchestrator/src/config.ts', publish: 'true', contractCheck: 'false' },
  { path: 'scripts/release/deploy-staging-release.sh', publish: 'true', contractCheck: 'false' },
  { path: 'scripts/release/deploy-production-release.sh', publish: 'true', contractCheck: 'false' },
  { path: '.github/workflows/acs-sandbox.yml', publish: 'true', contractCheck: 'false' },
  { path: '.github/workflows/ci.yml', publish: 'true', contractCheck: 'false' },
  // Workload wire/content changes mirrored into the ACS image remain explicit publish paths.
  { path: 'server/src/agent/toolRuntime.ts', publish: 'true', contractCheck: 'false' },
  { path: 'server/src/runtime/httpTransport.ts', publish: 'true', contractCheck: 'false' },
  { path: 'server/src/runtime/handStore.ts', publish: 'true', contractCheck: 'false' },
  // Web/application admission code, config and helpers ship in the ACS image and must run lifecycle contracts.
  { path: 'server/src/app/runtime.ts', publish: 'true', contractCheck: 'true' },
  { path: 'server/src/channels/web/channel.ts', publish: 'true', contractCheck: 'true' },
  { path: 'server/src/channels/web/channelConfig.ts', publish: 'true', contractCheck: 'true' },
  { path: 'server/src/channels/web/channelHelpers.ts', publish: 'true', contractCheck: 'true' },

  { path: '.github/workflows/deploy-staging.yml', publish: 'false', contractCheck: 'true' },
  { path: '.github/workflows/promote-release.yml', publish: 'false', contractCheck: 'true' },
  { path: 'scripts/release/staging-workflow.test.mjs', publish: 'false', contractCheck: 'true' },
  { path: 'scripts/release/promotion-workflow.test.mjs', publish: 'false', contractCheck: 'true' },

  { path: 'shared/src/types/sandboxWorkload.ts', publish: 'false', contractCheck: 'true' },
  { path: 'shared/src/types/index.ts', publish: 'false', contractCheck: 'true' },
  { path: 'shared/src/index.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/agent/types.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/__tests__/sandboxRunAdmissionFence.test.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/__tests__/sandboxScopeActivity.pg.test.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/__tests__/webChannelPersistentInteractionRecovery.test.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/runtimeHandRegistration.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/runtimeWakeSessionRestore.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/rawRuntimeRunDispatch.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/sessionCatalog.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/sandboxRunAdmissionFence.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/sandboxWarmup.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/sandboxTerminalOutboxStore.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/sandboxLifecycleService.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/runStore.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/types.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/subagent/subagentRunner.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/background/backgroundTaskMetadata.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/background/backgroundTaskService.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/taskboard/executionSession.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/dws/businessToolProvider.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/feishu/authFlow.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/context/sync/dwsContextRuntime.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/cron/executor.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/memory/consolidation/engine.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/notion/authFlow.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/data/transcripts/meta.ts', publish: 'false', contractCheck: 'true' },
] as const;

describe('ACS deployment and classifier contract', () => {
  it('为所有 main PR 提供固定名称且不读取生产 secret 的 ACS Impact Gate', () => {
    expect(workflow).toContain('pull_request:\n    branches: [main]');
    expect(workflow).toContain('acs-impact-gate:');
    expect(workflow).toContain('name: ACS Impact Gate');
    expect(workflow).toContain("if: github.event_name == 'pull_request'");
    expect(workflow).toContain("if: github.event_name != 'pull_request'");
    expect(workflow).toContain('result: \\`not_required\\`');

    const gateStart = workflow.indexOf('  acs-impact-gate:');
    const changesStart = workflow.indexOf('  changes:', gateStart);
    const gate = workflow.slice(gateStart, changesStart);
    expect(gate).not.toContain('secrets.');
    expect(gate).not.toContain('workflow_dispatch');
  });

  it('让所有 main push 进入 changes job，并由 classifier 独占路径分类', () => {
    const pushStart = workflow.indexOf('  push:');
    const dispatchStart = workflow.indexOf('  workflow_dispatch:', pushStart);

    expect(pushStart).toBeGreaterThan(-1);
    expect(dispatchStart).toBeGreaterThan(pushStart);
    const pushTrigger = workflow.slice(pushStart, dispatchStart);
    expect(pushTrigger).toContain('branches: [main]');
    expect(pushTrigger).not.toContain('paths:');
  });

  it.each(classificationCases)(
    '$path => publish=$publish contract_check=$contractCheck',
    ({ path, publish, contractCheck }) => {
      const result = classify([path]);
      expect(result.publish).toBe(publish);
      expect(result.contract_check).toBe(contractCheck);
    },
  );

  it('在 required、contract 与 publish gate 中执行完整 Server、Staging 与 Production lifecycle 契约', () => {
    const serverContracts = [
      'acsDeployWorkflowContract', 'executionDispatchValidation', 'runtimeTombstoneAdmission',
      'runtimeWakeSessionRestore', 'sandboxLifecycleService', 'sandboxRunAdmissionFence',
      'sandboxWarmup', 'sessionCatalog', 'webChannelPersistentInteractionRecovery',
    ];
    expect(workflow.match(/- name: Test server ACS lifecycle and admission contracts/gu)).toHaveLength(3);
    for (const contract of serverContracts) {
      expect(workflow.match(new RegExp(`src/__tests__/${contract}\\.test\\.ts`, 'gu'))).toHaveLength(3);
    }
    expect(workflow.match(/- name: Test ACS staging and production lifecycle gates/gu)).toHaveLength(3);
    expect(workflow.match(/scripts\/release\/staging-workflow\.test\.mjs/gu)).toHaveLength(3);
    expect(workflow.match(/scripts\/release\/promotion-workflow\.test\.mjs/gu)).toHaveLength(3);
  });

  it('由带 PostgreSQL 的动态 Server coverage 验证 sandboxScopeActivity PG 集成契约', () => {
    expect(ciWorkflow).toContain('workspace: ${{ fromJSON(needs.coverage_scope.outputs.workspaces) }}');
    expect(ciWorkflow).toContain("image: ${{ matrix.workspace == 'server' && 'postgres:16-alpine' || '' }}");
    expect(ciWorkflow).toContain('TEST_DATABASE_URL: postgresql://agent_test:ci-only-password@127.0.0.1:5432/agent_saas_test');
    expect(ciWorkflow).toContain('bash scripts/pr-preflight-task.sh coverage "${{ matrix.workspace }}"');
  });

  it('在等待镜像前拒绝已经落后于 main 的 dispatch', () => {
    const checkoutIndex = workflow.indexOf('- name: Checkout exact dispatch commit');
    const verifyIndex = workflow.indexOf('- name: Verify dispatch still targets latest main');
    const waitIndex = workflow.indexOf('- name: Wait for ACR auto-build of HEAD');
    const packIndex = workflow.indexOf('- name: Pack and identify orchestrator release');

    expect(checkoutIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(checkoutIndex);
    expect(waitIndex).toBeGreaterThan(verifyIndex);
    expect(packIndex).toBeGreaterThan(waitIndex);
    expect(workflow).toContain('git fetch --quiet --no-tags origin main');
    expect(workflow).toContain(
      'This run targets $GITHUB_SHA, but origin/main is now $latest_main_sha',
    );
    expect(workflow).toContain(
      'main advanced to $latest_main_sha before an ACR build record appeared',
    );
  });

  it('发现 exact SHA 构建记录后不因 main 推进中断等待', () => {
    expect(workflow).toContain('build_record_found=false');
    expect(workflow).toContain('if [ "$build_record_found" = "true" ]; then');
    expect(workflow).toContain('ACR build record disappeared');
    expect(workflow).toContain('build_record_found=true');
    expect(workflow).toContain('后续 main 推进不影响本次代码与镜像仍使用同一个 GITHUB_SHA');
    expect(workflow).not.toContain('while this run was waiting for image');
  });

  it('与其他生产写入口全局串行且不取消正在进行的发布', () => {
    expect(workflow).toContain('group: production-runtime');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toContain('group: acs-production-deploy');
  });

  it('只接受 exact SHA 镜像并对缺失构建记录快速失败', () => {
    expect(workflow).toContain('SHA6="${GITHUB_SHA:0:6}"');
    expect(workflow).toContain('MAX_MISSING_POLLS=6');
    expect(workflow).toContain('MAX_QUERY_ERRORS=3');
    expect(workflow).toContain("tag.endswith('-' + sha6)");
    expect(workflow).toContain('a later image will not be substituted');
    expect(workflow).not.toContain('for i in $(seq 1 60)');
  });

  it('为 ACR 排队和实际构建保留独立等待预算', () => {
    expect(workflow).toContain('timeout-minutes: 75');
    expect(workflow).toContain('MAX_PENDING_POLLS=40');
    expect(workflow).toContain('MAX_BUILDING_POLLS=60');
    expect(workflow).toContain('pending_polls=$((pending_polls + 1))');
    expect(workflow).toContain('building_polls=$((building_polls + 1))');
    expect(workflow).toContain('ACR build queue timeout');
    expect(workflow).toContain('ACR build timeout');
    expect(workflow).not.toContain('MAX_POLLS=40');
  });
});
