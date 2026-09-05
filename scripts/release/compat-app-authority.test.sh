#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
helper="$script_dir/compat-app-authority.sh"
workflow="$repo_root/.github/workflows/ci.yml"
bash -n "$helper"
fail() { printf 'not ok - %s\n' "$*" >&2; exit 1; }
grep -Fq 'LOCK_FILE="/run/lock/agent-saas/promotion.lock"' "$helper" \
  || fail 'compat rollback must use the fixed production promotion lock'
if grep -Fq 'AGENT_SAAS_DEPLOY_LOCK_FILE' "$helper"; then
  fail 'compat rollback production lock must not be caller-configurable'
fi

tmp="$(mktemp -d)"
trap 'chmod -R u+w "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT

# API and Worker compatibility paths must expose old-old or new-new across every
# authority helper rename boundary.
marker_harness="$tmp/marker-harness.sh"
cat >"$marker_harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$HELPER"
mv_count=0
mv() {
  command mv "$@"
  mv_count=$((mv_count + 1))
  if [ "$KILL_AFTER" -gt 0 ] && [ "$mv_count" -eq "$KILL_AFTER" ]; then kill -KILL "$$"; fi
}
commit_compat_app_active_colors green green
HARNESS
chmod +x "$marker_harness"
for kill_after in 1 2 3 4 0; do
  root="$tmp/authority-$kill_after"
  mkdir -p "$root"
  printf 'blue\n' >"$root/api"
  printf 'blue\n' >"$root/worker"
  set +e
  HELPER="$helper" KILL_AFTER="$kill_after" GITHUB_RUN_ID=318 GITHUB_RUN_ATTEMPT=1 \
    AGENT_SAAS_API_ACTIVE_COLOR_FILE="$root/api" \
    AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE="$root/worker" \
    AGENT_SAAS_APP_AUTHORITY_DIR="$root/generations" \
    AGENT_SAAS_APP_AUTHORITY_LINK="$root/current" \
    bash "$marker_harness" 2>/dev/null
  status=$?
  set -e
  worker=absent; [ ! -f "$root/worker" ] || worker="$(cat "$root/worker")"
  pair="$(cat "$root/api"):$worker"
  if [ "$kill_after" -eq 0 ]; then
    [ "$status" -eq 0 ] && [ "$pair" = green:green ]
  elif [ "$kill_after" -lt 4 ]; then
    [ "$status" -ne 0 ] && [ "$pair" = blue:blue ]
  else
    [ "$status" -ne 0 ] && [ "$pair" = green:green ]
  fi
done

