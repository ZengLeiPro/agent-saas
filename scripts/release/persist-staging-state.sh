#!/usr/bin/env bash
# JSON arrives on stdin from the pinned runner; no shell interpolation of its content.
set -euo pipefail
[ "${1:-}" = before ] || [ "${1:-}" = final ] || exit 64
mode="$1"
root=/var/lib/agent-saas-staging
install -d -m 0700 "$root"
exec 9>"$root/deployment-state.lock"
flock -w 30 9
candidate="$(mktemp "$root/.deployment-state.XXXXXX")"
trap 'rm -f "$candidate"' EXIT
cat > "$candidate"
jq -e '.schemaVersion==1 and (.releaseId|test("^rc-[0-9]{8}-[0-9]{2,}$")) and (.manifestDigest|test("^sha256:[a-f0-9]{64}$")) and (.runId|test("^[1-9][0-9]*$")) and (.runAttempt|test("^[1-9][0-9]*$"))' "$candidate" >/dev/null
if [ "$mode" = before ] && [ -e "$root/deployment-state.json" ]; then
  # Missing/unreadable/invalid prior state is not treated as a clean baseline.
  jq -e '.schemaVersion==1 and .repairStrategy=="forward_only"' "$root/deployment-state.json" >/dev/null
  jq -e '.state!="unknown"' "$candidate" >/dev/null || {
    echo 'Cannot reconcile a previous staging attempt: current component identities are unknown' >&2; exit 1;
  }
fi
chmod 0600 "$candidate"
mv -f "$candidate" "$root/deployment-state.json"
