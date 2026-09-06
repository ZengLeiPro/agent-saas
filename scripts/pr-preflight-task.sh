#!/usr/bin/env bash
set -euo pipefail

task="${1:-}"

require_test_database() {
  : "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required for PostgreSQL checks}"
  export MEMORY_CONSOLIDATION_TEST_PG_URL="${MEMORY_CONSOLIDATION_TEST_PG_URL:-$TEST_DATABASE_URL}"
}

# checks 覆盖统一 Release 契约套件、发布身份、readiness、兼容 authority 与 rollback 门禁。
case "$task" in
  checks)
    pnpm check:ratchets
    pnpm -r --filter './packages/*' typecheck
    pnpm -r --filter './packages/*' test
    pnpm -r --filter './packages/*' build
    pnpm test:release-contracts
    bash -n scripts/release/production-deploy-rollback.sh
    bash scripts/release/production-deploy-rollback.test.sh
    bash scripts/release/compat-app-authority.test.sh
    bash scripts/release/staging-deploy-cleanup.test.sh
    pnpm check:runtime-dependencies
    pnpm -F server typecheck
    pnpm -F server context:relation-eval:baseline
    pnpm -F server build
    ;;

  coverage)
    workspace="${2:-}"
    case "$workspace" in
      shared|server|web) ;;
      *)
        echo "usage: $0 coverage <shared|server|web>" >&2
        exit 2
        ;;
    esac
    require_test_database
    pnpm -F "$workspace" test:coverage
    ;;

  test)
    # 分片测试：test <shared|server|web> <shard> <total> <full|affected> <base-sha|-> <coverage true|false>
    # affected 用 vitest --changed=<base> 沿静态 import 图选择相关测试（含被改的测试文件本身）；
    # 覆盖率只在 full 模式收集，写成 blob 供 coverage-merge 跨 Runner 合并。
    # blob 目录不用点开头：actions/upload-artifact 默认不打包隐藏目录。
    workspace="${2:-}" shard="${3:-}" total="${4:-}" mode="${5:-full}" base="${6:--}" coverage="${7:-false}"
    case "$workspace" in
      shared|server|web) ;;
      *)
        echo "usage: $0 test <shared|server|web> <shard> <total> [full|affected] [base-sha|-] [true|false]" >&2
        exit 2
        ;;
    esac
    case "$shard:$total" in
      *[!0-9]*:*|*:*[!0-9]*|:*|*:) echo "invalid shard/total: $shard/$total" >&2; exit 2 ;;
    esac
    args=(run "--shard=$shard/$total" --passWithNoTests --reporter=dot)
    if [ "$mode" = affected ]; then
      case "$base" in
        -|'') echo "affected mode requires a base SHA" >&2; exit 2 ;;
      esac
      args+=("--changed=$base")
    fi
    if [ "$coverage" = true ]; then
      args+=(--coverage --reporter=blob "--outputFile=coverage-blobs/blob-$shard-$total.json")
      case "$workspace" in
        server|web) args+=(--maxWorkers=2 --coverage.processingConcurrency=2) ;;
      esac
    fi
    case "$workspace" in
      shared)
        pnpm -F @agent/shared exec vitest "${args[@]}"
        ;;
      server)
        require_test_database
        pnpm -F server exec vitest "${args[@]}"
        ;;
      web)
        # web 的布局/管理壳对比脚本依赖本机 Playwright 浏览器，与旧 CI 一样只在本地 `pnpm -F web test` 执行。
        NODE_ENV=test pnpm -F web exec vitest "${args[@]}" --testTimeout=15000
        ;;
    esac
    ;;

  coverage-merge)
    # 合并分片 blob 为该工作区的最终覆盖率报告（reporter 由 vitest.config 按 COVERAGE_REPORT_MODE 决定）。
    workspace="${2:-}"
    case "$workspace" in
      shared) filter=@agent/shared ;;
      server|web) filter="$workspace" ;;
      *)
        echo "usage: $0 coverage-merge <shared|server|web>" >&2
        exit 2
        ;;
    esac
    test -d "$workspace/coverage-blobs"
    pnpm -F "$filter" exec vitest run --merge-reports=coverage-blobs --coverage
    ;;

  postgres)
    # 显式清单是快速动态合约门禁，新增关键 PG 合约必须在此登记。
    require_test_database
    pnpm -F server exec vitest run \
      src/__tests__/codexCredentialRuntimeState.pg.test.ts \
      src/__tests__/memoryConsolidationStore.pg.test.ts \
      src/__tests__/pgEventStoreGlobalPage.pg.test.ts \
      src/__tests__/sessionShareStore.pg.test.ts \
      src/__tests__/taskboardAttachmentRollback.pg.test.ts \
      src/__tests__/governanceSchemaMigration.pg.test.ts \
      src/__tests__/releaseMigrationUpgrade.pg.test.ts \
      src/__tests__/governanceProjectionPool.pg.test.ts \
      src/__tests__/pgRunStoreSteering.pg.test.ts \
      src/__tests__/pgToolInvocationTerminalGate.pg.test.ts \
      src/__tests__/sandboxScopeActivity.pg.test.ts \
      src/__tests__/taskboardOnReadyTrigger.pg.test.ts \
      src/__tests__/pushDeliveryClaim.pg.test.ts \
      src/__tests__/entitlementScopeBaseline.pg.test.ts \
      src/kyapp/systems/store.pg.test.ts \
      src/kyapp/gateway/snapshotStore.pg.test.ts \
      src/kyapp/__tests__/kyAppStores.pg.test.ts
    pnpm -F @kaiyan/ky-app-server exec vitest run src/sat/pgJtiStore.pg.test.ts src/pg/stores.pg.test.ts
    ;;

  web)
    pnpm -F web check:api-boundary
    pnpm scenarios:lint
    pnpm sanitize-check
    VITE_API_BASE="${VITE_API_BASE:-https://api.agent.kaiyan.net}" \
    VITE_WEB_ORIGIN="${VITE_WEB_ORIGIN:-https://agent.kaiyan.net}" \
      pnpm -F web build:oss
    pnpm check:web-startup-budget -- --dist web/dist
    ;;

  *)
    echo "usage: $0 <checks|coverage|test|coverage-merge|postgres|web> [args]" >&2
    exit 2
    ;;
esac
