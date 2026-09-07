#!/usr/bin/env bash
set -euo pipefail
mode="$1"
[[ "$mode" = before || "$mode" = final ]]
# Failed probes are represented as unknown, never silently treated as restored.
curl -fsS --connect-timeout 5 --max-time 20 "$STAGING_API_URL/api/healthz/ready" > "$RUNNER_TEMP/staging-api-probe.json" || true
curl -fsS --connect-timeout 5 --max-time 20 "$STAGING_WEB_URL/release-identity.json" > "$RUNNER_TEMP/staging-web-probe.json" || true
ssh -o ConnectTimeout=10 -i ~/.ssh/staging_key "$STAGING_ECS_USER@$STAGING_ECS_HOST" \
  'curl -fsS --max-time 20 http://127.0.0.1:3410/health' > "$RUNNER_TEMP/staging-acs-probe.json" || true
ssh -o ConnectTimeout=10 -i ~/.ssh/staging_key "$STAGING_ECS_USER@$STAGING_ECS_HOST" \
  'node --input-type=module' < scripts/release/observe-staging-host.mjs > "$RUNNER_TEMP/staging-host-probe.json" || true
node scripts/release/staging-final-state.mjs "$RUNNER_TEMP" "$mode"
