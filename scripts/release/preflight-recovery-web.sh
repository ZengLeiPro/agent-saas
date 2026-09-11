#!/usr/bin/env bash
# Read-only prerequisites; the transaction must still re-snapshot under its mutation lock.
set -euo pipefail
root=/opt/agent-saas-web-recovery
test -L "$root/current"
target="$(readlink -f "$root/current")"
case "$target" in "$root"/releases/*) ;; *) echo 'Recovery target escapes its release root' >&2; exit 1 ;; esac
for name in index.html release-identity.json manifest.webmanifest sw.js; do
  test -s "$target/$name" && test -r "$target/$name" && test ! -L "$target/$name"
done
jq -e '.schemaVersion==1 and .environment=="production" and (.releaseSha|test("^[a-f0-9]{40}$")) and (.webDigest|test("^sha256:[a-f0-9]{64}$"))' "$target/release-identity.json" >/dev/null
for directory in "$root" "$root/releases"; do
  test -d "$directory" && test -w "$directory" && test ! -L "$directory"
  test "$(stat -c '%u' "$directory")" = 0
done
# Verify the origin's complete nginx/TLS configuration without reloading anything.
nginx -t >/dev/null
jq -nc --arg sourceSha "$(jq -r .releaseSha "$target/release-identity.json")" \
  '{schemaVersion:1,status:"ready",sourceSha:$sourceSha,scope:"read_only_prerequisites"}'
