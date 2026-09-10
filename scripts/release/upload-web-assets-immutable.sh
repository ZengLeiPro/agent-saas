#!/usr/bin/env bash
set -euo pipefail

# Keep the five-argument workflow contract. Optional limits are positional so they do not
# add deployment environment variables. All workers stay in the caller's process group.
mode=batch
if [ "${1:-}" = --asset ]; then
  mode=asset
  source_path="${2:?asset path is required}"
  progress="${3:?asset progress is required}"
  result_path="${4:?asset result path is required}"
  shift 4
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
asset_root="${1:?asset root is required}"
target_base="${2:?target OSS prefix is required}"
credentials_path="${3:?OSS SDK credentials file is required}"
oss_module_path="${4:-}"
public_origin="${5:?public Web origin is required}"
concurrency="${6:-4}"
request_timeout="${7:-60}"
diagnostics="${8:-}"
[ -z "$diagnostics" ] || install -d -m 0700 "$diagnostics"
[[ "$concurrency" =~ ^[1-8]$ ]] || { echo 'Web asset concurrency must be 1..8' >&2; exit 1; }
[[ "$request_timeout" =~ ^[1-9][0-9]*$ ]] && [ "${#request_timeout}" -le 3 ] && \
  [ "$request_timeout" -le 120 ] || { echo 'Web asset request timeout must be 1..120 seconds' >&2; exit 1; }
public_origin="${public_origin%/}"
printf '%s' "$public_origin" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'
region="${OSS_REGION:?OSS_REGION is required}"
test -d "$asset_root"
test -s "$credentials_path"
asset_root="${asset_root%/}"
case "$target_base" in oss://*/*) ;; *) echo 'target must be an OSS prefix' >&2; exit 1 ;; esac
target_base="${target_base%/}"
bucket_and_prefix="${target_base#oss://}"
bucket="${bucket_and_prefix%%/*}"
for tool in timeout node curl gzip file; do command -v "$tool" >/dev/null; done

work_dir="$(mktemp -d)"
command_pid=''
key=unknown
stage=preflight
declare -A workers=()
cleanup() {
  local status=$? pid
  trap - EXIT
  trap '' INT TERM HUP
  # Signal the timeout supervisor, then reap it. --foreground below prevents nested
  # process groups from escaping the workflow's lock-loss / deadline cancellation.
  if [ -n "$command_pid" ]; then
    kill -TERM "$command_pid" 2>/dev/null || true
    wait "$command_pid" 2>/dev/null || true
  fi
  for pid in "${!workers[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${!workers[@]}"; do wait "$pid" 2>/dev/null || true; done
  if [ "$status" -ne 0 ] && [ "$mode" = asset ]; then
    printf 'Web asset verification failed: key=%s phase=%s exit=%s elapsed=%ss\n' \
      "$key" "$stage" "$status" "$SECONDS" >&2
  fi
  if [ -n "$diagnostics" ] && [ "$mode" = asset ] && [ "$status" -ne 0 ]; then
    printf '{"key":"%s","phase":"verify","attempt":0,"exitCode":%s,"durationSeconds":%s}\n' \
      "$key" "$status" "$SECONDS" >> "$diagnostics/worker-$$.jsonl"
  fi
  rm -rf -- "$work_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [ "$mode" = batch ]; then
  # Materialize the list before writing: do not hide a failed find/sort in process substitution.
  find "$asset_root" -type f -print0 | LC_ALL=C sort -z > "$work_dir/sources"
  javascript_assets=0
  css_assets=0
  total=0
  while IFS= read -r -d '' source_path; do
    key="${source_path#"$asset_root"/}"
    printf '%s' "$key" | grep -Eq '^[A-Za-z0-9._/-]+$'
    case "$key" in
      *.js|*.mjs) javascript_assets=$((javascript_assets + 1)) ;;
      *.css) css_assets=$((css_assets + 1)) ;;
    esac
    total=$((total + 1))
  done < "$work_dir/sources"
  if [ "$javascript_assets" -eq 0 ] || [ "$css_assets" -eq 0 ]; then
    echo 'immutable Web asset set must contain JavaScript and CSS' >&2
    exit 1
  fi
  uploaded=0
  reused=0
  completed=0
  active=0
  wait_one() {
    local pid status result
    while :; do
      for pid in "${!workers[@]}"; do
        if ! kill -0 "$pid" 2>/dev/null; then
          status=0
          wait "$pid" || status=$?
          result="${workers[$pid]}"
          unset 'workers[$pid]'
          active=$((active - 1))
          if [ "$status" -ne 0 ]; then
            echo "Web asset batch stopped: completed=$completed total=$total exit=$status" >&2
            return "$status"
          fi
          case "$(cat "$result")" in
            uploaded) uploaded=$((uploaded + 1)) ;;
            reused) reused=$((reused + 1)) ;;
            *) echo 'Missing or invalid Web asset completion receipt' >&2; return 1 ;;
          esac
          completed=$((completed + 1))
          echo "Web asset progress: completed=$completed total=$total uploaded=$uploaded reused=$reused elapsed=${SECONDS}s"
          return 0
        fi
      done
      sleep 0.1
    done
  }
  echo "Verifying immutable Web assets: total=$total concurrency=$concurrency requestTimeout=${request_timeout}s"
  index=0
  while IFS= read -r -d '' source_path; do
    if [ "$active" -ge "$concurrency" ]; then wait_one; fi
    index=$((index + 1))
    bash "$script_dir/upload-web-assets-immutable.sh" --asset "$source_path" "$index/$total" "$work_dir/$index.result" \
      "$asset_root" "$target_base" "$credentials_path" "$oss_module_path" "$public_origin" \
      "$concurrency" "$request_timeout" "$diagnostics" &
    workers[$!]="$work_dir/$index.result"
    active=$((active + 1))
  done < "$work_dir/sources"
  while [ "$active" -gt 0 ]; do wait_one; done
  echo "immutable Web assets verified: uploaded=$uploaded reused=$reused js=$javascript_assets css=$css_assets"
  exit 0
