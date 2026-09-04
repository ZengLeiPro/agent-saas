#!/usr/bin/env bash
set -euo pipefail

MODE="${1:?usage: seal-root-staged-payload.sh <verify|extract> <sha256> <archive> <destination>}"
# The archive and its dedicated Production staging directory are already root-owned here.
EXPECTED_SHA256="${2:?missing expected SHA-256}"
ARCHIVE="${3:?missing staged archive}"
DESTINATION="${4:?missing staging destination}"
ALLOWED_ROOT="${STAGED_PAYLOAD_ALLOWED_ROOT:-/run/agent-saas-production-staging}"

case "$MODE" in
  verify|extract) ;;
  *) echo "unsupported staged payload mode: $MODE" >&2; exit 64 ;;
esac
printf '%s' "$EXPECTED_SHA256" | grep -Eq '^[a-f0-9]{64}$'

allowed_root_abs="$(realpath -m -- "$ALLOWED_ROOT")"
destination_abs="$(realpath -m -- "$DESTINATION")"
archive_abs="$(realpath -m -- "$ARCHIVE")"
case "$destination_abs" in
  "$allowed_root_abs"/*) ;;
  *) echo "staging destination escapes the allowed root" >&2; exit 65 ;;
esac
case "$archive_abs" in
  "$destination_abs"/*) ;;
  *) echo "staged archive escapes its dedicated destination" >&2; exit 65 ;;
esac

cleanup_failure() {
  status=$?
  if [ "$status" -ne 0 ]; then rm -rf -- "$destination_abs"; fi
  exit "$status"
}
trap cleanup_failure EXIT

test -d "$destination_abs"
test -f "$archive_abs"
test ! -L "$destination_abs"
test ! -L "$archive_abs"
actual_sha256="$(sha256sum "$archive_abs" | cut -d' ' -f1)"
test "$actual_sha256" = "$EXPECTED_SHA256"

entries_file="$destination_abs/.archive-entries"
listing_file="$destination_abs/.archive-listing"
tar -tzf "$archive_abs" > "$entries_file"
LC_ALL=C tar -tvzf "$archive_abs" > "$listing_file"
while IFS= read -r entry; do
  normalized="${entry#./}"
  case "$normalized" in
    ''|.) ;;
    /*|..|../*|*/..|*/../*)
      echo "unsafe archive entry: $entry" >&2
      exit 66
      ;;
  esac
done < "$entries_file"
while IFS= read -r listing; do
  case "${listing:0:1}" in
    -|d) ;;
    *)
      echo "archive links and special files are forbidden" >&2
      exit 66
      ;;
  esac
done < "$listing_file"
rm -f -- "$entries_file" "$listing_file"

if [ "$MODE" = extract ]; then
  extract_root="$destination_abs/.extracting"
  rm -rf -- "$extract_root"
  install -d -m 0700 "$extract_root"
  tar --no-same-owner --no-same-permissions -xzf "$archive_abs" -C "$extract_root"
  if find -P "$extract_root" ! -type f ! -type d -print -quit | grep -q .; then
    echo "extracted payload contains a link or special file" >&2
    exit 66
  fi
  rm -f -- "$archive_abs"
  shopt -s dotglob nullglob
  extracted=("$extract_root"/*)
  test "${#extracted[@]}" -gt 0
  mv -- "${extracted[@]}" "$destination_abs/"
  rmdir -- "$extract_root"
fi

trap - EXIT
