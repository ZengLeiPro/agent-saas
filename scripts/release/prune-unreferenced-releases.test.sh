#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
helper="$script_dir/prune-unreferenced-releases.sh"
bash -n "$helper"
# shellcheck disable=SC1090
source "$helper"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

root="$tmp/releases"
mkdir -p "$root/current-rc" "$root/previous-rc" "$root/old-rc" "$root/stale-rc"
printf 'current\n' > "$root/current-rc/marker"
printf 'previous\n' > "$root/previous-rc/marker"
printf 'old\n' > "$root/old-rc/marker"
printf 'stale\n' > "$root/stale-rc/marker"
ln -sfn "$root/current-rc" "$tmp/current"

prune_unreferenced_release_dirs "$root" "$tmp/current" "$root/previous-rc"
test -d "$root/current-rc"
test -d "$root/previous-rc"
test ! -e "$root/old-rc"
test ! -e "$root/stale-rc"
test "$(cat "$root/current-rc/marker")" = current
test "$(cat "$root/previous-rc/marker")" = previous

# Failure rollback must not call prune: an extra dir remains if we never invoke it.
mkdir -p "$root/failed-extra"
test -d "$root/failed-extra"

# Refuse symlink children.
ln -s "$root/current-rc" "$root/alias"
if prune_unreferenced_release_dirs "$root" "$root/current-rc" "$root/previous-rc" 2>"$tmp/symlink.err"; then
  echo 'expected symlink prune to fail' >&2
  exit 1
fi
grep -F 'refuse to prune release symlink' "$tmp/symlink.err" >/dev/null
rm -f "$root/alias"

# Idle-color digest must survive even if it is not mtime-newest.
app="$tmp/app-releases"
mkdir -p "$app/idle-digest" "$app/active-digest" "$app/newest-unreferenced"
touch "$app/idle-digest/.keep" "$app/active-digest/.keep" "$app/newest-unreferenced/.keep"
ln -sfn "$app/active-digest" "$tmp/color-blue"
ln -sfn "$app/idle-digest" "$tmp/color-green"
prune_unreferenced_release_dirs "$app" "$tmp/color-blue" "$tmp/color-green"
test -d "$app/idle-digest"
test -d "$app/active-digest"
test ! -e "$app/newest-unreferenced"

# Prefixed rollback dirs: keep current+previous ids only.
state="$tmp/state"
mkdir -p \
  "$state/rollback-rc-new-1" \
  "$state/rollback-rc-old-1" \
  "$state/rollback-rc-prev-9"
prune_unreferenced_prefixed_dirs "$state/rollback-" rollback-rc-new rollback-rc-prev
test -d "$state/rollback-rc-new-1"
test -d "$state/rollback-rc-prev-9"
test ! -e "$state/rollback-rc-old-1"

# Artifacts keyed by release id / sha.
arts="$tmp/artifacts"
mkdir -p "$arts"
printf 'keep-current\n' > "$arts/sha-current.111.1.tgz"
printf 'keep-prev\n' > "$arts/sha-prev.222.1.tgz"
printf 'drop\n' > "$arts/sha-old.333.1.tgz"
printf 'repair\n' > "$arts/sha-current-repair-9.tgz"
prune_unreferenced_files_matching_keep_ids "$arts" sha-current sha-prev
test -f "$arts/sha-current.111.1.tgz"
test -f "$arts/sha-prev.222.1.tgz"
test -f "$arts/sha-current-repair-9.tgz"
test ! -e "$arts/sha-old.333.1.tgz"

# Empty keep set is refuse.
if prune_unreferenced_release_dirs "$root" 2>"$tmp/empty.err"; then
  echo 'expected empty keep set to fail' >&2
  exit 1
fi
grep -F 'at least one keep path' "$tmp/empty.err" >/dev/null

echo 'prune-unreferenced-releases.test.sh ok'
