#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
deploy="$script_dir/deploy-staging-release.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

make_shims() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/install" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
is_dir=false
mode=''
positional=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) is_dir=true; shift ;;
    -o|-g) shift 2 ;;
    -m) mode="$2"; shift 2 ;;
    *) positional+=("$1"); shift ;;
  esac
done
if [ "$is_dir" = true ]; then
  mkdir -p "${positional[@]}"
  exit 0
fi
source_path="${positional[0]}"
destination_path="${positional[1]}"
cp "$source_path" "$destination_path"
if [ -n "$mode" ]; then chmod "$mode" "$destination_path"; fi
SH
  cat > "$bin_dir/runuser" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
SH
  cat > "$bin_dir/chown" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  cat > "$bin_dir/stat" <<'SH'
#!/usr/bin/env bash
if [ "$1" = -c ] && [ "$2" = %U ]; then
  printf '%s\n' agent-saas-staging
  exit 0
fi
exec /usr/bin/stat "$@"
SH
  cat > "$bin_dir/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "$1" != show ]; then exit 0; fi
service="$2"
property=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --property ]; then property="$2"; break; fi
  shift
done
case "$property" in
  WorkingDirectory)
    value="$STAGING_RUNTIME_ROOT/server"
    if { [ "$FAIL_CHECK" = server-working ] && [[ "$service" == *server-staging* ]]; } \
      || { [ "$FAIL_CHECK" = worker-working ] && [[ "$service" == *runtime-worker* ]]; }; then
      value=/wrong/working-directory
    fi
    ;;
  ExecStart)
    value="node $STAGING_RELEASE_ROOT/current/server/dist/index.js"
    if { [ "$FAIL_CHECK" = server-exec ] && [[ "$service" == *server-staging* ]]; } \
      || { [ "$FAIL_CHECK" = worker-exec ] && [[ "$service" == *runtime-worker* ]]; }; then
      value='node /wrong/server.js'
    fi
    ;;
  Environment)
    if [[ "$service" == *runtime-worker* ]]; then
      ready="$STAGING_RUN_ROOT/runtime-worker.ready"
      config="$STAGING_STATE_ROOT/config/config.json"
      [ "$FAIL_CHECK" != worker-ready ] || ready=/wrong/runtime-worker.ready
      [ "$FAIL_CHECK" != worker-config ] || config=/wrong/config.json
      value="AGENT_SAAS_READYFILE=$ready AGENT_SAAS_CONFIG_PATH=$config"
    else
      ready="$STAGING_RUN_ROOT/runtime-worker.ready"
      config="$STAGING_STATE_ROOT/config/config.json"
      [ "$FAIL_CHECK" != server-active-ready ] || ready=/wrong/runtime-worker.ready
      [ "$FAIL_CHECK" != server-config ] || config=/wrong/config.json
      value="AGENT_SAAS_ACTIVE_RUNTIME_WORKER_READYFILE=$ready AGENT_SAAS_CONFIG_PATH=$config"
    fi
    ;;
  *) value='' ;;
