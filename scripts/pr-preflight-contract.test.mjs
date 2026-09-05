import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planCi, testMatrix, SHARDS } from './ci-plan.mjs';

const tasks = readFileSync(new URL('./pr-preflight-task.sh', import.meta.url), 'utf8');
const preflight = readFileSync(new URL('./pr-preflight.sh', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const serverPackage = JSON.parse(readFileSync(new URL('../server/package.json', import.meta.url), 'utf8'));

test('分片脚本保留原 PR preflight 的全部门禁', () => {
  for (const command of [
    'pnpm check:ratchets',
    "pnpm -r --filter './packages/*' typecheck",
    "pnpm -r --filter './packages/*' test",
    "pnpm -r --filter './packages/*' build",
    'pnpm -F @kaiyan/ky-app-server exec vitest run src/sat/pgJtiStore.pg.test.ts src/pg/stores.pg.test.ts',
    'pnpm test:release-contracts',
    'pnpm check:runtime-dependencies',
    'pnpm -F server typecheck',
    'pnpm -F server context:relation-eval:baseline',
    'pnpm -F server build',
    'pnpm -F "$workspace" test:coverage',
    'pnpm -F web check:api-boundary',
    'pnpm scenarios:lint',
    'pnpm sanitize-check',
    'pnpm -F web build:oss',
    'pnpm check:web-startup-budget -- --dist web/dist',
  ]) {
    assert.match(tasks, new RegExp(escapeRegExp(command), 'u'));
  }
});

test('生产 server bundle 内联工作区 shared 包与 ky-app 契约包', () => {
  const build = serverPackage.scripts.build;
  assert.match(build, /--packages=external/u);
  assert.match(build, /--alias:@agent\/shared=\.\.\/shared\/src\/index\.ts/u);
  // WP2a：@kaiyan/ky-app-contract 是 devDependency，生产 deploy 不装它，必须内联进 bundle。
  assert.match(
    build,
    /--alias:@kaiyan\/ky-app-contract=\.\.\/packages\/ky-app-contract\/src\/index\.ts/u,
  );
  assert.equal(serverPackage.dependencies.jose, '^6.1.3');
  assert.equal(serverPackage.dependencies.ajv, '^8.18.0');
});

test('本地 PR preflight 仍按原顺序串行执行全部任务', () => {
  let previous = -1;
  for (const marker of [
    'bash "$task_script" checks',
    'bash "$task_script" coverage shared',
    'bash "$task_script" coverage server',
    'bash "$task_script" coverage web',
    'bash "$task_script" postgres',
    'bash "$task_script" web',
  ]) {
    const current = preflight.indexOf(marker);
    assert.ok(current > previous, `missing or out-of-order preflight task: ${marker}`);
    previous = current;
  }
});

test('分片测试任务：affected 用 --changed、覆盖率写 blob、web 不在 Runner 上跑 Playwright 契约脚本', () => {
  const start = tasks.indexOf('  test)');
  const end = tasks.indexOf('  coverage-merge)');
  assert.ok(start > -1 && end > start);
  const task = tasks.slice(start, end);
  for (const marker of [
    'args=(run "--shard=$shard/$total" --passWithNoTests --reporter=dot)',
    'args+=("--changed=$base")',
    'args+=(--coverage --reporter=blob "--outputFile=coverage-blobs/blob-$shard-$total.json")',
    'server|web) args+=(--maxWorkers=2 --coverage.processingConcurrency=2) ;;',
    'pnpm -F @agent/shared exec vitest "${args[@]}"',
    'require_test_database',
    'pnpm -F server exec vitest "${args[@]}"',
    'NODE_ENV=test pnpm -F web exec vitest "${args[@]}" --testTimeout=15000',
  ]) {
    assert.match(task, new RegExp(escapeRegExp(marker), 'u'));
  }
  // affected 模式没有 base SHA 必须失败，不能静默退化成只跑未提交改动。
  assert.match(task, /affected mode requires a base SHA/u);
  // check:comparison-layout 需要本机 Playwright 浏览器，旧 CI 的 test:coverage 也从未运行它。
  assert.doesNotMatch(task, /pnpm -F web run check:/u);
  const merge = tasks.slice(end, tasks.indexOf('  postgres)'));
  assert.match(merge, /test -d "\$workspace\/coverage-blobs"/u);
  assert.match(merge, /vitest run --merge-reports=coverage-blobs --coverage/u);
  // 点开头目录会被 actions/upload-artifact 默认排除（首轮 PR run 实测 0 个 artifact）。
  assert.doesNotMatch(tasks, /\.vitest-reports/u);
});

test('CI 计划：PR 只跑受影响工作区、非 import 图资源与未知路径 fail closed', () => {
  assert.deepEqual(planCi(['server/src/index.ts']).tests, { shared: 'none', server: 'affected', web: 'none' });
  assert.equal(planCi(['server/src/index.ts']).postgres, true);
  assert.equal(planCi(['server/src/index.ts']).webProduction, false);
  assert.equal(planCi(['server/src/index.ts']).coverage, false);
  assert.deepEqual(planCi(['server/src/__tests__/foo.test.ts']).tests.server, 'affected');
  for (const file of [
    'server/src/data/scenarios/workflow-library-v3.json',
    'server/src/agent/descriptions/Shell.md',
    'server/src/context/relations/fixtures/phase4-baseline-v1.json',
    'server/src/__tests__/__snapshots__/x.snap',
    'server/src/types/foo.d.ts',
    'server/package.json',
    'config.json',
  ]) {
    assert.equal(planCi([file]).tests.server, 'full', `${file} must widen server to full`);
  }
  assert.equal(planCi(['server/src/data/scenarios/workflow-library-v3.json']).webProduction, true);
  assert.equal(planCi(['server/scripts/scenarios-lint.mjs']).webProduction, true);

  assert.deepEqual(planCi(['web/src/App.tsx']).tests, { shared: 'none', server: 'none', web: 'affected' });
  assert.equal(planCi(['web/src/App.tsx']).webProduction, true);
  assert.equal(planCi(['web/src/App.tsx']).postgres, false);
  assert.equal(planCi(['web/src/test/setup.ts']).tests.web, 'full');
  assert.equal(planCi(['web/src/styles.css']).tests.web, 'full');
  assert.equal(planCi(['web/index.html']).tests.web, 'full');

  const mobile = planCi(['mobile/app/index.tsx']);
  assert.deepEqual(mobile.tests, { shared: 'none', server: 'none', web: 'none' });
  assert.equal(mobile.mobile, true);
  assert.equal(planCi(['web/src/App.tsx']).mobile, false);

  const docs = planCi(['docs/guide.md', 'README.md']);
  assert.equal(docs.mode, 'affected');
  assert.deepEqual(testMatrix(docs), [{ workspace: 'none', shard: 1, total: 1, mode: 'none' }]);
  assert.equal(docs.postgres, false);
  assert.equal(docs.mobile, false);

  for (const file of [
    'shared/src/index.ts',
    'scripts/ci-plan.mjs',
    '.github/workflows/ci.yml',
    '.github/actions/setup-pnpm/action.yml',
    'package.json',
    'pnpm-lock.yaml',
    'config/max-lines-baseline.txt',
    'workspace-shared/.ky-agent/skills-pool/browser/SKILL.md',
    'daemon-packaging/systemd/agent-saas-server@.service.template',
    'new-workspace/src/index.ts',
    'acs-orchestrator/src/index.ts',
  ]) {
    const plan = planCi([file]);
    assert.equal(plan.mode, 'full', `${file} must force the full gate`);
    assert.deepEqual(plan.tests, { shared: 'full', server: 'full', web: 'full' });
    assert.equal(plan.coverage, true);
    assert.equal(plan.mobile, true);
  }
  assert.equal(planCi(null).mode, 'full');
});

test('push main 与 dispatch 始终全量分片并收集覆盖率', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    const plan = planCi(['web/src/App.tsx'], event);
    assert.equal(plan.mode, 'full');
    assert.equal(plan.coverage, true);
    const matrix = testMatrix(plan);
    assert.equal(matrix.length, SHARDS.shared + SHARDS.server + SHARDS.web);
    assert.equal(matrix.filter((entry) => entry.workspace === 'server').length, SHARDS.server);
    assert.ok(matrix.every((entry) => entry.mode === 'full' && entry.shard >= 1 && entry.shard <= entry.total));
  }
  assert.deepEqual(SHARDS, { shared: 1, server: 4, web: 2 });
});