run_crash_reentry_case() (
  set -Eeuo pipefail
  crash_point="$1"       # before-symlink | after-symlink | legacy-predrain
  enablement_mode="$2"   # enabled | disabled | absent
  worker_mode="$3"       # split | legacy-all | pure-web
  case_root="$tmp/$crash_point-$enablement_mode-$worker_mode"
  root="$case_root/app"
  old="$root/releases/old"
  release="$root/releases/new"
  run="$case_root/run"
  etc="$case_root/etc"
  systemd="$case_root/systemd"
  bin="$case_root/bin"
  mock="$case_root/mock"
  log="$case_root/actions.log"
  mkdir -p "$old" "$release/scripts/release" "$root/color" "$root/worker" \
    "$run" "$etc" "$systemd/nginx.service.d" "$bin" "$mock"
  cp "$helper" "$release/scripts/release/compat-app-authority.sh"

  ln -s "$old" "$root/color/blue"
  ln -s "$old" "$root/color/green"
  ln -s "$old" "$root/current"
  printf 'blue\n' >"$etc/api-color"
  if [ "$worker_mode" = split ]; then
    ln -s "$old" "$root/worker/blue"
    ln -s "$old" "$root/worker/green"
    printf 'blue\n' >"$etc/worker-color"
    worker_old=blue worker_new=green deploy_worker=true
  elif [ "$worker_mode" = pure-web ]; then
    ln -s "$old" "$root/worker/blue"
    printf 'blue\n' >"$etc/worker-color"
    worker_old=blue worker_new=blue deploy_worker=false
  else
    worker_old=absent worker_new=blue deploy_worker=true
  fi
  printf 'old upstream\n' >"$etc/upstream.conf"
  printf 'old api site\n' >"$etc/api-site.conf"
  printf 'old identity\n' >"$etc/runtime-identity.json"
  printf 'old idle api env\n' >"$etc/server-green.release.env"
  printf 'old idle api snapshot\n' >"$run/api-green.snapshot"
  if [ "$worker_new" != absent ]; then
    printf 'old idle worker env\n' >"$etc/worker-$worker_new.release.env"
    printf 'old idle worker snapshot\n' >"$run/worker-$worker_new.snapshot"
  fi
  if [ "$enablement_mode" != absent ]; then
    printf 'old api unit\n' >"$systemd/agent-saas-server@.service"
    printf 'old worker unit\n' >"$systemd/agent-saas-runtime-worker@.service"
    printf 'old nginx dropin\n' >"$systemd/nginx.service.d/agent-saas-nas.conf"
  fi

  set_enablement() { printf '%s\n' "$2" >"$mock/enabled-$1"; }
  set_enablement 'agent-saas-server@blue' "$enablement_mode"
  set_enablement 'agent-saas-server@green' "$enablement_mode"
  if [ "$worker_old" != absent ]; then set_enablement "agent-saas-runtime-worker@$worker_old" "$enablement_mode"; fi
  set_enablement "agent-saas-runtime-worker@$worker_new" "$enablement_mode"
  : >"$mock/active-agent-saas-server@blue"
  if [ "$worker_old" != absent ]; then : >"$mock/active-agent-saas-runtime-worker@$worker_old"; fi

  cat >"$bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\n' "$*" >>"$ACTION_LOG"
cmd="$1"; shift || true
case "$cmd" in
  is-enabled)
    [ "${1:-}" != --quiet ] || shift
    value=$(cat "$MOCK_STATE/enabled-$1" 2>/dev/null || echo absent)
    case "$value" in enabled) echo enabled; exit 0 ;; disabled) echo disabled; exit 1 ;; absent) echo not-found; exit 4 ;; esac ;;
  is-active)
    [ "${1:-}" != --quiet ] || shift
    test -e "$MOCK_STATE/active-$1" ;;
  enable)
    unit="${!#}"; printf 'enabled\n' >"$MOCK_STATE/enabled-$unit" ;;
  disable)
    now=0; [ "${1:-}" != --now ] || { now=1; shift; }
    unit="$1"; value=$(cat "$MOCK_STATE/enabled-$unit" 2>/dev/null || echo absent)
    if [ "${MOCK_ABSENT_MODE:-0}" = 1 ]; then value=absent; fi
    [ "$value" = absent ] || printf 'disabled\n' >"$MOCK_STATE/enabled-$unit"
    [ "$value" != absent ] || printf 'absent\n' >"$MOCK_STATE/enabled-$unit"
    [ "$now" -eq 0 ] || rm -f "$MOCK_STATE/active-$unit" ;;
  restart)
    unit="$1"; : >"$MOCK_STATE/active-$unit"
    color="${unit##*@}"
    if [[ "$unit" == agent-saas-runtime-worker@* ]]; then
      printf '%s\n' "$MOCK_PID" >"$RUN_DIR/agent-saas-runtime-worker-$color.pid"
      printf '%s\n' "$MOCK_PID" >"$RUN_DIR/agent-saas-runtime-worker-$color.ready"
    fi ;;
  reload)
    worker=absent; [ ! -f "$WORKER_MARKER" ] || worker=$(cat "$WORKER_MARKER")
    printf 'reload-authority %s:%s\n' "$(cat "$API_MARKER")" "$worker" >>"$ACTION_LOG" ;;
  daemon-reload|reset-failed|stop) ;;
  *) exit 0 ;;
