import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(
  new URL('../../../.github/workflows/promote-release.yml', import.meta.url),
);
const workflow = readFileSync(workflowPath, 'utf8');
const releaseSource = (path: string) => readFileSync(
  new URL(`../../../scripts/release/${path}`, import.meta.url), 'utf8',
);
const imageWait = releaseSource('wait-for-acr-image.sh');
const imageSupervisor = releaseSource('acr-image-supervisor.py');

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
  it('统一 CI 为 main PR 提供固定名称且不读取生产 secret 的 ACS Impact Gate', () => {
    expect(ciWorkflow).toContain('pull_request:\n    branches: [main]');
    expect(ciWorkflow).toContain('name: ACS Impact Gate');
    const gateStart = ciWorkflow.indexOf('  acs-impact-gate:');
    const gate = ciWorkflow.slice(gateStart, ciWorkflow.indexOf('  preflight_checks:', gateStart));
    expect(gate).toContain('needs: ci_plan');
    expect(gate).toContain('if: ${{ !cancelled() }}');
    expect(gate).toContain('not_required');
    expect(gate).not.toContain('secrets.');
    expect(gate).not.toContain('workflow_dispatch');
    expect(workflow).not.toContain('  acs-impact-gate:');
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

  it('统一 CI 接收全部 main push，ACS 发布入口仅保留手动触发', () => {
    const triggers = ciWorkflow.slice(ciWorkflow.indexOf('on:'), ciWorkflow.indexOf('concurrency:'));
    expect(triggers).toContain('push:\n    branches: [main]');
    expect(triggers).not.toContain('paths:');
    const manualTriggers = workflow.slice(0, workflow.indexOf('jobs:'));
    expect(manualTriggers).toContain('workflow_dispatch:');
    expect(manualTriggers).not.toContain('  push:');
    expect(manualTriggers).not.toContain('  pull_request:');
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

  it('统一 CI 保留一份完整 Server、Staging 与 Production lifecycle 契约', () => {
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
      ciWorkflow.match(/- name: 测试服务端 ACS 生命周期与准入契约/gu),
    ).toHaveLength(1);
    for (const contract of serverContracts) {
      expect(
        ciWorkflow.match(new RegExp(`src/__tests__/${contract}\\.test\\.ts`, 'gu')),
      ).toHaveLength(1);
    }
    for (const contract of [
      'src/context/sync/dwsContextRuntime.test.ts',
      'src/dws/businessToolProvider.test.ts',
      'src/dws/requesterIdentityResolver.test.ts',
    ])
      expect(ciWorkflow.split(contract)).toHaveLength(2);
    expect(
      ciWorkflow.match(/- name: 测试 ACS 测试及生产环境生命周期门禁/gu),
    ).toHaveLength(1);
    expect(ciWorkflow.match(/scripts\/release\/staging-workflow\.test\.mjs/gu)).toHaveLength(1);
    expect(ciWorkflow.match(/scripts\/release\/promotion-workflow\.test\.mjs/gu)).toHaveLength(1);
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

  it('只晋级来自 main 的不可变 RC，生产不再等待或打包源码 HEAD', () => {
    expect(workflow).toContain("needs.dispatch.outputs.operation == 'promote'");
    expect(workflow).toContain('fetch-rc-evidence.sh "$RELEASE_ID"');
    expect(workflow).toContain('git merge-base --is-ancestor "$release_sha" origin/main');
    expect(workflow).toContain('prefetch-promotion-artifacts.mjs');
    expect(workflow).toContain('verify-selected-release-artifacts.mjs');
    expect(workflow).toContain('verify-promotion-acs-selection.mjs');
    expect(workflow).not.toContain('等待 ACR 自动构建 HEAD');
    expect(workflow).not.toContain('scripts/deploy-acs-orchestrator.sh');
  });

  it('与 CI 兼容生产写入口全局串行且不取消正在进行的发布', () => {
    expect(workflow).toContain('group: production-runtime');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('environment: production');
    expect(ciWorkflow).toContain("github.event_name == 'workflow_dispatch' && 'production-runtime'");
  });

  it('Staging 镜像解析先按短 tag 选候选，再用 GIT_CLONE 日志绑定完整 SHA', () => {
    expect(imageWait).toContain('short_sha="${RELEASE_SHA:0:6}"');
    expect(imageWait).toContain('Multiple ACR records match the release SHA prefix');
    expect(imageWait).toContain('The selected ACR build record changed while polling');
    expect(imageWait).toContain('ListRepoBuildRecordLog');
    expect(imageWait).toContain('verify-acr-build-revision.mjs "$logs" "$RELEASE_SHA" main');
    expect(imageWait).toContain('scripts/release/list-acr-build-records.sh');
    expect(imageWait).toContain('ACR tag no longer has one successful selected BuildRecordId');
    expect(imageWait).toContain('test "${first_digest#sha256:}" = "${confirmed_digest#sha256:}"');
    expect(acrRecordListHelper).toContain('page_size=100');
    expect(acrRecordListHelper).toContain('total changed during pagination');
    expect(acrRecordListHelper).toContain('records.length !== expectedTotal');
    expect(imageWait.indexOf('verify-acr-build-revision.mjs')).toBeLessThan(imageWait.indexOf('GetRepoTag'));
  });

  it('RC ACS 阶段绑定清单与托管单元，最终身份经过受保护的读回收敛', () => {
    expect(workflow).toContain('PHASE=acs');
    expect(workflow).toContain("EXPECTED_MANIFEST_DIGEST='$MANIFEST_DIGEST'");
    expect(workflow).toContain("ACS_UNIT_TEMPLATE='$PROMOTION_REMOTE/agent-saas-acs-orchestrator.service.template'");
    expect(workflow).toContain('run-with-production-lock-guard.sh');
    expect(workflow).toContain('production-confirmed.json');
  });

  it('ACR supervisor 有总时限、阶段时限和有界重试而不是无限等待', () => {
    expect(imageWait).toContain('exec python3 scripts/release/acr-image-supervisor.py');
    expect(imageSupervisor).toContain('deadline = started + 45 * 60');
    expect(imageSupervisor).toContain('ACR overall 45-minute deadline exceeded');
    expect(imageSupervisor).toContain('ACR {phase} deadline exceeded');
    expect(imageSupervisor).toContain('bounded retry');
  });
});
