#!/usr/bin/env bash
set -euo pipefail

release_id="${1:?release id is required}"
asset_path="${2:?asset path is required}"
asset_name="$(basename "$asset_path")"
[[ "$release_id" =~ ^rc-[0-9]{8}-[0-9]{2,}$ ]]
test -f "$asset_path"
test -n "${GH_TOKEN:-}"

metadata="$(mktemp)"
download_root="$(mktemp -d)"
cleanup() { rm -f "$metadata"; rm -rf "$download_root"; }
trap cleanup EXIT
gh release view "$release_id" --json assets > "$metadata"
if jq -e --arg name "$asset_name" '.assets[] | select(.name==$name)' "$metadata" >/dev/null; then
  gh release download "$release_id" --dir "$download_root" --pattern "$asset_name"
  cmp "$asset_path" "$download_root/$asset_name"
else
  gh release upload "$release_id" "$asset_path"
fi
