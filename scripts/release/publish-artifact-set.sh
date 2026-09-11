#!/usr/bin/env bash
set -euo pipefail
source_dir="${1:?source directory required}"
destination="${2:?OSS destination required}"
source_sha="${3:?trusted producer SHA required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$destination" in oss://*) ;; *) echo 'Artifact destination must be OSS' >&2; exit 1 ;; esac
node "$script_dir/verify-artifact.mjs" "$source_dir/artifact-index.json" "$source_sha"
# Materialize before any mutation: a failed find/sort cannot be masked by process substitution.
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
find "$source_dir" -maxdepth 1 -type f ! -name artifact-index.json -print0 | LC_ALL=C sort -z > "$list"
while IFS= read -r -d '' source; do
  bash "$script_dir/upload-oss-object-immutable.sh" "$source" "$destination/$(basename "$source")"
done < "$list"
# Every object above has passed immutable byte readback. A crash before here is safely resumable.
bash "$script_dir/upload-oss-object-immutable.sh" "$source_dir/artifact-index.json" "$destination/artifact-index.json"
