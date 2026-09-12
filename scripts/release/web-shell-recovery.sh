#!/usr/bin/env bash
# Runner-side orchestration. All calls execute within the existing fenced Web host lock.
web_journal() {
  local mode="$1" digest="${2:-}" outcome="${3:-}"
  case "$mode" in check|export|save) ;;
    finish) [[ "$digest" =~ ^[a-f0-9]{64}$ ]] && { [ "$outcome" = committed ] || [ "$outcome" = rolled_back ]; } || return 1 ;;
    *) return 1 ;;
  esac
  recovery_ssh "sudo node '$PROMOTION_REMOTE/web-recovery-journal.mjs' '$mode' '$RELEASE_ID' '$MANIFEST_DIGEST' '$digest' '$outcome'"
}
restore_persisted_web() {
  local mode="$1" origin="$RUNNER_TEMP/web-recovery-original.json"
  node scripts/release/web-shell-transaction.mjs "$mode" \
    "$RUNNER_TEMP/web-assets" "$PRODUCTION_WEB_OSS_URI" "$RUNNER_TEMP/web-oss-sdk-credentials.json" \
    "$RUNNER_TEMP/web-original-before" "$(jq -er .releaseId "$origin")" "$(jq -er .manifestDigest "$origin")" \
    "$(jq -er .runId "$origin")" "$(jq -er .runAttempt "$origin")" "$RELEASE_RECORD_OSS_REGION"
}
restore_persisted_cold_web() {
  local origin="$RUNNER_TEMP/web-recovery-original.json" before original_run
  before="$(jq -er .recoveryBefore "$origin")"
  original_run="$(jq -er .runId "$origin").$(jq -er .runAttempt "$origin")"
  recovery_ssh "sudo env RECOVERY_WEB_ROOT='/opt/agent-saas-web-recovery' RECOVERY_WEB_BEFORE_TARGET='$before' RUN_ID='$original_run' bash '$PROMOTION_REMOTE/rollback-recovery-web.sh'"
}
recover_previous_web_transaction() {
  run_with_web_lock bash -euo pipefail -c 'web_journal check' > "$RUNNER_TEMP/web-recovery-state.json"
  if [ "$(jq -r .pending "$RUNNER_TEMP/web-recovery-state.json")" != true ]; then return 0; fi
  run_with_web_lock bash -euo pipefail -c 'web_journal export' > "$RUNNER_TEMP/web-recovery-original.capsule.json"
  node scripts/release/web-recovery-journal.mjs unpack "$RUNNER_TEMP/web-recovery-original.capsule.json" \
    "$RUNNER_TEMP/web-original-before" "$RUNNER_TEMP/web-recovery-original.json"
  # Validate the full OSS restoration boundary BEFORE changing even the cold recovery pointer.
  run_with_web_lock bash -euo pipefail -c 'restore_persisted_web verify-restore'
  run_with_web_lock bash -euo pipefail -c restore_persisted_cold_web
  run_with_web_lock bash -euo pipefail -c 'restore_persisted_web restore' > "$RUNNER_TEMP/web-recovery-restore.json"
  local digest
  digest="$(jq -er .capsuleDigest "$RUNNER_TEMP/web-recovery-state.json")"
  run_with_web_lock bash -euo pipefail -c "web_journal finish '$digest' rolled_back" > "$RUNNER_TEMP/web-recovery-replay.json"
}
persist_web_recovery() {
  node scripts/release/web-recovery-journal.mjs pack "$RUNNER_TEMP/web-before" \
    "$RUNNER_TEMP/recovery-web-target.before" "$RUNNER_TEMP/web-recovery.capsule.json"
  run_with_web_lock bash -euo pipefail -c 'web_journal save < "$RUNNER_TEMP/web-recovery.capsule.json"' > "$RUNNER_TEMP/web-recovery-receipt.json"
  local expected
  expected="$(sha256sum "$RUNNER_TEMP/web-recovery.capsule.json" | cut -d' ' -f1)"
  jq -e --arg digest "$expected" '.pending==true and .capsuleDigest==$digest' "$RUNNER_TEMP/web-recovery-receipt.json" >/dev/null
  # Separate readback proves the host retained the capsule before any mutable object is written.
  run_with_web_lock bash -euo pipefail -c 'web_journal check' > "$RUNNER_TEMP/web-recovery-readback.json"
  jq -e --arg digest "$expected" '.pending==true and .capsuleDigest==$digest' "$RUNNER_TEMP/web-recovery-readback.json" >/dev/null
}
finish_web_recovery() {
  local outcome="$1" digest
  digest="$(jq -er .capsuleDigest "$RUNNER_TEMP/web-recovery-receipt.json")"
  run_with_web_lock bash -euo pipefail -c "web_journal finish '$digest' '$outcome'" > "$RUNNER_TEMP/web-recovery-final.json"
}
export -f web_journal restore_persisted_web restore_persisted_cold_web
