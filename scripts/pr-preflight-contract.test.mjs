import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
  assert.match(workflow, /workspace: \[shared, server, web\]/u);
  assert.match(workflow, /build:\s+[\s\S]*?if: always\(\)/u);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