test('CI 并行任务、分片矩阵与 Build & Check 汇总门禁完整连接', () => {
  for (const marker of [
    'name: Preflight / Plan',
    'node scripts/ci-plan.mjs',
    '--output "$GITHUB_OUTPUT"',
    'name: Preflight / Static checks',
    'bash scripts/pr-preflight-task.sh checks',
    'name: Preflight / Tests (${{ matrix.workspace }} ${{ matrix.shard }}/${{ matrix.total }})',
    'include: ${{ fromJSON(needs.ci_plan.outputs.test_matrix) }}',
    'bash scripts/pr-preflight-task.sh test',
    '"${{ matrix.workspace }}" "${{ matrix.shard }}" "${{ matrix.total }}"',
    '"${{ matrix.mode }}" "${{ needs.ci_plan.outputs.changed_base || \'-\' }}"',
    '"${{ needs.ci_plan.outputs.coverage }}"',
    'name: coverage-blob-${{ matrix.workspace }}-${{ matrix.shard }}-${{ github.run_id }}-${{ github.run_attempt }}',
    'bash scripts/pr-preflight-task.sh postgres',
    "if: needs.ci_plan.outputs.postgres == 'true'",
    'bash scripts/pr-preflight-task.sh web',
    "if: needs.ci_plan.outputs.web_production == 'true'",
    "if: needs.ci_plan.outputs.mobile == 'true'",
    'pnpm -F mobile check:router-export',
    'pnpm -F mobile test > "$raw" 2>&1',
    'name: Build & Check',
    'needs: [ci_plan, preflight_checks, tests, postgres_contracts, web_production, mobile_router_export, mobile_contract]',
    'pattern: coverage-blob-*-${{ github.run_id }}-${{ github.run_attempt }}',
    'bash scripts/pr-preflight-task.sh coverage-merge "$workspace"',
    'path: ${{ matrix.workspace }}/coverage-blobs/',
    'no coverage blobs downloaded for $workspace',
    'needs.preflight_checks.result',
    'needs.tests.result',
    'needs.postgres_contracts.result',
    'needs.web_production.result',
    'needs.mobile_router_export.result',
    'needs.mobile_contract.result',
    'if [ "$result" = "skipped" ] && [ "$planned" = "false" ]; then',
    'exit "$failed"',
    'needs: build',
    'needs: [build, deploy_plan]',
  ]) {
    assert.match(workflow, new RegExp(escapeRegExp(marker), 'u'));
  }
  assert.match(workflow, /matrix\.workspace == 'server'.*postgres:16-alpine/u);
  assert.match(workflow, /COVERAGE_REPORT_MODE: ci/u);
  assert.match(workflow, /build:\s+[\s\S]*?if: always\(\)/u);
  // affected 模式依赖 base commit 在本地历史里。
  const tests = workflow.slice(workflow.indexOf('\n  tests:\n'), workflow.indexOf('\n  postgres_contracts:\n'));
  assert.match(tests, /fetch-depth: 0/u);
  // 覆盖率只在 full 模式产出，PR 不再评论 diff coverage。
  assert.doesNotMatch(workflow, /coverage:diff|Comment PR diff coverage|pull-requests: write/u);
});