fi

key="${source_path#"$asset_root"/}"
[ "$key" != "$source_path" ]
printf '%s' "$key" | grep -Eq '^[A-Za-z0-9._/-]+$'
target_uri="$target_base/$key"
upload_path="$source_path"
cache_control='public, max-age=31536000, immutable'
expected_type="$(file --brief --mime-type "$source_path")"
expected_encoding=''
run_request() {
  stage="$1"; shift
  local attempt status started
  for attempt in 1 2; do
    printf 'Web asset [%s] key=%s phase=%s attempt=%s timeout=%ss elapsed=%ss\n' \
      "$progress" "$key" "$stage" "$attempt" "$request_timeout" "$SECONDS"
    started=$SECONDS
    timeout --foreground --signal=TERM --kill-after=5 "$request_timeout" "$@" \
      > "$work_dir/$stage.out" 2> "$work_dir/$stage.err" &
    command_pid=$!
    status=0
    wait "$command_pid" || status=$?
    command_pid=''
    if [ -n "$diagnostics" ]; then
      # key and phase are prevalidated tokens, never credentials, URLs, tool output or user text.
      printf '{"key":"%s","phase":"%s","attempt":%s,"exitCode":%s,"durationSeconds":%s}\n' \
        "$key" "$stage" "$attempt" "$status" "$((SECONDS - started))" >> "$diagnostics/worker-$$.jsonl"
    fi
    if [ "$status" -eq 0 ]; then return 0; fi
    # Retry only a bounded timeout. PUT remains create-only: a lost success followed
    # by 409 still requires exact stored-byte verification, never an overwrite.
    if [ "$status" -eq 124 ] && [ "$attempt" -eq 1 ]; then
      echo "Web asset request timed out; retrying once: key=$key phase=$stage" >&2
      continue
    fi
    if [ "$status" -ne 17 ]; then cat "$work_dir/$stage.err" >&2; fi
    return "$status"
  done
}
case "$key" in
  *.woff2) expected_type='font/woff2' ;;
  *.woff) expected_type='font/woff' ;;
  *.ttf) expected_type='font/ttf' ;;
  *.js|*.mjs|*.css)
    run_request compress gzip -n -9 -c "$source_path"
    upload_path="$work_dir/compress.out"
    expected_encoding=gzip
    case "$key" in
      *.css) expected_type='text/css; charset=utf-8' ;;
      *) expected_type='text/javascript; charset=utf-8' ;;
    esac
    ;;
esac
put_status=0
run_request put node "$script_dir/put-web-asset-create-only.mjs" \
  "$upload_path" "$bucket" "${target_uri#"oss://$bucket/"}" "$region" \
  "$cache_control" "$expected_type" "$expected_encoding" \
  "$credentials_path" "$oss_module_path" || put_status=$?
result=uploaded
if [ "$put_status" -ne 0 ]; then
  if [ "$put_status" -ne 17 ] || \
    ! grep -Fxq 'OSS_CREATE_ONLY_CONFLICT FileAlreadyExists status=409' "$work_dir/put.err"; then
    cat "$work_dir/put.err" >&2
    exit "$put_status"
  fi
  result=reused
fi
# Keep HEAD + stored-byte SDK GET and exact cmp; never use transparent-gunzip CLI reads.
readback="$work_dir/readback"
run_request readback node "$script_dir/get-web-object.mjs" "$bucket" "${target_uri#"oss://$bucket/"}" "$region" \
  "$readback" "$credentials_path" "$oss_module_path"
stage=byte-compare
cmp "$upload_path" "$readback"
if [ "$put_status" -eq 17 ]; then
  run_request metadata node "$script_dir/repair-web-asset-metadata.mjs" \
    "$upload_path" "$bucket" "${target_uri#"oss://$bucket/"}" "$region" \
    "$cache_control" "$expected_type" "$expected_encoding" "$credentials_path" "$oss_module_path"
  cat "$work_dir/metadata.out"
fi
# Verify the actual public origin, with bounded transient-error retries as well as
# the process deadline. Authentication, byte and metadata contract failures stay fatal.
run_request public-head curl -fsSI --connect-timeout 10 --max-time 20 \
  --retry 2 --retry-delay 1 --retry-max-time 45 --retry-connrefused -H 'Accept-Encoding: gzip' \
  "$public_origin/${target_uri#"oss://$bucket/"}?immutable_probe=$$"
stage=public-headers
headers="$work_dir/headers"
tr -d '\r' < "$work_dir/public-head.out" > "$headers"
grep -Fxi "cache-control: $cache_control" "$headers" >/dev/null
grep -Fxi "content-type: $expected_type" "$headers" >/dev/null
if [ "$expected_encoding" = gzip ]; then
  grep -Fxi 'content-encoding: gzip' "$headers" >/dev/null
elif grep -Eiq '^content-encoding:' "$headers"; then
  echo "unexpected Content-Encoding for immutable asset: $key" >&2
  exit 1
fi
if grep -Eiq '^(content-disposition|content-language|expires|x-oss-meta-[^:]+):' "$headers"; then
  echo "unexpected mutable metadata for immutable asset: $key" >&2
  exit 1
fi
printf '%s\n' "$result" > "$result_path"
echo "Web asset [$progress] key=$key phase=complete result=$result elapsed=${SECONDS}s"
