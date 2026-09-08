#!/usr/bin/env bash
# Pinned upstream release. SHA-256 is also published in aliyun/aliyun-cli v3.4.4
# SHASUMS256.txt and GitHub's immutable release-asset digest metadata.
set -euo pipefail
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || { echo 'Aliyun deploy CLI requires Linux x86_64' >&2; exit 1; }
version=3.4.4
expected=11dc3c6999e0e2f3cdac6e38775920e14ace7b52567534ff1222db22ae327684
archive_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/aliyun-cli.XXXXXX")"
trap 'rm -rf "$archive_dir"' EXIT
curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
  "https://github.com/aliyun/aliyun-cli/releases/download/v${version}/aliyun-cli-linux-${version}-amd64.tgz" \
  -o "$archive_dir/aliyun.tgz"
printf '%s  %s\n' "$expected" "$archive_dir/aliyun.tgz" | sha256sum --check --status
tar xzf "$archive_dir/aliyun.tgz" -C "$archive_dir" aliyun
actual="$("$archive_dir/aliyun" version)"
[[ "$actual" == "$version" ]] || { echo "Aliyun version mismatch: $actual" >&2; exit 1; }
sudo install -m 0755 "$archive_dir/aliyun" /usr/local/bin/aliyun
printf 'Aliyun CLI %s; archive sha256:%s; executor %s\n' "$version" "$expected" "$(uname -srmo)"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf 'Deployment CLI: Aliyun `%s`, archive `sha256:%s`.\n' "$version" "$expected" >> "$GITHUB_STEP_SUMMARY"
fi
