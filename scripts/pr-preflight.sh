#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required for taskboard and PostgreSQL contract checks}"
export MEMORY_CONSOLIDATION_TEST_PG_URL="${MEMORY_CONSOLIDATION_TEST_PG_URL:-$TEST_DATABASE_URL}"

task_script="$(dirname "$0")/pr-preflight-task.sh"

bash "$task_script" checks
bash "$task_script" coverage shared
bash "$task_script" coverage server
bash "$task_script" coverage web
bash "$task_script" postgres
bash "$task_script" web
