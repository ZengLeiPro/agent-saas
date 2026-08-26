#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required for taskboard and PostgreSQL contract checks}"
export MEMORY_CONSOLIDATION_TEST_PG_URL="${MEMORY_CONSOLIDATION_TEST_PG_URL:-$TEST_DATABASE_URL}"

pnpm check:ratchets
pnpm -F server typecheck
pnpm -F server context:relation-eval:baseline
pnpm -F server build
pnpm test:coverage

pnpm -F server exec vitest run \
  src/__tests__/memoryConsolidationStore.pg.test.ts \
  src/__tests__/pgEventStoreGlobalPage.pg.test.ts \
  src/__tests__/sessionShareStore.pg.test.ts \
  src/__tests__/taskboardAttachmentRollback.pg.test.ts \
  src/__tests__/governanceSchemaMigration.pg.test.ts \
  src/__tests__/governanceProjectionPool.pg.test.ts \
  src/__tests__/pgRunStoreSteering.pg.test.ts \
  src/__tests__/pgToolInvocationTerminalGate.pg.test.ts

pnpm -F web check:api-boundary
pnpm scenarios:lint
pnpm sanitize-check
VITE_API_BASE="${VITE_API_BASE:-https://api.agent.kaiyan.net}" \
VITE_WEB_ORIGIN="${VITE_WEB_ORIGIN:-https://agent.kaiyan.net}" \
pnpm -F web build:oss
pnpm check:web-startup-budget -- --dist web/dist
