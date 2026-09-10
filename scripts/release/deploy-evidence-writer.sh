#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 6 ] || [ "$#" -gt 7 ]; then
  echo 'Usage: deploy-evidence-writer.sh <bundle.tgz> <bundle-digest> <release-sha> <schema-version> <schema-revision> <implementation-digest>' >&2
  exit 64
fi

# A runner may disappear while another workflow retries; the host owns the mutation lock.
if [ "$(id -u)" -ne 0 ]; then
  exec sudo bash "$0" "$@"
fi
install -d -m 0755 /run/lock/agent-saas-release-evidence
exec 9>/run/lock/agent-saas-release-evidence/deploy.lock
flock -w 300 9 || { echo 'Another Evidence Writer deployment is active' >&2; exit 1; }

archive=$1
expected_digest=$2
release_sha=$3
expected_schema_version=$4
expected_schema_revision=$5
expected_implementation_digest=$6
printf '%s' "$release_sha" | grep -Eq '^[a-f0-9]{40}$'
printf '%s' "$expected_digest" | grep -Eq '^sha256:[a-f0-9]{64}$'
printf '%s' "$expected_schema_version" | grep -Eq '^[1-9][0-9]*$'
printf '%s' "$expected_schema_revision" | grep -Eq '^[1-9][0-9]*$'
printf '%s' "$expected_implementation_digest" | grep -Eq '^sha256:[a-f0-9]{64}$'
root=/opt/agent-saas-release-evidence
releases=$root/releases
target=$releases/${expected_digest#sha256:}
candidate=$releases/.candidate-$release_sha-$$
current=$root/current
next_link=$root/.current-$release_sha-$$
unit=agent-saas-release-evidence-staging.service
token_file=/etc/agent-saas-staging/release-evidence-read.token
capabilities=$(mktemp)
previous=''
committed=false
switched=false

cleanup() {
  local status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [ "$switched" = true ] && [ "$committed" != true ] && [ -n "$previous" ]; then
    sudo rm -f -- "$next_link"
    if ! sudo ln -s "$previous" "$next_link" ||
       ! sudo mv -Tf "$next_link" "$current" ||
       ! sudo systemctl restart "$unit" ||
       ! sudo systemctl is-active --quiet "$unit"; then
      echo 'ERROR: Evidence Writer rollback failed; current state requires recovery' >&2
      status=1
    else
      echo 'Evidence Writer restored its previous process; next attempt will verify capabilities' >&2
    fi
  fi
  sudo rm -rf -- "$candidate"
  sudo rm -f -- "$next_link"
  rm -f -- "$capabilities"
  return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

actual_digest="sha256:$(sha256sum "$archive" | awk '{print $1}')"
test "$actual_digest" = "$expected_digest"

# Recheck after acquiring the lock, not from the runner's potentially stale capability probe.
if [ -f "$current/writer-identity.json" ]; then
  if node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1]));process.exit(v.implementationDigest===process.argv[2] && v.releaseEvidenceSchemaVersion===Number(process.argv[3]) && v.releaseEvidenceSchemaRevision>=Number(process.argv[4])?0:1)' \
      "$current/writer-identity.json" "$expected_implementation_digest" "$expected_schema_version" "$expected_schema_revision"; then
    echo 'Writer already supplies the requested implementation; no mutation'
    exit 0
  fi
fi
if [ -f "$root/deployed-release-sha" ]; then
  previous_sha="$(cat "$root/deployed-release-sha")"
  if [ "$previous_sha" != "$release_sha" ]; then
    ancestors="${7:-}"
    [ -f "$ancestors" ] && grep -Fx "$release_sha" "$ancestors" >/dev/null && \
      grep -Fx "$previous_sha" "$ancestors" >/dev/null || {
      echo 'Refusing an older or divergent Writer engine; refresh from a descendant commit' >&2; exit 1;
    }
  fi
fi
sudo install -d -m 0755 "$root" "$releases"
if sudo test -L "$current"; then
  previous=$(sudo readlink -f "$current")
elif sudo test -d "$current"; then
  previous=$releases/legacy-before-$release_sha
  if sudo test -e "$previous"; then
    echo 'Evidence Writer legacy rollback target already exists' >&2
    exit 1
  fi
  sudo mv "$current" "$previous"
  if ! sudo ln -s "$previous" "$current"; then
    sudo mv "$previous" "$current"
    echo 'Evidence Writer could not convert the current directory to an atomic release link' >&2
    exit 1
  fi
else
  # A trusted artifact may bootstrap missing code, but must not invent service credentials.
  sudo test -f "$token_file"
  sudo systemctl cat "$unit" >/dev/null
fi
case "$previous" in
  '') ;;
  "$releases"/*) ;;
  *) echo 'Evidence Writer current release escapes the immutable releases root' >&2; exit 1 ;;
esac
if sudo test -e "$target"; then
  test "$(sudo cat "$target/.bundle-digest")" = "$expected_digest"
else
  sudo install -d -m 0755 "$candidate"
  sudo tar -xzf "$archive" -C "$candidate"
  printf '%s\n' "$expected_digest" | sudo tee "$candidate/.bundle-digest" >/dev/null
  sudo chown -R root:root "$candidate"
  sudo chmod -R a-w "$candidate"
  sudo mv "$candidate" "$target"
fi

sudo ln -s "$target" "$next_link"
switched=true
sudo mv -Tf "$next_link" "$current"
if ! sudo systemctl restart "$unit" || ! sudo systemctl is-active --quiet "$unit"; then
  echo 'Evidence Writer failed to start' >&2
  exit 1
fi

read_token=$(sudo cat "$token_file")
if ! curl -fsS --retry 5 --retry-all-errors --connect-timeout 5 --max-time 15 \
  -H "authorization: Bearer $read_token" http://127.0.0.1:3420/capabilities \
  > "$capabilities" ||
  ! node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (
      value.service !== "agent-saas-release-evidence" ||
      value.currentReleaseEvidenceSchemaVersion !== Number(process.argv[2]) ||
      value.releaseEvidenceSchemaRevision !== Number(process.argv[3]) ||
      value.implementationDigest !== process.argv[4]
    ) process.exit(1);
  ' "$capabilities" "$expected_schema_version" "$expected_schema_revision" "$expected_implementation_digest"
then
  sudo systemctl status "$unit" --no-pager >&2 || true
  sudo journalctl -u "$unit" -n 80 --no-pager >&2 || true
  echo 'Evidence Writer capability verification failed' >&2
  exit 1
fi

printf '%s\n' "$release_sha" | sudo tee "$root/deployed-release-sha" >/dev/null
committed=true
echo "Evidence Writer deployed: $release_sha"
