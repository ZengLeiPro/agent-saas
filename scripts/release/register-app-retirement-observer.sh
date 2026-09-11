#!/usr/bin/env bash
# Register a reboot-resumable, read-only observer before asking the pinned generations to drain.
set -euo pipefail
payload="${1:?payload required}"
run="$(jq -er .runId "$payload/app-retirement-targets.json")"
attempt="$(jq -er .runAttempt "$payload/app-retirement-targets.json")"
[[ "$run" =~ ^[1-9][0-9]*$ && "$attempt" =~ ^[1-9][0-9]*$ ]]
root="/var/lib/agent-saas-release-recovery/retirements/$run-$attempt"
unit="agent-saas-retirement-$run-$attempt.service"
[ ! -L "$root" ] || exit 1
install -d -m 0700 "$root"
for file in manifest.json app-retirement-targets.json app-retirement-evidence.mjs observe-app-retirement.sh; do
  if [ -e "$root/$file" ]; then cmp "$payload/$file" "$root/$file"; else install -m 0600 "$payload/$file" "$root/$file"; fi
done
sync -f "$root"
candidate="$root/$unit.candidate"
cat > "$candidate" <<UNIT
[Unit]
Description=Read-only retirement proof for release operation $run-$attempt
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/bash $root/observe-app-retirement.sh $root
TimeoutStartSec=7350
Nice=10
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
install -m 0644 "$candidate" "/etc/systemd/system/$unit"
systemctl daemon-reload
# No --wait: the old generations must still receive their drain signals below.
systemctl enable "$unit" >/dev/null
systemctl start --no-block "$unit"
