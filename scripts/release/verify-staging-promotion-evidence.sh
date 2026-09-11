#!/usr/bin/env bash
set -euo pipefail
manifest="${1:?manifest path required}"
history="${2:?attestation history required}"
directory="${3:?diagnostic directory required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validator="$script_dir/staging-deployment-evidence.mjs"
: "${GITHUB_REPOSITORY:?repository required}"
mkdir -p "$directory"
preflight_check=staging_binding
failure() {
  local result=$?
  trap - ERR
  node "$validator" failure "$directory" "$preflight_check" "$result" || true
  echo "::error title=Staging promotion preflight::Failed check=$preflight_check; production mutation has not started. See report.json in the production evidence artifact."
  exit "$result"
}
trap failure ERR
node "$validator" binding "$directory" "$manifest" "$history"
RELEASE_ID="$(jq -r .releaseId "$directory/binding.json")"
deployment_id="$(jq -r .stagingDeploymentId "$directory/binding.json")"
staging_run_id="$(jq -r .stagingRunId "$directory/binding.json")"
staging_run_attempt="$(jq -r .stagingRunAttempt "$directory/binding.json")"

read_metadata() {
  # Both reads are GET-only. Keep real lifecycle state; never manufacture a success status.
  preflight_check=deployment_lookup
  timeout --kill-after=5s 60s gh api \
    "repos/$GITHUB_REPOSITORY/deployments/$deployment_id" > "$directory/deployment.json"
  preflight_check=deployment_status_history
  timeout --kill-after=5s 120s gh api --paginate --slurp \
    "repos/$GITHUB_REPOSITORY/deployments/$deployment_id/statuses?per_page=100" \
    > "$directory/deployment-statuses.json"
  preflight_check=staging_bound_attempt
  timeout --kill-after=5s 60s gh api \
    "repos/$GITHUB_REPOSITORY/actions/runs/$staging_run_id/attempts/$staging_run_attempt" \
    > "$directory/staging-attempt.json"
  preflight_check=staging_latest_run
  timeout --kill-after=5s 60s gh api \
    "repos/$GITHUB_REPOSITORY/actions/runs/$staging_run_id" > "$directory/staging-run.json"
}
# Explicit ERR inheritance keeps failed API calls inside the function observable and fatal.
set -E
read_metadata
preflight_check=deployment_evidence
node "$validator" verify "$directory" "$manifest" "$history" "$GITHUB_REPOSITORY"
for name in deployment deployment-statuses staging-attempt staging-run; do
  cp "$directory/$name.json" "$directory/$name-initial.json"
done
preflight_check=core_smoke_download
# Do not derive this name from the latest run attempt or fall back to another artifact.
timeout --kill-after=5s 180s gh run download "$staging_run_id" --repo "$GITHUB_REPOSITORY" \
  --name "staging-evidence-$RELEASE_ID-$staging_run_attempt" \
  --dir "$directory/attempt-evidence"
cp "$directory/attempt-evidence/staging-core-smoke.json" "$directory/staging-core-smoke.json"
preflight_check=core_smoke_validation
node "$script_dir/staging-core-smoke-evidence.mjs" \
  "$directory/staging-core-smoke.json" "$manifest" "$staging_run_id" "$staging_run_attempt"
# Every phase requires a parseable, bound database readback. A none plan is not a bypass.
preflight_check=database_readback_validation
legacy_revalidation=false
if ! node "$script_dir/verify-migration-readback.mjs" "$manifest" \
  "$directory/attempt-evidence/staging-database-readback.json" \
  "$directory/staging-attempt.json" "$staging_run_id" "$staging_run_attempt" "$GITHUB_REPOSITORY" \
  > "$directory/database-readback-validation.json"; then
  # Only a proven interrupted transaction and the pinned historical NONE producer qualify.
  # Preserve the invalid archive; append a separately hashed revalidation, never rewrite it.
  # Non-qualifying archives retain the existing database-readback failure classification.
  node "$script_dir/legacy-none-readback-revalidation.mjs" revalidate \
    "$manifest" "$history" "$directory" "$GITHUB_REPOSITORY" \
    > "$directory/database-readback-validation.json"
  legacy_revalidation=true
fi
# Fail closed if a rerun/failure appeared while downloading the evidence.
read_metadata
preflight_check=final_staging_evidence
node "$validator" complete "$directory" "$manifest" "$history" "$GITHUB_REPOSITORY"
if [ "$legacy_revalidation" = true ]; then
  preflight_check=legacy_none_revalidation_binding
  node "$script_dir/legacy-none-readback-revalidation.mjs" bind \
    "$manifest" "$history" "$directory" "$GITHUB_REPOSITORY"
fi