esac
MOCK
  cat >"$bin/nginx" <<'MOCK'
#!/usr/bin/env bash
printf 'nginx %s\n' "$*" >>"$ACTION_LOG"
[ "$1" = -t ]
MOCK
  cat >"$bin/curl" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
  chmod +x "$bin/systemctl" "$bin/nginx" "$bin/curl"

  export PATH="$bin:$PATH" MOCK_STATE="$mock" ACTION_LOG="$log" MOCK_PID="$$" RUN_DIR="$run"
  [ "$enablement_mode" != absent ] || export MOCK_ABSENT_MODE=1
  export API_MARKER="$etc/api-color" WORKER_MARKER="$etc/worker-color"
  export GITHUB_RUN_ID=318 GITHUB_RUN_ATTEMPT=1
  export DEPLOY_ROOT="$root" RELEASE_DIR="$release" ACTIVE=blue IDLE=green
  export SERVICE_NAME=agent-saas-server WORKER_SERVICE=agent-saas-runtime-worker
  export WORKER_DEPLOY_REQUIRED="$deploy_worker" ACTIVE_COLOR_FILE="$etc/api-color" WORKER_ACTIVE_COLOR_FILE="$etc/worker-color"
  export API_UNIT_FILE="$systemd/agent-saas-server@.service"
  export WORKER_UNIT_FILE="$systemd/agent-saas-runtime-worker@.service"
  export NGINX_DROPIN_FILE="$systemd/nginx.service.d/agent-saas-nas.conf"
  export UPSTREAM_CONF="$etc/upstream.conf" API_SITE_CONF="$etc/api-site.conf"
  export RUNTIME_IDENTITY_FILE="$etc/runtime-identity.json"
  export AGENT_SAAS_API_RELEASE_ENV="$etc/server-green.release.env"
  export AGENT_SAAS_WORKER_RELEASE_ENV="$etc/worker-$worker_new.release.env"
  export AGENT_SAAS_API_PRIVATE_SNAPSHOT="$run/api-green.snapshot"
  export AGENT_SAAS_WORKER_PRIVATE_SNAPSHOT="$run/worker-$worker_new.snapshot"

  source "$release/scripts/release/compat-app-authority.sh"
  publish_compat_deploy_rollback
  state="$root/rollback-states/318-1"
  [ "$(readlink -f "$root/compat-deploy-attempt-current")" = "$state" ]
  test -x "$state/rollback.sh"
  test -r "$state/compat-app-authority.sh"

  # Simulate hard-kill boundaries. No trap is allowed to help. The next entry
  # executes the immutable state before checking whether active API is ready.
  set +e
  (
    set -e
    [ "$crash_point" != before-symlink ] || kill -KILL "$BASHPID"
    ln -sfn "$release" "$root/color/green"
    [ "$crash_point" != after-symlink ] || kill -KILL "$BASHPID"
    ln -sfn "$release" "$root/current"
    ln -sfn "$old" "$root/previous"
    [ "$worker_mode" = pure-web ] || ln -sfn "$release" "$root/worker/$worker_new"
    printf 'candidate api unit\n' >"$systemd/agent-saas-server@.service"
    printf 'candidate worker unit\n' >"$systemd/agent-saas-runtime-worker@.service"
    printf 'candidate upstream\n' >"$etc/upstream.conf"
    printf 'candidate api site\n' >"$etc/api-site.conf"
    printf 'candidate identity\n' >"$etc/runtime-identity.json"
    printf 'candidate api env\n' >"$etc/server-green.release.env"
    printf 'candidate worker env\n' >"$etc/worker-$worker_new.release.env"
    printf 'candidate api snapshot\n' >"$run/api-green.snapshot"
    printf 'candidate worker snapshot\n' >"$run/worker-$worker_new.snapshot"
    if [ "$crash_point" = legacy-predrain ]; then
      rm -f "$mock/active-agent-saas-server@blue"
      printf 'disabled\n' >"$mock/enabled-agent-saas-server@blue"
      [ "$worker_old" = absent ] || { rm -f "$mock/active-agent-saas-runtime-worker@$worker_old"; printf 'disabled\n' >"$mock/enabled-agent-saas-runtime-worker@$worker_old"; }
      kill -KILL "$BASHPID"
    fi
  ) 2>/dev/null
  crash_status=$?
  set -e
  [ "$crash_status" -ne 0 ]

  # Prove self-location and the fixed production lock; neither may depend on mutable input.
  rm -f "$release/scripts/release/compat-app-authority.sh"
  pending="$(readlink -f "$root/compat-deploy-attempt-current")"
  case "$pending" in "$root/rollback-states/"*) ;; *) fail 'pending owner escaped rollback-states' ;; esac
  lock_file="/run/lock/agent-saas/promotion.lock"
  mkdir -p "$(dirname "$lock_file")"
  actions_before="$(wc -l <"$log")"
  current_before="$(readlink "$root/current")"
  api_before="$(cat "$etc/api-color")"
  exec {promotion_lock_fd}>"$lock_file"
  flock -n "$promotion_lock_fd"
  set +e
  PATH="$bin:$PATH" MOCK_STATE="$mock" ACTION_LOG="$log" MOCK_PID="$$" RUN_DIR="$run" \
    API_MARKER="$etc/api-color" WORKER_MARKER="$etc/worker-color" \
    AGENT_SAAS_COMPAT_ROOT="$root" AGENT_SAAS_COMPAT_ROLLBACK_STATE="$pending" \
    AGENT_SAAS_API_ACTIVE_COLOR_FILE="$etc/api-color" \
    AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE="$etc/worker-color" \
    AGENT_SAAS_APP_AUTHORITY_DIR="$etc/generations" AGENT_SAAS_APP_AUTHORITY_LINK="$etc/app-current" \
    AGENT_SAAS_NGINX_UPSTREAM_FILE="$etc/upstream.conf" AGENT_SAAS_NGINX_API_SITE_FILE="$etc/api-site.conf" \
    AGENT_SAAS_RUNTIME_IDENTITY_FILE="$etc/runtime-identity.json" AGENT_SAAS_SYSTEMD_DIR="$systemd" \
    AGENT_SAAS_RUN_DIR="$run" \
    "$pending/rollback.sh" >"$case_root/locked-rollback.log" 2>&1
  locked_status=$?
  set -e
  [ "$locked_status" -ne 0 ] || fail 'compat rollback acquired the fixed production promotion lock while held'
  grep -Fq 'another deployment/rollback owns the production lock' "$case_root/locked-rollback.log"
  [ "$(wc -l <"$log")" -eq "$actions_before" ] || fail 'locked rollback performed a production action'
  [ "$(readlink "$root/current")" = "$current_before" ] || fail 'locked rollback changed current release'
  [ "$(cat "$etc/api-color")" = "$api_before" ] || fail 'locked rollback changed API authority'

  set +e
  PATH="$bin:$PATH" MOCK_STATE="$mock" ACTION_LOG="$log" MOCK_PID="$$" RUN_DIR="$run" \
    API_MARKER="$etc/api-color" WORKER_MARKER="$etc/worker-color" \
    AGENT_SAAS_COMPAT_ROOT="$root" AGENT_SAAS_COMPAT_ROLLBACK_STATE="$pending" \
    AGENT_SAAS_API_ACTIVE_COLOR_FILE="$etc/api-color" \
    AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE="$etc/worker-color" \
    AGENT_SAAS_APP_AUTHORITY_DIR="$etc/generations" AGENT_SAAS_APP_AUTHORITY_LINK="$etc/app-current" \
    AGENT_SAAS_NGINX_UPSTREAM_FILE="$etc/upstream.conf" AGENT_SAAS_NGINX_API_SITE_FILE="$etc/api-site.conf" \
    AGENT_SAAS_RUNTIME_IDENTITY_FILE="$etc/runtime-identity.json" AGENT_SAAS_SYSTEMD_DIR="$systemd" \
    AGENT_SAAS_RUN_DIR="$run" AGENT_SAAS_DEPLOY_LOCK_HELD=1 \
    "$pending/rollback.sh" 9>&- >"$case_root/forged-held-lock.log" 2>&1
  forged_status=$?
  set -e
  [ "$forged_status" -ne 0 ] || fail 'compat rollback trusted a forged inherited-lock declaration'
  grep -Fq 'declared production lock is not inherited on fd 9' "$case_root/forged-held-lock.log"
  [ "$(wc -l <"$log")" -eq "$actions_before" ] || fail 'forged lock declaration performed a production action'
  [ "$(readlink "$root/current")" = "$current_before" ] || fail 'forged lock declaration changed current release'
  [ "$(cat "$etc/api-color")" = "$api_before" ] || fail 'forged lock declaration changed API authority'

  flock -u "$promotion_lock_fd"
  eval "exec ${promotion_lock_fd}>&-"

  # Production workflow invokes pending rollback while inheriting the already-held lock on fd 9.
  exec 9>"$lock_file"
  flock -n 9
  PATH="$bin:$PATH" MOCK_STATE="$mock" ACTION_LOG="$log" MOCK_PID="$$" RUN_DIR="$run" \
    API_MARKER="$etc/api-color" WORKER_MARKER="$etc/worker-color" \
    AGENT_SAAS_COMPAT_ROOT="$root" AGENT_SAAS_COMPAT_ROLLBACK_STATE="$pending" \
    AGENT_SAAS_API_ACTIVE_COLOR_FILE="$etc/api-color" \
    AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE="$etc/worker-color" \
    AGENT_SAAS_APP_AUTHORITY_DIR="$etc/generations" AGENT_SAAS_APP_AUTHORITY_LINK="$etc/app-current" \
    AGENT_SAAS_NGINX_UPSTREAM_FILE="$etc/upstream.conf" AGENT_SAAS_NGINX_API_SITE_FILE="$etc/api-site.conf" \
    AGENT_SAAS_RUNTIME_IDENTITY_FILE="$etc/runtime-identity.json" AGENT_SAAS_SYSTEMD_DIR="$systemd" \
    AGENT_SAAS_RUN_DIR="$run" AGENT_SAAS_DEPLOY_LOCK_HELD=1 \
    "$pending/rollback.sh"
  flock -u 9
  exec 9>&-

  [ ! -e "$root/compat-deploy-attempt-current" ]
  [ "$(readlink "$root/current")" = "$old" ]
  [ ! -e "$root/previous" ]
  [ "$(readlink "$root/color/green")" = "$old" ]
  if [ "$worker_mode" = legacy-all ]; then
    [ ! -e "$root/worker/$worker_new" ]
  else
    [ "$(readlink "$root/worker/$worker_new")" = "$old" ]
  fi
  [ "$(cat "$etc/upstream.conf")" = 'old upstream' ]
  [ "$(cat "$etc/api-site.conf")" = 'old api site' ]
  [ "$(cat "$etc/runtime-identity.json")" = 'old identity' ]
  [ "$(cat "$etc/server-green.release.env")" = 'old idle api env' ]
  [ "$(cat "$etc/worker-$worker_new.release.env")" = 'old idle worker env' ]
  [ "$(cat "$run/api-green.snapshot")" = 'old idle api snapshot' ]
  [ "$(cat "$run/worker-$worker_new.snapshot")" = 'old idle worker snapshot' ]
  if [ "$enablement_mode" = absent ]; then
    [ ! -e "$systemd/agent-saas-server@.service" ]
    [ ! -e "$systemd/agent-saas-runtime-worker@.service" ]
    [ ! -e "$systemd/nginx.service.d/agent-saas-nas.conf" ]
  else
    [ "$(cat "$systemd/agent-saas-server@.service")" = 'old api unit' ]
    [ "$(cat "$systemd/agent-saas-runtime-worker@.service")" = 'old worker unit' ]
    [ "$(cat "$systemd/nginx.service.d/agent-saas-nas.conf")" = 'old nginx dropin' ]
    [ "$(stat -c %a "$systemd/agent-saas-server@.service")" = 644 ]
  fi
  [ "$(cat "$mock/enabled-agent-saas-server@blue")" = "$enablement_mode" ]
  [ "$(cat "$mock/enabled-agent-saas-server@green")" = "$enablement_mode" ]
  if [ "$worker_old" != absent ]; then [ "$(cat "$mock/enabled-agent-saas-runtime-worker@$worker_old")" = "$enablement_mode" ]; fi
  [ "$(cat "$mock/enabled-agent-saas-runtime-worker@$worker_new")" = "$enablement_mode" ]
  [ -e "$mock/active-agent-saas-server@blue" ]
  [ ! -e "$mock/active-agent-saas-server@green" ]
  if [ "$worker_old" != absent ]; then [ -e "$mock/active-agent-saas-runtime-worker@$worker_old" ]; fi
  [ "$(cat "$etc/api-color")" = blue ]
  if [ "$worker_old" = absent ]; then [ ! -e "$etc/worker-color" ] && [ ! -L "$etc/worker-color" ]; else [ "$(cat "$etc/worker-color")" = blue ]; fi

  api_restart=$(grep -n '^systemctl restart agent-saas-server@blue$' "$log" | tail -1 | cut -d: -f1)
  nginx_test=$(grep -n '^nginx -t$' "$log" | tail -1 | cut -d: -f1)
  nginx_reload=$(grep -n '^systemctl reload nginx$' "$log" | tail -1 | cut -d: -f1)
  authority_reload=$(grep -n "^reload-authority blue:$worker_old$" "$log" | tail -1 | cut -d: -f1)
  [ "$api_restart" -lt "$nginx_test" ] && [ "$nginx_test" -lt "$nginx_reload" ] \
    && [ "$authority_reload" -eq $((nginx_reload + 1)) ] \
    || fail 'rollback did not prepare old API then expose old authority at the immediate nginx reload boundary'
)

