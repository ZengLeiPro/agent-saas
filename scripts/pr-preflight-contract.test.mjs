import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { planCi, testMatrix, SHARDS } from './ci-plan.mjs';
import { sourceGuardTests } from './ci-source-guards.mjs';
import { stageCoverageBlobs } from './ci-coverage-blobs.mjs';

const tasks = readFileSync(new URL('./pr-preflight-task.sh', import.meta.url), 'utf8');
const preflight = readFileSync(new URL('./pr-preflight.sh', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const serverPackage = JSON.parse(
  readFileSync(new URL('../server/package.json', import.meta.url), 'utf8'),
);

test('分片脚本保留原 PR preflight 的全部门禁', () => {
  for (const command of [
    'pnpm check:ratchets',
    "pnpm -r --filter './packages/*' typecheck",
    "pnpm -r --filter './packages/*' test",
    "pnpm -r --filter './packages/*' build",
    'pnpm -F @kaiyan/ky-app-server exec vitest run src/sat/pgJtiStore.pg.test.ts src/pg/stores.pg.test.ts',
    // WP2a：v41 迁移与定制项目 store 的 PG 合约必须在 postgres 任务显式清单里。
    'src/__tests__/entitlementScopeBaseline.pg.test.ts',
    'src/kyapp/systems/store.pg.test.ts',
    // WP3：v43 会话工具快照表的跨进程合约。
    'src/kyapp/gateway/snapshotStore.pg.test.ts',
    'src/kyapp/__tests__/kyAppStores.pg.test.ts',
    // WP2b：v42 迁移与目录变更日志/投影的 PG 合约同样必须在 postgres 任务显式清单里。
    'src/kyapp/directory/store.pg.test.ts',
    'pnpm test:release-contracts',
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

test('分片测试任务：affected 和源码 guard 合并后分片、覆盖率写 blob', () => {
  const start = tasks.indexOf('  test)');
  const end = tasks.indexOf('  coverage-merge)');
  assert.ok(start > -1 && end > start);
  const task = tasks.slice(start, end);
  for (const marker of [
    'args=(run "--shard=$shard/$total" --passWithNoTests --reporter=dot)',
    'node scripts/ci-test-selection.mjs "$workspace" "$base" "$selection_file"',
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
  assert.deepEqual(planCi(['server/src/index.ts']).tests, {
    shared: 'none',
    server: 'affected',
    web: 'none',
  });
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

  assert.deepEqual(planCi(['web/src/App.tsx']).tests, {
    shared: 'none',
    server: 'none',
    web: 'affected',
  });
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
    assert.ok(
      matrix.every(
        (entry) => entry.mode === 'full' && entry.shard >= 1 && entry.shard <= entry.total,
      ),
    );
  }
  assert.deepEqual(SHARDS, { shared: 1, server: 4, web: 2 });
});

test('CI 并行任务、分片矩阵与 Build & Check 汇总门禁完整连接', () => {
  assert.deepEqual(parse(workflow).jobs.build.needs, ['ci_plan', 'preflight_checks', 'migration_reviews', 'tests', 'postgres_contracts', 'web_production', 'mobile_router_export', 'mobile_contract', 'release_packages', 'writer_bundle', 'browser_smoke']);
  for (const marker of [
    'name: 预检 / 规划',
    'node scripts/ci-plan.mjs',
    '--output "$GITHUB_OUTPUT"',
    'name: 预检 / 静态检查',
    'bash scripts/pr-preflight-task.sh checks',
    'name: 预检 / 测试（${{ matrix.workspace }} ${{ matrix.shard }}/${{ matrix.total }}）',
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
    'pattern: coverage-blob-*-${{ github.run_id }}-${{ github.run_attempt }}',
    'bash scripts/pr-preflight-task.sh coverage-merge "$workspace"',
    'path: ${{ matrix.workspace }}/coverage-blobs/',
    'node scripts/ci-coverage-blobs.mjs "$RUNNER_TEMP/coverage-blobs"',
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
  assert.match(workflow, /build:\s+[\s\S]*?if: \$\{\{ !cancelled\(\) \}\}/u);
  // affected 模式依赖 base commit 在本地历史里。
  const tests = workflow.slice(
    workflow.indexOf('\n  tests:\n'),
    workflow.indexOf('\n  postgres_contracts:\n'),
  );
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
  assert.doesNotMatch(
    job,
    /test:m60-02|test:m60-04|test:m60-05|test:m70-01|test:m70-02|test:m70-03|pnpm mobile-contract/u,
  );
  assert.match(workflow, /NODE_VERSION: '22\.23\.1'/u);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ci-selection-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content = '') => {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  return { root, write };
}

test('source guards follow local helpers and cycles, include unknown loaders, and retain import-only skipping', (t) => {
  const { root, write } = fixture(t);
  write('web/src/normal.test.ts', "import './pure.js';");
  write('web/src/pure.ts', 'export const value = 1;');
  write('web/src/direct.test.ts', "import { readFileSync } from 'node:fs';");
  write('web/src/indirect.test.ts', "import './cycle-a.js';");
  write('web/src/cycle-a.ts', "import './cycle-b.js';");
  write('web/src/cycle-b.ts', "import './cycle-a.js'; import '../helpers/resource.js';");
  write('web/helpers/resource.ts', "import fs from 'node:fs/promises';");
  write('web/src/missing.test.ts', "import './unresolved.js';");
  write('web/src/dynamic.test.ts', 'import /* loader */ (`./${name}.js`);');
  write(
    'web/src/registered.test.ts',
    '// @ci-source-guard: external resource helper\nimport read from "external-helper";',
  );
  write('web/src/named.guard.test.ts', 'export {};');
  assert.deepEqual(sourceGuardTests('web', root), [
    'src/direct.test.ts',
    'src/dynamic.test.ts',
    'src/indirect.test.ts',
    'src/missing.test.ts',
    'src/named.guard.test.ts',
    'src/registered.test.ts',
  ]);
  assert.throws(() => sourceGuardTests('unknown', root), /Unsupported test workspace/u);
});

test('the previously missed chat resource guards remain in affected selection', () => {
  const guards = sourceGuardTests('web');
  for (const name of ['approvalTier', 'resumeCursor', 'swGuard']) {
    assert.ok(
      guards.some((file) => file.includes(`useChatAppState.${name}`)),
      `${name} source guard is missing`,
    );
  }
  assert.equal(new Set(guards).size, guards.length);
});

test('coverage rejects a missing or stale-attempt shard before writing a partial report', (t) => {
  const { root, write } = fixture(t);
  const source = join(root, 'artifacts');
  const destination = join(root, 'report');
  const matrix = [
    { workspace: 'web', shard: 1, total: 2 },
    { workspace: 'web', shard: 2, total: 2 },
  ];
  write('artifacts/coverage-blob-web-1-123-2/blob-1-2.json', '{"shard":1}');
  write('artifacts/coverage-blob-web-2-123-1/blob-2-2.json', '{"stale":true}');
  write('report/web/coverage-blobs/sentinel', 'existing report');
  const stage = () =>
    stageCoverageBlobs({ source, destination, matrix, runId: '123', attempt: '2' });
  assert.throws(stage, /Missing coverage blob/u);
  assert.equal(
    readFileSync(join(destination, 'web/coverage-blobs/sentinel'), 'utf8'),
    'existing report',
  );
  write('artifacts/coverage-blob-web-2-123-2/blob-2-2.json', '{"shard":2}');
  assert.deepEqual(stage(), { staged: 2 });
  assert.deepEqual(readdirSync(join(destination, 'web/coverage-blobs')).sort(), [
    'blob-1-2.json',
    'blob-2-2.json',
  ]);
  assert.equal(
    readFileSync(join(destination, 'web/coverage-blobs/blob-2-2.json'), 'utf8'),
    '{"shard":2}',
  );
  assert.throws(
    () =>
      stageCoverageBlobs({ source, destination, matrix: [matrix[0]], runId: '123', attempt: '2' }),
    /Incomplete coverage shard plan/u,
  );
  assert.throws(
    () =>
      stageCoverageBlobs({
        source,
        destination,
        matrix: [...matrix, matrix[0]],
        runId: '123',
        attempt: '2',
      }),
    /Duplicate coverage shard/u,
  );
});

test('Build & Check executes fail-closed result admission independently of optional coverage', () => {
  const jobs = parse(workflow).jobs;
  const build = jobs.build;
  assert.equal(build.if, '${{ !cancelled() }}');
  assert.ok(!build.needs.includes('coverage_reports'));
  assert.deepEqual(jobs.coverage_reports.needs, ['ci_plan', 'tests']);
  assert.equal(build.steps.length, 1, 'required aggregation must not reinstall dependencies');
  const step = build.steps[0];
  const success = Object.fromEntries(
    Object.keys(step.env).map((key) => [key, key.startsWith('PLAN_') ? 'true' : 'success']),
  );
  const execute = (overrides = {}) =>
    spawnSync('bash', ['-c', step.run], {
      env: { ...process.env, ...success, ...overrides },
      encoding: 'utf8',
    });
  assert.equal(execute().status, 0);
  for (const key of Object.keys(success).filter((key) => key.endsWith('_RESULT'))) {
    for (const state of ['failure', 'cancelled', 'skipped', '']) {
      const result = execute({ [key]: state });
      assert.equal(result.status, 1, `${key}=${state} must fail: ${result.stdout}`);
    }
  }
  assert.equal(
    execute({
      PLAN_RELEASE_PACKAGES: 'false',
      RELEASE_PACKAGES_RESULT: 'skipped',
      WRITER_BUNDLE_RESULT: 'skipped',
    }).status,
    0,
  );
  assert.equal(execute({ PLAN_BROWSER_SMOKE: 'false', BROWSER_SMOKE_RESULT: 'skipped' }).status, 0);
  for (const step of jobs.coverage_reports.steps.filter(
    (entry) => entry.name === '生成覆盖率摘要' || entry.name === '上传覆盖率产物',
  )) {
    assert.match(step.if, /steps\.merge\.outcome == 'success'/u);
  }
});

test('runtime packages and offline browser gates are planned for their source inputs and required on main', () => {
  for (const file of [
    'server/src/index.ts',
    'web/src/App.tsx',
    'acs-orchestrator/src/index.ts',
    'scripts/release/build-release.mjs',
  ]) {
    assert.equal(planCi([file]).releasePackages, true, file);
  }
  for (const file of [
    'web/src/App.tsx',
    'server/src/kyapp/gateway/routes.ts',
    'e2e/ky-app-shell.playwright.config.ts',
  ]) {
    assert.equal(planCi([file]).browserSmoke, true, file);
  }
  assert.equal(planCi(['docs/readme.md']).releasePackages, false);
  assert.equal(planCi(['docs/readme.md']).browserSmoke, false);
  assert.equal(planCi(['docs/readme.md'], 'push').releasePackages, true);
  const jobs = parse(workflow).jobs;
  for (const gate of ['release_packages', 'writer_bundle', 'browser_smoke'])
    assert.ok(jobs.build.needs.includes(gate));
  const upload = jobs.release_packages.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  assert.match(upload.if, /github\.event_name == 'push'.*refs\/heads\/main/u);
  assert.equal(
    upload.with.name,
    'release-packages-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
  );
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.ok(!upload['continue-on-error']);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
