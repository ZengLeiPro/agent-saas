#!/usr/bin/env bash
set -euo pipefail

task="${1:-}"

require_test_database() {
  : "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required for PostgreSQL checks}"
  export MEMORY_CONSOLIDATION_TEST_PG_URL="${MEMORY_CONSOLIDATION_TEST_PG_URL:-$TEST_DATABASE_URL}"
}

# checks 同时覆盖发布身份、兼容 authority 与 rollback 契约，避免矩阵化 CI 遗漏 release 门禁。
case "$task" in
  checks)
    pnpm check:ratchets
    node --test \
      scripts/release/config-identity-release.test.mjs \
      scripts/release/legacy-production-workflows.test.mjs \
      scripts/release/promotion-workflow.test.mjs \
      scripts/release/staging-workflow.test.mjs
    bash -n scripts/release/production-deploy-rollback.sh
    bash scripts/release/production-deploy-rollback.test.sh
    bash scripts/release/compat-app-authority.test.sh
    bash scripts/release/staging-deploy-cleanup.test.sh
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
      src/__tests__/governanceProjectionPool.pg.test.ts \
      src/__tests__/pgRunStoreSteering.pg.test.ts \
      src/__tests__/pgToolInvocationTerminalGate.pg.test.ts \
      src/__tests__/sandboxScopeActivity.pg.test.ts
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
    echo "usage: $0 <checks|coverage|postgres|web> [workspace]" >&2
    exit 2
    ;;
esac
