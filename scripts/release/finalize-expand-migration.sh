#!/usr/bin/env bash
# 在 Promotion 的生产互斥组内自动收尾；本脚本只读生产运行态并写入发布凭证，不执行 SQL。
set -euo pipefail
mode="$(node scripts/release/promotion-finalization-mode.mjs \
  "$RUNNER_TEMP/manifest.json" "$RUNNER_TEMP/attestations/$RELEASE_ID.jsonl" "$GITHUB_RUN_ID")"
MIGRATION_PLAN_DIGEST="$(jq -r .migrationPlan.planDigest "$RUNNER_TEMP/manifest.json")"
if [ "$mode" = repair ]; then
  # GitHub 已落 completed 时，仅修复同一 run 的 OSS 镜像，绝不再次部署或追加状态。
  snapshot_json="$(node scripts/release/attestation-snapshot.mjs create \
    "$RUNNER_TEMP/attestations/$RELEASE_ID.jsonl" "$RUNNER_TEMP/attestation-snapshots")"
  snapshot_path="$(printf '%s' "$snapshot_json" | jq -r .path)"
  bash scripts/release/upload-oss-object-immutable.sh "$snapshot_path" \
    "$RELEASE_RECORD_OSS_URI/records/$RELEASE_ID/attestations/$(basename "$snapshot_path")"
  echo '已从 GitHub completed 凭证修复 OSS 镜像' >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi
