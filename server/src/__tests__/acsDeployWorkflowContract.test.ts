import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(
  new URL('../../../.github/workflows/acs-sandbox.yml', import.meta.url),
);
const workflow = readFileSync(workflowPath, 'utf8');
const acrRecordListHelper = readFileSync(
  fileURLToPath(new URL('../../../scripts/release/list-acr-build-records.sh', import.meta.url)),
  'utf8',
);
const ciWorkflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)),
  'utf-8',
);
const classifierPath = fileURLToPath(
  new URL('../../../.github/scripts/acs-classify.sh', import.meta.url),
);
const bundleInputsPath = fileURLToPath(
  new URL('../../../.github/acs-bundle-inputs.txt', import.meta.url),
);
const orchestratorPackagePath = fileURLToPath(
  new URL('../../../acs-orchestrator/package.json', import.meta.url),
);
const orchestratorDirectory = dirname(orchestratorPackagePath);
const repoRoot = dirname(orchestratorDirectory);
const requireFromOrchestrator = createRequire(orchestratorPackagePath);
const bundleInputPatterns = readFileSync(bundleInputsPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

function matchesBundleInput(path: string): boolean {
  return bundleInputPatterns.some((pattern) => {
    if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -2));
    return path === pattern;
  });
}

function actualBundleRepositoryInputs(): string[] {
  const esbuild = requireFromOrchestrator('esbuild') as {
    buildSync(options: Record<string, unknown>): {
      metafile?: { inputs: Record<string, unknown> };
    };
  };
  const result = esbuild.buildSync({
    absWorkingDir: orchestratorDirectory,
    entryPoints: ['src/index.ts', 'src/backgroundShellWorker.ts', 'src/restorePerPodCli.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outdir: 'dist-contract',
    external: ['pg-native', '@napi-rs/canvas'],
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  if (!result.metafile) throw new Error('esbuild did not return a metafile');

  const trackedFiles = new Set(
    execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n'),
  );
  return Object.keys(result.metafile.inputs)
    .map((path) => (path.startsWith('../') ? path.slice(3) : `acs-orchestrator/${path}`))
    .filter((path) => trackedFiles.has(path))
    .sort();
}

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
  { path: 'server/src/runtime/sandboxLifecycleStore.ts', publish: 'false', contractCheck: 'true' },

  { path: 'acs-orchestrator/src/config.ts', publish: 'true', contractCheck: 'false' },
  { path: 'pnpm-lock.yaml', publish: 'true', contractCheck: 'false' },
  { path: '.github/acs-bundle-inputs.txt', publish: 'true', contractCheck: 'false' },
  {
    path: 'scripts/release/create-component-artifact-index.mjs',
    publish: 'true',
    contractCheck: 'false',
  },
  {
    path: 'scripts/release/seal-root-staged-payload.sh',
    publish: 'true',
    contractCheck: 'false',
  },
  {
    path: 'scripts/release/verify-acr-build-revision.mjs',
    publish: 'true',
    contractCheck: 'false',
  },
  {
    path: 'scripts/release/list-acr-build-records.sh',
    publish: 'true',
    contractCheck: 'false',
  },
  { path: 'server/src/runtime/invocationCorrelation.ts', publish: 'true', contractCheck: 'false' },
  { path: 'shared/src/schemas/workflowScenario.ts', publish: 'true', contractCheck: 'false' },
  { path: 'shared/package.json', publish: 'true', contractCheck: 'false' },
  { path: 'scripts/release/deploy-staging-release.sh', publish: 'true', contractCheck: 'false' },
  { path: 'scripts/release/wait-for-acr-image.sh', publish: 'false', contractCheck: 'true' },
  { path: 'scripts/release/deploy-production-release.sh', publish: 'true', contractCheck: 'false' },
  { path: '.github/workflows/acs-sandbox.yml', publish: 'true', contractCheck: 'false' },
  { path: '.github/workflows/ci.yml', publish: 'true', contractCheck: 'false' },
  // Workload wire/content changes mirrored into the ACS image remain explicit publish paths.
  { path: 'server/src/agent/toolRuntime.ts', publish: 'true', contractCheck: 'false' },
  { path: 'server/src/runtime/httpTransport.ts', publish: 'true', contractCheck: 'false' },
  { path: 'server/src/runtime/handStore.ts', publish: 'true', contractCheck: 'false' },
  // Web/application admission code and helpers ship in the ACS image; deletion and staging-only paths remain contract-only.
  { path: 'server/src/app/runtime.ts', publish: 'true', contractCheck: 'true' },
  { path: 'server/src/app/serverRemoteConfig.ts', publish: 'true', contractCheck: 'true' },
  { path: 'server/src/channels/web/channel.ts', publish: 'true', contractCheck: 'true' },
  { path: 'server/src/channels/web/channelConfig.ts', publish: 'true', contractCheck: 'true' },
  { path: 'server/src/channels/web/channelHelpers.ts', publish: 'true', contractCheck: 'true' },

  { path: '.github/workflows/deploy-staging.yml', publish: 'false', contractCheck: 'true' },
  { path: '.github/workflows/promote-release.yml', publish: 'false', contractCheck: 'true' },
  { path: 'scripts/release/staging-workflow.test.mjs', publish: 'false', contractCheck: 'true' },
  { path: 'scripts/release/promotion-workflow.test.mjs', publish: 'false', contractCheck: 'true' },

  { path: 'shared/src/types/sandboxWorkload.ts', publish: 'true', contractCheck: 'true' },
  { path: 'shared/src/types/index.ts', publish: 'true', contractCheck: 'true' },
  { path: 'shared/src/index.ts', publish: 'true', contractCheck: 'true' },
  { path: 'server/src/agent/types.ts', publish: 'true', contractCheck: 'true' },
  { path: 'server/src/__tests__/appConfig.test.ts', publish: 'false', contractCheck: 'true' },
  {
    path: 'server/src/__tests__/appServerRemoteConfig.test.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  {
    path: 'server/src/__tests__/runtimeHandProvisionRace.test.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  {
    path: 'server/src/__tests__/serverRemoteConfig.test.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  {
    path: 'server/src/__tests__/sandboxRunAdmissionFence.test.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  {
    path: 'server/src/__tests__/sandboxScopeActivity.pg.test.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  {
    path: 'server/src/__tests__/webChannelPersistentInteractionRecovery.test.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  { path: 'server/src/app/config.ts', publish: 'false', contractCheck: 'true' },
  {
    path: 'server/src/runtime/runtimeHandRegistration.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  {
    path: 'server/src/runtime/serverRemoteHandRegistration.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  {
    path: 'server/src/runtime/runtimeWakeSessionRestore.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  { path: 'server/src/runtime/rawRuntimeRunDispatch.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/sessionCatalog.ts', publish: 'false', contractCheck: 'true' },
  {
    path: 'server/src/runtime/sandboxRunAdmissionFence.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  { path: 'server/src/runtime/sandboxWarmup.ts', publish: 'false', contractCheck: 'true' },
  {
    path: 'server/src/runtime/sandboxTerminalOutboxStore.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  {
    path: 'server/src/runtime/sandboxLifecycleService.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  { path: 'server/src/routes/sandboxSessionDeletion.ts', publish: 'false', contractCheck: 'true' },
  {
    path: 'server/src/routes/sessionPermanentDeletion.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  { path: 'server/src/runtime/runStatusCas.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/runStoreQueries.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/runTerminalLifecycle.ts', publish: 'false', contractCheck: 'true' },
  {
    path: 'server/src/runtime/runStoreLivenessQueries.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  { path: 'server/src/routes/sessions.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/runStore.ts', publish: 'false', contractCheck: 'true' },
  { path: 'server/src/runtime/types.ts', publish: 'false', contractCheck: 'true' },
  {
    path: 'server/src/runtime/subagent/subagentRunner.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  {
    path: 'server/src/runtime/background/backgroundTaskMetadata.ts',
    publish: 'false',
    contractCheck: 'true',
  },
  {
    path: 'server/src/runtime/background/backgroundTaskService.ts',
    publish: 'false',
    contractCheck: 'true',
  },
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

  it('对普通 UI、ACS 源码、managed unit 和 Workflow 给出稳定分类', () => {
    expect(classify(['web/src/App.tsx'])).toMatchObject({
      publish: 'false',
      contract_check: 'false',
      reason: 'none',
    });
    expect(classify(['acs-orchestrator/src/config.ts'])).toMatchObject({
      publish: 'true',
      contract_check: 'false',
    });
    expect(classify(['.github/workflows/acs-sandbox.yml'])).toMatchObject({
      publish: 'true',
      contract_check: 'false',
    });
    expect(classify(['.github/workflows/ci.yml'])).toMatchObject({
      publish: 'true',
      contract_check: 'false',
    });
    expect(classify(['scripts/release/manage-acs-systemd-unit.sh'])).toMatchObject({
      publish: 'true',
      contract_check: 'false',
    });
    expect(
      classify(['daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template']),
    ).toMatchObject({
      publish: 'true',
      contract_check: 'false',
    });
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

  it('从真实 Orchestrator bundle 锁定全部仓库输入的发布分类', () => {
    const sourceInputs = actualBundleRepositoryInputs();
    expect(sourceInputs).toContain('server/src/runtime/invocationCorrelation.ts');
    expect(sourceInputs).toContain('shared/src/schemas/workflowScenario.ts');
    expect(sourceInputs.length).toBeGreaterThan(0);

    for (const sourceInput of sourceInputs) {
      expect(matchesBundleInput(sourceInput), sourceInput).toBe(true);
      expect(classify([sourceInput]), sourceInput).toMatchObject({ publish: 'true' });
    }
    for (const workspace of new Set(sourceInputs.map((path) => path.split('/')[0]))) {
      const packageMetadata = `${workspace}/package.json`;
      expect(matchesBundleInput(packageMetadata), packageMetadata).toBe(true);
      expect(classify([packageMetadata]), packageMetadata).toMatchObject({ publish: 'true' });
    }
  });

  it('在 required、contract 与 publish gate 中执行完整 Server、Staging 与 Production lifecycle 契约', () => {
    const serverContracts = [
      'acsDeployWorkflowContract',
      'dwsAuthFlow',
      'dwsKeepalive',
      'dwsPersonalEventGateway',
      'dwsPersonalMessageSender',
      'executionDispatchValidation',
      'feishuConnector',
      'runtimeTombstoneAdmission',
      'runtimeWakeSessionRestore',
      'sandboxLifecycleService',
      'sandboxRunAdmissionFence',
      'sandboxWorkloadDescriptor',
      'sandboxWarmup',
      'sessionCatalog',
      'taskboardExecution',
      'webChannelPersistentInteractionRecovery',
    ];
    expect(
      workflow.match(/- name: 测试服务端 ACS 生命周期与准入契约/gu),
    ).toHaveLength(3);
    for (const contract of serverContracts) {
      expect(
        workflow.match(new RegExp(`src/__tests__/${contract}\\.test\\.ts`, 'gu')),
      ).toHaveLength(3);
    }
    for (const contract of [
      'src/context/sync/dwsContextRuntime.test.ts',
      'src/dws/businessToolProvider.test.ts',
      'src/dws/requesterIdentityResolver.test.ts',
    ])
      expect(workflow.split(contract)).toHaveLength(4);
    expect(
      workflow.match(/- name: 测试 ACS 测试及生产环境生命周期门禁/gu),
    ).toHaveLength(3);
    expect(workflow.match(/scripts\/release\/staging-workflow\.test\.mjs/gu)).toHaveLength(3);
    expect(workflow.match(/scripts\/release\/promotion-workflow\.test\.mjs/gu)).toHaveLength(3);
  });

  it('由 PostgreSQL 快速合约与 Server coverage 双重验证 sandboxScopeActivity', () => {
    const preflight = readFileSync(
      fileURLToPath(new URL('../../../scripts/pr-preflight-task.sh', import.meta.url)),
      'utf-8',
    );
    expect(ciWorkflow).toContain(
      'include: ${{ fromJSON(needs.ci_plan.outputs.test_matrix) }}',
    );
    expect(ciWorkflow).toContain(
      "image: ${{ matrix.workspace == 'server' && 'postgres:16-alpine' || '' }}",
    );
    expect(ciWorkflow).toContain(
      'TEST_DATABASE_URL: postgresql://agent_test:ci-only-password@127.0.0.1:5432/agent_saas_test',
    );
    expect(ciWorkflow).toContain('bash scripts/pr-preflight-task.sh test');
    expect(ciWorkflow).toContain('bash scripts/pr-preflight-task.sh postgres');
    expect(preflight).toContain('src/__tests__/sandboxScopeActivity.pg.test.ts');
  });

  it('在等待镜像前拒绝落后 main 的 dispatch，并在确认后打包 managed unit', () => {
    const checkoutIndex = workflow.indexOf('- name: 检出手动触发的精确提交');
    const verifyIndex = workflow.indexOf('- name: 确认手动触发仍指向最新 main');
    const waitIndex = workflow.indexOf('- name: Wait for ACR auto-build of HEAD');
    const packIndex = workflow.indexOf(
      '- name: 打包并标识编排器及托管单元版本',
    );

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

  it('发现 exact SHA 构建记录后继续等待，但在实际部署前再次拒绝 main 漂移', () => {
    expect(workflow).toContain('build_record_found=false');
    expect(workflow).toContain('if [ "$build_record_found" = "true" ]; then');
    expect(workflow).toContain('ACR build record disappeared');
    expect(workflow).toContain('build_record_found=true');
    expect(workflow).toContain('实际部署前的独立门禁会拒绝这个旧 dispatch');
    const deployStart = workflow.indexOf('- name: 部署编排器并执行排空与冒烟检查');
    const cleanupStart = workflow.indexOf('- name: 清理已封存的 ACS 生产暂存区');
    const deployStep = workflow.slice(deployStart, cleanupStart);
    expect(deployStep).toContain('git fetch --no-tags origin main');
    expect(deployStep).toContain('if [ "$latest_main_sha" != "$GITHUB_SHA" ]; then');
    expect(deployStep.indexOf('latest_main_sha=')).toBeLessThan(deployStep.indexOf('bash -s'));
  });

  it('与其他生产写入口全局串行且不取消正在进行的发布', () => {
    expect(workflow).toContain('group: production-runtime');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toContain('group: acs-production-deploy');
  });

  it('先按 6 位 tag 选候选，再用 GIT_CLONE 日志绑定完整 SHA', () => {
    const waitStep = workflow.slice(
      workflow.indexOf('- name: Wait for ACR auto-build of HEAD'),
      workflow.indexOf('- name: 解析不可变 ACS 镜像'),
    );
    expect(workflow).toContain('SHA6="${GITHUB_SHA:0:6}"');
    expect(workflow).toContain('MAX_MISSING_POLLS=6');
    expect(workflow).toContain('MAX_QUERY_ERRORS=3');
    expect(workflow).toContain('secrets.ACR_READ_ACCESS_KEY_ID');
    expect(workflow).toContain('secrets.ACR_READ_ACCESS_KEY_SECRET');
    expect(workflow).toContain("data.get('Code') != 'success'");
    expect(workflow).toContain("data.get('IsSuccess') is not True");
    expect(workflow).toContain('Unable to query ACR build records');
    expect(waitStep).not.toContain('2>/dev/null || true');
    expect(workflow).toContain(".endswith('-' + sha6)");
    expect(workflow).toContain("record.get('BuildRecordId')");
    expect(workflow).toContain('ListRepoBuildRecordLog');
    expect(workflow).toContain('scripts/release/verify-acr-build-revision.mjs');
    expect(workflow).toContain('if len(matches) > 1:');
    expect(workflow).toContain('selected_build_record_id');
    expect(workflow).toContain('acr-build-records-confirmed.json');
    expect(workflow).toContain('scripts/release/list-acr-build-records.sh');
    expect(acrRecordListHelper).toContain('page_size=100');
    expect(acrRecordListHelper).toContain('total changed during pagination');
    expect(acrRecordListHelper).toContain('records.length !== expectedTotal');
    expect(workflow).toContain('ACR tag no longer has one selected BuildRecordId');
    expect(workflow).toContain('test "$confirmed_digest" = "$image_digest"');
    expect(workflow).toContain("GITHUB_RUN_ATTEMPT='$GITHUB_RUN_ATTEMPT'");
    expect(workflow.indexOf('ListRepoBuildRecordLog')).toBeLessThan(
      workflow.indexOf('echo "image_tag=$btag"'),
    );
    expect(workflow).toContain('a later image will not be substituted');
    expect(workflow).not.toContain('for i in $(seq 1 60)');
  });

  it('只在 deploy 脚本持有 promotion.lock 时刷新 ACS trusted identity', () => {
    expect(workflow).not.toContain('- name: Refresh trusted Production identity');
    expect(workflow).not.toContain('production-identity-${GITHUB_RUN_ID}');
    expect(workflow).toContain('scripts/release/write-live-production-identity.mjs');
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