test('PR 计划先检查真实变更路径的发布分类，失败传递到汇总门禁', () => {
  const plan = workflow.slice(
    workflow.indexOf('\n  ci_plan:\n'),
    workflow.indexOf('\n  preflight_checks:\n'),
  );
  assert.match(plan, /fetch-depth: 0/u);
  assert.match(plan, /if: github\.event_name == 'pull_request'/u);
  assert.ok(
    plan.indexOf('node scripts/release/classify-components.mjs') <
      plan.indexOf('node scripts/ci-plan.mjs'),
  );
  for (const marker of [
    'RELEASE_BASE_SHA: ${{ github.event.pull_request.base.sha }}',
    'RELEASE_TARGET_SHA: ${{ github.event.pull_request.head.sha }}',
    '--baseline "$RELEASE_BASE_SHA" --target "$RELEASE_TARGET_SHA"',
  ]) {
    assert.ok(plan.includes(marker), `missing release classification wiring: ${marker}`);
  }
  assert.doesNotMatch(plan, /continue-on-error|\|\| true/u);
  assert.ok(workflow.includes('"ci_plan=$CI_PLAN_RESULT=true"'));
});

test('pnpm 只从固定二进制安装，不再经过 npm registry 自举', () => {
  assert.doesNotMatch(workflow, /pnpm\/action-setup/u);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-pnpm/u);
  // composite action 依赖已 checkout 的仓库文件，每个 job 里必须先 checkout。
  for (const job of workflow.split(/\n(?=  [a-z_-]+:\n)/u)) {
    if (!job.includes('uses: ./.github/actions/setup-pnpm')) continue;
    assert.ok(
      job.indexOf('uses: actions/checkout@') > -1 &&
        job.indexOf('uses: actions/checkout@') < job.indexOf('uses: ./.github/actions/setup-pnpm'),
      `setup-pnpm runs before checkout in job:\n${job.slice(0, 80)}`,
    );
  }
});

test('Mobile gate 固定工具链、全量跑一遍且只上传失败日志', () => {
  const match = workflow.match(/\n  mobile_contract:\n[\s\S]*?(?=\n  # 保留仓库 Ruleset)/u);
  assert.ok(match, 'mobile_contract job is missing');
  const job = match[0];
  for (const marker of [
    'node-version: ${{ env.NODE_VERSION }}',
    'cache: pnpm',
    'cache-dependency-path: pnpm-lock.yaml',
    'pnpm install --frozen-lockfile',
    'pnpm -F @agent/shared typecheck && pnpm -F mobile typecheck',
    'pnpm -F mobile lint:maestro && pnpm -F mobile lint:m70-01 && pnpm -F mobile lint:m70-02',
    'pnpm -F mobile test:m60-03:prebuild',
    'pnpm -F mobile test > "$raw" 2>&1',
    'EXPO_OFFLINE=1 pnpm -F mobile exec expo install --check',
    'if: failure()',
    'retention-days: 1',
  ]) {
    assert.match(job, new RegExp(escapeRegExp(marker), 'u'));
  }
  assert.doesNotMatch(job, /continue-on-error|\|\| true|retry/u);
  // 不再按里程碑重复执行 `pnpm -F mobile test` 已覆盖的子集。
  assert.doesNotMatch(job, /test:m60-02|test:m60-04|test:m60-05|test:m70-01|test:m70-02|test:m70-03|pnpm mobile-contract/u);
  assert.match(workflow, /NODE_VERSION: '22\.23\.1'/u);
  assert.match(
    workflow,
    /cancel-in-progress: \$\{\{ github\.event_name != 'workflow_dispatch' \}\}/u,
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
