import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { planCoverageWorkspaces } from './coverage-workspace-plan.mjs';

const [workflow, wrapper, tasks, serverPackage] = await Promise.all([
  readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  readFile(new URL('./pr-preflight.sh', import.meta.url), 'utf8'),
  readFile(new URL('./pr-preflight-task.sh', import.meta.url), 'utf8'),
  readFile(new URL('../server/package.json', import.meta.url), 'utf8').then(JSON.parse),
]);

const requiredTaskCommands = [
  'pnpm check:ratchets',
  'pnpm -F server typecheck',
  'pnpm -F server context:relation-eval:baseline',
  'pnpm -F server build',
  'pnpm -F "$workspace" test:coverage',
  'src/__tests__/memoryConsolidationStore.pg.test.ts',
  'src/__tests__/pgToolInvocationTerminalGate.pg.test.ts',
  'pnpm -F web check:api-boundary',
  'pnpm scenarios:lint',
  'pnpm sanitize-check',
  'pnpm -F web build:oss',
  'pnpm check:web-startup-budget -- --dist web/dist',
];

test('分片脚本保留原 PR preflight 的全部门禁', () => {
  for (const command of requiredTaskCommands)
    assert.match(tasks, new RegExp(escapeRegExp(command), 'u'));
});

test('生产 server bundle 内联工作区 shared 包', () => {
  const build = serverPackage.scripts?.build ?? '';
  assert.match(build, /--packages=external/u);
  assert.match(build, /--alias:@agent\/shared=\.\.\/shared\/src\/index\.ts/u);
});

test('本地 PR preflight 仍按原顺序串行执行全部任务', () => {
  const markers = [
    '"$task_script" checks',
    '"$task_script" coverage shared',
    '"$task_script" coverage server',
    '"$task_script" coverage web',
    '"$task_script" postgres',
    '"$task_script" web',
  ];
  let previous = -1;
  for (const marker of markers) {
    const current = wrapper.indexOf(marker);
    assert.ok(current > previous, `missing or out-of-order preflight task: ${marker}`);
    previous = current;
  }
});

test('CI 并行任务与 Build & Check 汇总门禁完整连接', () => {
  for (const marker of [
    'name: Preflight / Coverage scope',
    'node scripts/coverage-workspace-plan.mjs',
    '--output "$GITHUB_OUTPUT"',
    'bash scripts/pr-preflight-task.sh checks',
    'bash scripts/pr-preflight-task.sh coverage "${{ matrix.workspace }}"',
    'bash scripts/pr-preflight-task.sh postgres',
    'bash scripts/pr-preflight-task.sh web',
    'name: Build & Check',
    'needs: [preflight_checks, coverage, postgres_contracts, web_production]',
    'needs.preflight_checks.result',
    'needs.coverage.result',
    'needs.postgres_contracts.result',
    'needs.web_production.result',
    'if [ "$result" != "success" ]',
    'exit "$failed"',
    'needs: build',
    'needs: [build, deploy_plan]',
  ]) {
    assert.match(workflow, new RegExp(escapeRegExp(marker), 'u'));
  }
  assert.match(
    workflow,
    /workspace: \$\{\{ fromJSON\(needs\.coverage_scope\.outputs\.workspaces\) \}\}/u,
  );
  assert.match(workflow, /matrix\.workspace == 'server'.*postgres:16-alpine/u);
  assert.match(workflow, /COVERAGE_REPORT_MODE: ci/u);
  assert.match(workflow, /build:\s+[\s\S]*?if: always\(\)/u);
});

test('PR 覆盖率范围按依赖方向收窄，未知路径 fail closed', () => {
  assert.deepEqual(planCoverageWorkspaces(['web/src/App.tsx']), ['web']);
  assert.deepEqual(planCoverageWorkspaces(['server/src/index.ts']), ['server']);
  assert.deepEqual(planCoverageWorkspaces(['shared/src/index.ts']), ['shared', 'server', 'web']);
  assert.deepEqual(planCoverageWorkspaces(['docs/guide.md']), ['none']);
  assert.deepEqual(planCoverageWorkspaces(['new-workspace/src/index.ts']), [
    'shared',
    'server',
    'web',
  ]);
  assert.deepEqual(planCoverageWorkspaces(['web/src/App.tsx'], 'push'), [
    'shared',
    'server',
    'web',
  ]);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
