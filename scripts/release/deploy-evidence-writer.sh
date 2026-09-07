#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo 'Usage: deploy-evidence-writer.sh <bundle.tgz> <bundle-digest> <release-sha> <schema-version> <schema-revision>' >&2
  exit 64
fi

archive=$1
expected_digest=$2
release_sha=$3
expected_schema_version=$4
expected_schema_revision=$5
root=/opt/agent-saas-release-evidence
releases=$root/releases
target=$releases/$release_sha
candidate=$releases/.candidate-$release_sha-$$
current=$root/current
next_link=$root/.current-$release_sha-$$
unit=agent-saas-release-evidence-staging.service
token_file=/etc/agent-saas-staging/release-evidence-read.token
capabilities=$(mktemp)
previous=''

cleanup() {
  sudo rm -rf -- "$candidate"
  sudo rm -f -- "$next_link"
  rm -f -- "$capabilities"
}
trap cleanup EXIT

printf '%s' "$release_sha" | grep -Eq '^[a-f0-9]{40}$'
printf '%s' "$expected_digest" | grep -Eq '^sha256:[a-f0-9]{64}$'
printf '%s' "$expected_schema_version" | grep -Eq '^[1-9][0-9]*$'
printf '%s' "$expected_schema_revision" | grep -Eq '^[1-9][0-9]*$'
actual_digest="sha256:$(sha256sum "$archive" | awk '{print $1}')"
test "$actual_digest" = "$expected_digest"

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
  echo 'Evidence Writer current release is missing' >&2
  exit 1
fi
case "$previous" in
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
sudo mv -Tf "$next_link" "$current"
if ! sudo systemctl restart "$unit" || ! sudo systemctl is-active --quiet "$unit"; then
  if [ -n "$previous" ]; then
    sudo ln -s "$previous" "$next_link"
    sudo mv -Tf "$next_link" "$current"
    sudo systemctl restart "$unit"
  fi
  echo 'Evidence Writer failed to start; restored the previous release' >&2
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
      value.releaseEvidenceSchemaRevision !== Number(process.argv[3])
    ) process.exit(1);
  ' "$capabilities" "$expected_schema_version" "$expected_schema_revision"
then
  sudo systemctl status "$unit" --no-pager >&2 || true
  sudo journalctl -u "$unit" -n 80 --no-pager >&2 || true
  if [ -n "$previous" ]; then
    sudo ln -s "$previous" "$next_link"
    sudo mv -Tf "$next_link" "$current"
    sudo systemctl restart "$unit"
  fi
  echo 'Evidence Writer capability verification failed; restored the previous release' >&2
  exit 1
fi

printf '%s\n' "$release_sha" | sudo tee "$root/deployed-release-sha" >/dev/null
echo "Evidence Writer deployed: $release_sha"