run_crash_reentry_case before-symlink enabled split
run_crash_reentry_case after-symlink disabled split
run_crash_reentry_case legacy-predrain absent legacy-all
run_crash_reentry_case after-symlink enabled pure-web

# Static ordering guards exercise the exact workflow shell: publish precedes the
# first candidate/control-plane mutation and forward authority precedes reload.
node --input-type=module - "$workflow" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const workflow = readFileSync(process.argv[2], 'utf8');
const publish = workflow.indexOf('publish_compat_deploy_rollback');
const unit = workflow.indexOf('install -m 0644 "$RELEASE_DIR/daemon-packaging/systemd/agent-saas-server@.service.template"');
const firstLink = workflow.indexOf('ln -sfn "$RELEASE_DIR" "$COLOR_DIR/$IDLE"');
assert.ok(publish >= 0 && publish < unit && publish < firstLink);
const testAt = workflow.indexOf('if ! nginx -t; then');
const commit = workflow.indexOf('if ! commit_app_active_colors "$IDLE" "$APP_WORKER_TARGET"', testAt);
const reload = workflow.indexOf('if ! systemctl reload nginx; then', commit);
assert.ok(testAt >= 0 && testAt < commit && commit < reload);
const activeCheck = workflow.indexOf('if ! systemctl is-active --quiet "${SERVICE_NAME}@${ACTIVE}"');
const pending = workflow.indexOf('pending compatibility attempt detected before active validation');
assert.ok(pending >= 0 && pending < activeCheck);
NODE

printf 'ok - immutable pre-mutation rollback, SIGKILL reentry, exact absent markers, ordering, snapshots and enablement\n'
