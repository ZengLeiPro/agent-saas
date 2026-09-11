#!/usr/bin/env bash
set -euo pipefail
# Runner-side transport only. The host command contains two allowlisted read-only readers.
remote="${1:?remote payload required}"
key="${2:?SSH key path required}"
reader="${3:?reader required}"
stage="${4:?stage required}"
output="${5:?remote output basename required}"
retry_mode="${6:-fresh}"
[[ "$remote" =~ ^/tmp/release-(preflight|evidence)-[1-9][0-9]*-[1-9][0-9]*$ ]]
case "$reader:$stage" in read-production-state.mjs:steady-state|read-live-production-components.mjs:steady-state|read-live-production-components.mjs:candidate-readback) ;; *) exit 2 ;; esac
case "$output" in production-before.json|production.json) ;; *) exit 2 ;; esac
case "$retry_mode" in fresh|retry_before_change|retry_after_change) ;; *) exit 2 ;; esac
[[ "${GITHUB_RUN_ID:?}" =~ ^[1-9][0-9]*$ ]]
[[ "${GITHUB_RUN_ATTEMPT:?}" =~ ^[1-9][0-9]*$ ]]
: "${RUNNER_TEMP:?}" "${ECS_USER:?}" "${ECS_HOST:?}"
reader_exit=0
if timeout --signal=TERM --kill-after=5 100 ssh -o ConnectTimeout=10 -i "$key" "$ECS_USER@$ECS_HOST" \
  "sudo -n node '$remote/production-preflight.mjs' --reader '$reader' --config-identity-stage '$stage' --output '$remote/$output' --diagnostics '$remote/production-preflight.json' --run-id '$GITHUB_RUN_ID' --run-attempt '$GITHUB_RUN_ATTEMPT' --retry-mode '$retry_mode'"; then
  reader_exit=0
else
  reader_exit=$?
fi
capture_exit=0
if timeout --signal=TERM --kill-after=2 15 ssh -o ConnectTimeout=10 -i "$key" "$ECS_USER@$ECS_HOST" \
  "sudo -n cat '$remote/production-preflight.json'" > "$RUNNER_TEMP/production-preflight.json.partial"; then
  mv "$RUNNER_TEMP/production-preflight.json.partial" "$RUNNER_TEMP/production-preflight.json"
else
  capture_exit=$?
  rm -f "$RUNNER_TEMP/production-preflight.json.partial"
  echo '::warning title=Production preflight diagnostics::Unable to retrieve host diagnostics; original reader outcome is preserved.'
fi
if ! node "$(dirname "$0")/production-preflight-report.mjs" transfer \
  "$RUNNER_TEMP/production-preflight-transfer.json" "$reader_exit" "$capture_exit"; then
  echo '::warning title=Production preflight diagnostics::Unable to persist transport diagnostics; original reader outcome is preserved.'
fi
exit "$reader_exit"