esac
printf '%s\n' "$value"
SH
  chmod +x "$bin_dir"/*
}

run_case() {
  local fail_check="$1" unit_mode="$2"
  local case_dir="$tmp/$fail_check-$unit_mode"
  local release_dir="$case_dir/release-input"
  local root="$case_dir/releases-root"
  local state_root="$case_dir/state"
  local etc_root="$case_dir/etc"
  local systemd_root="$case_dir/systemd"
  local runtime_root="$case_dir/runtime"
  local run_root="$case_dir/run"
  local bin_dir="$case_dir/bin"
  local unit_dir="$case_dir/unit-templates"
  local previous="$root/releases/previous"
  mkdir -p "$release_dir" "$root/releases" "$state_root/config" "$etc_root" \
    "$systemd_root" "$runtime_root/server" "$runtime_root/artifacts" "$run_root" \
    "$unit_dir" "$previous"
  make_shims "$bin_dir"

  printf 'server bundle\n' > "$release_dir/server-bundle.tgz"
  printf 'web bundle\n' > "$release_dir/web-assets.tgz"
  printf 'acs bundle\n' > "$release_dir/acs-orchestrator.tgz"
  printf 'runtime bundle\n' > "$release_dir/staging-runtime-assets.tgz"
  (
    cd "$release_dir"
    sha256sum server-bundle.tgz web-assets.tgz acs-orchestrator.tgz \
      staging-runtime-assets.tgz > SHA256SUMS
  )
  cat > "$release_dir/manifest.json" <<'JSON'
{"releaseId":"rc-20260901-318","releaseSha":"0123456789abcdef0123456789abcdef01234567","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
JSON
  for unit in agent-saas-server-staging agent-saas-runtime-worker-staging agent-saas-acs-orchestrator-staging; do
    printf '[Unit]\nDescription=%s\n' "$unit" > "$unit_dir/$unit.service.template"
  done

  printf '{"fixture":"original"}\n' > "$state_root/config/config.json"
  printf 'SERVER_ENV=original\n' > "$etc_root/server.env"
  printf 'ACS_ENV=original\n' > "$etc_root/acs-orchestrator.env"
  printf '{"identity":"original"}\n' > "$etc_root/acs-release-identity.json"
  if [ "$unit_mode" = present ]; then
    printf 'old server unit\n' > "$systemd_root/agent-saas-server-staging.service"
    printf 'old worker unit\n' > "$systemd_root/agent-saas-runtime-worker-staging.service"
    printf 'old acs unit\n' > "$systemd_root/agent-saas-acs-orchestrator-staging.service"
  fi
  ln -s "$previous" "$root/current"

  set +e
  PATH="$bin_dir:$PATH" SYSTEMCTL_LOG="$case_dir/systemctl.log" FAIL_CHECK="$fail_check" \
    STAGING_RELEASE_ROOT="$root" STAGING_STATE_ROOT="$state_root" STAGING_ETC_ROOT="$etc_root" \
    STAGING_SYSTEMD_ROOT="$systemd_root" STAGING_RUNTIME_ROOT="$runtime_root" \
    STAGING_RUN_ROOT="$run_root" STAGING_LOCK_PATH="$run_root/deploy.lock" \
    UNIT_DIR="$unit_dir" RELEASE_DIR="$release_dir" MANIFEST_PATH="$release_dir/manifest.json" \
    CHECKSUM_PATH="$release_dir/SHA256SUMS" VERIFY_INSTALLED_SCRIPT="$script_dir/verify-installed-release.mjs" \
    CONFIG_IDENTITY_READER="$script_dir/read-production-state.mjs" \
    EXPECTED_MANIFEST_DIGEST=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    STAGING_RUNTIME_ASSETS_PATH="$release_dir/staging-runtime-assets.tgz" \
    STAGING_RUNTIME_ASSETS_DIGEST="sha256:$(sha256sum "$release_dir/staging-runtime-assets.tgz" | cut -d' ' -f1)" \
    GITHUB_RUN_ID=9001 GITHUB_RUN_ATTEMPT=2 \
    bash "$deploy" > "$case_dir/stdout" 2> "$case_dir/stderr"
  local status=$?
  set -e

  test "$status" -ne 0
  grep -F 'Staging' "$case_dir/stderr" >/dev/null || {
    cat "$case_dir/stderr" >&2
    return 1
  }
  test "$(readlink -f "$root/current")" = "$previous"
  grep -Fx '{"fixture":"original"}' "$state_root/config/config.json" >/dev/null
  grep -Fx 'SERVER_ENV=original' "$etc_root/server.env" >/dev/null
  grep -Fx 'ACS_ENV=original' "$etc_root/acs-orchestrator.env" >/dev/null
  grep -Fx '{"identity":"original"}' "$etc_root/acs-release-identity.json" >/dev/null
  test "$(grep -c '^daemon-reload$' "$case_dir/systemctl.log")" -eq 2
  ! grep -E '^(restart|stop|reset-failed) ' "$case_dir/systemctl.log" >/dev/null
  if [ "$unit_mode" = present ]; then
    grep -Fx 'old server unit' "$systemd_root/agent-saas-server-staging.service" >/dev/null
    grep -Fx 'old worker unit' "$systemd_root/agent-saas-runtime-worker-staging.service" >/dev/null
    grep -Fx 'old acs unit' "$systemd_root/agent-saas-acs-orchestrator-staging.service" >/dev/null
  else
    test ! -e "$systemd_root/agent-saas-server-staging.service"
    test ! -e "$systemd_root/agent-saas-runtime-worker-staging.service"
    test ! -e "$systemd_root/agent-saas-acs-orchestrator-staging.service"
  fi
}

for fail_check in server-working server-exec worker-working worker-exec worker-ready \
  server-active-ready server-config worker-config; do
  run_case "$fail_check" present
done
run_case server-working absent

printf '%s\n' 'staging unit preflight fault matrix and absent-unit restoration: ok'