test "$mode" = confirm
set -euo pipefail
remote="/tmp/expand-confirmation-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
lock_token="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-expand-confirmation"
lock_log="$RUNNER_TEMP/expand-confirmation-lock.log"
lock_pid=''
guarded_pid=''
lock_ready_confirmed=false
assert_lock() {
  ssh -i ~/.ssh/production_key "$ECS_USER@$ECS_HOST" \
    "sudo bash -s -- assert '$lock_token'" \
    < scripts/release/production-lock-lease.sh
}
run_locked_ssh() {
  assert_lock
  ssh -i ~/.ssh/production_key "$ECS_USER@$ECS_HOST" "$1"
  assert_lock
}
terminate_guarded() {
  [ -n "$guarded_pid" ] || return 0
  kill -- "-$guarded_pid" 2>/dev/null || kill "$guarded_pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 -- "-$guarded_pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 -- "-$guarded_pid" 2>/dev/null; then
    kill -KILL -- "-$guarded_pid" 2>/dev/null || true
  fi
  wait "$guarded_pid" 2>/dev/null || true
  guarded_pid=''
}
run_guarded() {
  assert_lock
  setsid "$@" &
  guarded_pid=$!
  next_owner_check=$SECONDS
  while kill -0 -- "-$guarded_pid" 2>/dev/null; do
    if ! kill -0 "$lock_pid" 2>/dev/null; then
      terminate_guarded
      cat "$lock_log" >&2
      echo 'Production host lock holder exited during a guarded confirmation operation' >&2
      return 70
    fi
    if [ "$SECONDS" -ge "$next_owner_check" ]; then
      if ! assert_lock; then
        terminate_guarded
        echo 'Production host lock owner proof was lost during a guarded confirmation operation' >&2
        return 70
      fi
      next_owner_check=$((SECONDS + 1))
    fi
    sleep 0.2
  done
  guarded_status=0
  wait "$guarded_pid" || guarded_status=$?
  guarded_pid=''
  [ "$guarded_status" -eq 0 ] || return "$guarded_status"
  assert_lock
}
terminate_lock() {
  [ -n "$lock_pid" ] || return 0
  kill -- "-$lock_pid" 2>/dev/null || kill "$lock_pid" 2>/dev/null || true
  wait "$lock_pid" 2>/dev/null || true
  lock_pid=''
}
cleanup() {
  status=$?
  trap - EXIT
  set +e
  cleanup_status=0
  terminate_guarded
  if [ "$lock_ready_confirmed" = true ]; then
    release_status=0
    ssh -i ~/.ssh/production_key "$ECS_USER@$ECS_HOST" \
      "sudo bash -s -- release '$lock_token'" \
      < scripts/release/production-lock-lease.sh || release_status=$?
    if [ "$release_status" -ne 0 ]; then
      cleanup_status="$release_status"
      terminate_lock
    fi
  else
    terminate_lock
  fi
  if [ -n "$lock_pid" ]; then
    wait "$lock_pid" || cleanup_status=$?
    lock_pid=''
  fi
  ssh -i ~/.ssh/production_key "$ECS_USER@$ECS_HOST" "rm -rf -- '$remote'" || true
  [ "$cleanup_status" -eq 0 ] || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM INT

ssh -i ~/.ssh/production_key "$ECS_USER@$ECS_HOST" "mkdir -p '$remote'"
scp -i ~/.ssh/production_key \
  scripts/release/artifact-lib.mjs \
  scripts/release/read-live-production-components.mjs \
  scripts/release/read-production-state.mjs \
  scripts/release/read-runtime-identity.mjs \
  scripts/release/verify-installed-release.mjs \
  "$ECS_USER@$ECS_HOST:$remote/"

# 租约长于外层 30 分钟自动收尾上限，上传及提交期间持续验证持有者。
setsid timeout --signal=TERM --kill-after=10 7250 ssh \
  -o ConnectTimeout=10 -o ServerAliveInterval=1 -o ServerAliveCountMax=2 \
  -i ~/.ssh/production_key "$ECS_USER@$ECS_HOST" \
  "sudo env PRODUCTION_LOCK_TIMEOUT_SECONDS=7200 bash -s -- hold '$lock_token'" \
  < scripts/release/production-lock-lease.sh > "$lock_log" 2>&1 &
lock_pid=$!
lock_ready=false
lock_ready_deadline=$((SECONDS + 75))
while [ "$SECONDS" -lt "$lock_ready_deadline" ]; do
  if assert_lock; then
    lock_ready=true
    break
  fi
  if ! kill -0 "$lock_pid" 2>/dev/null; then
    wait "$lock_pid" 2>/dev/null || true
    lock_pid=''
    break
  fi
  sleep 1
done
if [ "$lock_ready" != true ]; then
  terminate_lock
  cat "$lock_log" >&2
  exit 1
fi
lock_ready_confirmed=true

run_locked_ssh \
  "sudo node '$remote/read-live-production-components.mjs' --output '$remote/live-initial.json' >/dev/null"
run_guarded scp -i ~/.ssh/production_key \
  "$ECS_USER@$ECS_HOST:$remote/live-initial.json" \
  "$RUNNER_TEMP/production-live-initial.json"
run_guarded curl -fsS --retry 10 \
  'https://api.agent.kaiyan.net/api/healthz/ready' \
  > "$RUNNER_TEMP/production-api-ready-initial.json"
run_guarded node scripts/release/confirm-expand-migration.mjs \
  --manifest "$RUNNER_TEMP/manifest.json" \
  --attestations "$RUNNER_TEMP/attestations/$RELEASE_ID.jsonl" \
  --live "$RUNNER_TEMP/production-live-initial.json" \
  --api-ready "$RUNNER_TEMP/production-api-ready-initial.json" \
  --output "$RUNNER_TEMP/migration-confirmation-initial.json"

# completed 提交前在同一锁租约内重新读取；任一组件/API 漂移均 fail closed。
run_locked_ssh \
  "sudo node '$remote/read-live-production-components.mjs' --output '$remote/live-final.json' >/dev/null"
run_guarded scp -i ~/.ssh/production_key \
  "$ECS_USER@$ECS_HOST:$remote/live-final.json" \
  "$RUNNER_TEMP/production-live.json"
run_guarded curl -fsS --retry 10 \
  'https://api.agent.kaiyan.net/api/healthz/ready' \
  > "$RUNNER_TEMP/production-api-ready.json"
run_guarded node scripts/release/confirm-expand-migration.mjs \
  --manifest "$RUNNER_TEMP/manifest.json" \
  --attestations "$RUNNER_TEMP/attestations/$RELEASE_ID.jsonl" \
  --live "$RUNNER_TEMP/production-live.json" \
  --api-ready "$RUNNER_TEMP/production-api-ready.json" \
  --output "$RUNNER_TEMP/migration-confirmation.json"
diff -u \
  <(jq -S 'del(.liveObservedAt,.confirmedAt)' "$RUNNER_TEMP/migration-confirmation-initial.json") \
  <(jq -S 'del(.liveObservedAt,.confirmedAt)' "$RUNNER_TEMP/migration-confirmation.json")
assert_lock

confirmation_digest="sha256:$(sha256sum "$RUNNER_TEMP/migration-confirmation.json" | cut -d' ' -f1)"
# 先按内容 digest 持久化最终锁内读回；只有成功落盘后才能追加 completed。
run_guarded bash scripts/release/upload-oss-object-immutable.sh \
  "$RUNNER_TEMP/migration-confirmation.json" \
  "$RELEASE_RECORD_OSS_URI/records/$RELEASE_ID/migration-confirmations/${confirmation_digest#sha256:}.json"
reason="$(jq -c --arg operatorReason "$CONFIRMATION_REASON" \
  --arg confirmationEvidenceDigest "$confirmation_digest" \
  '. + {operatorReason:$operatorReason,confirmationEvidenceDigest:$confirmationEvidenceDigest}' \
  "$RUNNER_TEMP/migration-confirmation.json")"
run_guarded pnpm exec tsx server/src/release/releaseAttestationCli.ts \
  --root "$RUNNER_TEMP/attestations" --release-id "$RELEASE_ID" \
  --digest "$MANIFEST_DIGEST" --state completed \
  --operation "expand-confirmation:$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT" \
  --actor "$GITHUB_ACTOR" --reason "$reason" \
  --confirmation-evidence "$RUNNER_TEMP/migration-confirmation.json"
run_guarded node scripts/release/attestation-snapshot.mjs create \
  "$RUNNER_TEMP/attestations/$RELEASE_ID.jsonl" "$RUNNER_TEMP/attestation-snapshots" \
  > "$RUNNER_TEMP/attestation-snapshot-result.json"
snapshot_path="$(jq -r .path "$RUNNER_TEMP/attestation-snapshot-result.json")"
# GitHub Release 是重跑读取源；其成功后再镜像 OSS，失败重跑不会生成分叉状态。
run_guarded bash scripts/release/upload-github-release-asset-immutable.sh \
  "$RELEASE_ID" "$snapshot_path"
run_guarded bash scripts/release/upload-oss-object-immutable.sh "$snapshot_path" \
  "$RELEASE_RECORD_OSS_URI/records/$RELEASE_ID/attestations/$(basename "$snapshot_path")"
{
  echo '### Expand migration confirmation'
  echo "- Release: \`$RELEASE_ID\`"
  echo "- Manifest: \`$MANIFEST_DIGEST\`"
  echo "- Migration plan: \`$MIGRATION_PLAN_DIGEST\`"
  echo '- Result: completed after two Production live readbacks under one host lock lease'
} >> "$GITHUB_STEP_SUMMARY"
