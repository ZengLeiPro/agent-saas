#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROLLBACK_SCRIPT="$SCRIPT_DIR/production-deploy-rollback.sh"
TEST_TMP=$(mktemp -d)
trap 'rm -rf "$TEST_TMP"' EXIT

fail() { printf 'not ok - %s\n' "$*" >&2; exit 1; }
assert_eq() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_file() { [ -e "$1" ] || fail "missing $1"; }
assert_not_file() { [ ! -e "$1" ] || fail "unexpected $1"; }

make_mocks() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/nginx" <<'MOCK'
#!/usr/bin/env bash
printf 'nginx %s\n' "$*" >> "$MOCK_LOG"
[ "${1:-}" = "-t" ]
MOCK
  cat > "$bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$MOCK_LOG"
key=$(printf '%s' "$*" | tr ' /@' '____')
if [ -n "${INJECT_SYSTEMCTL_MATCH:-}" ] && [ "$*" = "$INJECT_SYSTEMCTL_MATCH" ] \
  && [ ! -e "$MOCK_STATE/injected-$key" ]; then
  : > "$MOCK_STATE/injected-$key"
  exit 71
fi
case "${1:-}" in
  enable)
    unit="${!#}"; : > "$MOCK_STATE/enabled-${unit//@/_}" ;;
  disable)
    unit="${!#}"; rm -f "$MOCK_STATE/enabled-${unit//@/_}"
    if [ "${2:-}" = "--now" ]; then rm -f "$MOCK_STATE/active-${unit//@/_}"; fi ;;
  restart)
    unit="${!#}"; : > "$MOCK_STATE/active-${unit//@/_}"
    if [[ "$unit" == agent-saas-runtime-worker@* ]]; then
      color="${unit##*@}"
      printf '%s\n' "$MOCK_READY_PID" > "$RUNTIME_RUN_DIR/agent-saas-runtime-worker-${color}.pid"
      printf '%s\n' "$MOCK_READY_PID" > "$RUNTIME_RUN_DIR/agent-saas-runtime-worker-${color}.ready"
    fi ;;
  reload|reset-failed) ;;
  *) ;;
esac
MOCK
  cat > "$bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$MOCK_LOG"
exit 0
MOCK
  chmod +x "$bin/nginx" "$bin/systemctl" "$bin/curl"
}

setup_case() {
  local name="$1"
  CASE_DIR="$TEST_TMP/$name"
  MOCK_STATE="$CASE_DIR/mock-state"
  MOCK_LOG="$CASE_DIR/mock.log"
  RUNTIME_RUN_DIR="$CASE_DIR/run"
  DEPLOY_ROOT="$CASE_DIR/deploy"
  RELEASES_DIR="$DEPLOY_ROOT/releases"
  RELEASE_DIR="$RELEASES_DIR/candidate"
  COLOR_DIR="$DEPLOY_ROOT/color"
  WORKER_DIR="$DEPLOY_ROOT/worker"
  APP_LINK="$DEPLOY_ROOT/current"
  PREV_LINK="$DEPLOY_ROOT/previous"
  RELEASE_TGZ="$CASE_DIR/candidate.tgz"
  ACTIVE_COLOR_FILE="$CASE_DIR/active-color"
  WORKER_ACTIVE_COLOR_FILE="$CASE_DIR/worker-active-color"
  RUNTIME_IDENTITY_FILE="$CASE_DIR/runtime-identity.json"
  RUNTIME_IDENTITY_BAK="$CASE_DIR/runtime-identity.before.json"
  UPSTREAM_CONF="$CASE_DIR/upstream.conf"
  API_SITE_CONF="$CASE_DIR/api-site.conf"
  UPSTREAM_BAK="$CASE_DIR/upstream.before.conf"
  API_SITE_BAK="$CASE_DIR/api-site.before.conf"
  SERVICE_NAME="agent-saas-server"
  ACTIVE_PORT=3200
  WORKER_SERVICE="agent-saas-runtime-worker"
  ACTIVE=blue
  IDLE=green
  PREV_CURRENT="$RELEASES_DIR/old"
  PREV_PREVIOUS=""
  PREV_IDLE_TARGET="$RELEASES_DIR/older-idle"
  PREV_WORKER_IDLE_TARGET="$RELEASES_DIR/older-worker"
  PREVIOUS_UPDATED=0
  WORKER_ACTIVE=blue
  WORKER_IDLE=green
  WORKER_CANDIDATE_STARTED=0
  WORKER_ACTIVE_DRAIN_STARTED=0
  WORKER_PREACTIVATED=0
  TRAFFIC_SWITCHED=1
  WEB_ACTIVE_DRAIN_STARTED=0
  NGINX_CONFIG_WRITTEN=0
  RELEASE_CREATED_BY_DEPLOY=1
  UPSTREAM_HAD_ORIGINAL=0
  API_SITE_HAD_ORIGINAL=0
  ROLLBACK_ARMED=1
  ROLLBACK_RUNNING=0
  ROLLBACK_DONE=0
  mkdir -p "$MOCK_STATE" "$RUNTIME_RUN_DIR" "$RELEASE_DIR" "$PREV_CURRENT" \
    "$PREV_IDLE_TARGET" "$PREV_WORKER_IDLE_TARGET" "$COLOR_DIR" "$WORKER_DIR"
  : > "$MOCK_LOG"
  : > "$RELEASE_TGZ"
  printf 'green\n' > "$ACTIVE_COLOR_FILE"
  printf 'new identity\n' > "$RUNTIME_IDENTITY_FILE"
  printf 'old identity\n' > "$RUNTIME_IDENTITY_BAK"
  ln -sfn "$RELEASE_DIR" "$APP_LINK"
  ln -sfn "$RELEASE_DIR" "$COLOR_DIR/$IDLE"
  make_mocks "$CASE_DIR/bin"
  PATH="$CASE_DIR/bin:$PATH"
  MOCK_READY_PID=$$
  export MOCK_STATE MOCK_LOG PATH RUNTIME_RUN_DIR MOCK_READY_PID
  unset INJECT_SYSTEMCTL_MATCH || true
  log() { printf '%s\n' "$*" >> "$CASE_DIR/rollback.log"; }
  # shellcheck source=production-deploy-rollback.sh
  source "$ROLLBACK_SCRIPT"
}

test_nginx_reload_failure() (
  setup_case nginx-reload
  printf 'old upstream\n' > "$UPSTREAM_BAK"
  printf 'old api site\n' > "$API_SITE_BAK"
  printf 'candidate upstream\n' > "$UPSTREAM_CONF"
  printf 'candidate api site\n' > "$API_SITE_CONF"
  UPSTREAM_HAD_ORIGINAL=1 API_SITE_HAD_ORIGINAL=1 NGINX_CONFIG_WRITTEN=1
  export INJECT_SYSTEMCTL_MATCH='reload nginx'

  # 第一次 reload 注入部署故障；rollback 恢复旧配置后必须再次 reload。
  if systemctl reload nginx; then fail 'nginx reload injection did not fail'; fi
  production_deploy_rollback nginx-reload || fail 'nginx reload rollback failed'
  assert_eq "$(cat "$UPSTREAM_CONF")" 'old upstream'
  assert_eq "$(cat "$API_SITE_CONF")" 'old api site'
  assert_eq "$(grep -c '^systemctl reload nginx$' "$MOCK_LOG")" '2'
  grep -q '^nginx -t$' "$MOCK_LOG" || fail 'restored nginx config was not validated'
  calls_before=$(wc -l < "$MOCK_LOG")
  production_deploy_rollback repeated || fail 'idempotent rollback retry failed'
  assert_eq "$(wc -l < "$MOCK_LOG")" "$calls_before"
)

test_active_color_failure() (
  setup_case active-color
  ACTIVE_COLOR_FILE="$CASE_DIR/active-color-dir"
  mkdir -p "$ACTIVE_COLOR_FILE"
  : > "$MOCK_STATE/enabled-agent-saas-server_green"

  if production_deploy_rollback active-color-write; then
    fail 'active-color restore failure was not surfaced'
  fi
  assert_file "$MOCK_STATE/enabled-agent-saas-server_green"
  assert_file "$RELEASE_DIR"
  assert_eq "$(readlink "$APP_LINK")" "$RELEASE_DIR"
  assert_eq "$(readlink "$COLOR_DIR/$IDLE")" "$RELEASE_DIR"
)

test_runtime_identity_failure() (
  setup_case runtime-identity
  RUNTIME_IDENTITY_FILE="$CASE_DIR/missing/runtime-identity.json"
  : > "$MOCK_STATE/enabled-agent-saas-server_green"

  if production_deploy_rollback runtime-identity-write; then
    fail 'runtime identity copy failure was not surfaced'
  fi
  assert_file "$MOCK_STATE/enabled-agent-saas-server_green"
  assert_file "$RELEASE_DIR"
  assert_eq "$(readlink "$APP_LINK")" "$RELEASE_DIR"
  assert_eq "$(readlink "$COLOR_DIR/$IDLE")" "$RELEASE_DIR"
)

test_unit_ownership_failure() (
  setup_case unit-ownership
  : > "$MOCK_STATE/enabled-agent-saas-server_green"
  export INJECT_SYSTEMCTL_MATCH='disable agent-saas-server@blue'
  if systemctl disable "${SERVICE_NAME}@${ACTIVE}"; then fail 'unit ownership injection did not fail'; fi
  production_deploy_rollback unit-ownership || fail 'unit ownership rollback failed'
  assert_file "$MOCK_STATE/enabled-agent-saas-server_blue"
  assert_not_file "$MOCK_STATE/enabled-agent-saas-server_green"
)

test_worker_guard_failure() (
  setup_case worker-guard
  WORKER_CANDIDATE_STARTED=1
  WORKER_ACTIVE_DRAIN_STARTED=1
  WORKER_PREACTIVATED=1
  printf 'green\n' > "$WORKER_ACTIVE_COLOR_FILE"
  : > "$RUNTIME_RUN_DIR/agent-saas-runtime-worker-blue.draining"
  : > "$MOCK_STATE/enabled-agent-saas-runtime-worker_green"
  export INJECT_SYSTEMCTL_MATCH='disable agent-saas-runtime-worker@blue'
  if systemctl disable "${WORKER_SERVICE}@${WORKER_ACTIVE}"; then fail 'worker guard injection did not fail'; fi
  production_deploy_rollback worker-guard || fail 'worker guard rollback failed'
  assert_eq "$(cat "$WORKER_ACTIVE_COLOR_FILE")" 'blue'
  assert_not_file "$RUNTIME_RUN_DIR/agent-saas-runtime-worker-blue.draining"
  assert_file "$MOCK_STATE/enabled-agent-saas-runtime-worker_blue"
  assert_not_file "$MOCK_STATE/enabled-agent-saas-runtime-worker_green"
  old_restart=$(grep -n '^systemctl restart agent-saas-runtime-worker@blue$' "$MOCK_LOG" | cut -d: -f1)
  candidate_stop=$(grep -n '^systemctl disable --now agent-saas-runtime-worker@green$' "$MOCK_LOG" | cut -d: -f1)
  [ "$old_restart" -lt "$candidate_stop" ] || fail 'candidate Worker stopped before old Worker recovery'
)

test_post_drain_web_failure() (
  setup_case post-drain-web
  printf 'old upstream\n' > "$UPSTREAM_BAK"
  printf 'old api site\n' > "$API_SITE_BAK"
  printf 'candidate upstream\n' > "$UPSTREAM_CONF"
  printf 'candidate api site\n' > "$API_SITE_CONF"
  UPSTREAM_HAD_ORIGINAL=1 API_SITE_HAD_ORIGINAL=1 NGINX_CONFIG_WRITTEN=1
  WEB_ACTIVE_DRAIN_STARTED=1
  : > "$RUNTIME_RUN_DIR/${SERVICE_NAME}-${ACTIVE}.draining"
  : > "$MOCK_STATE/enabled-agent-saas-server_green"

  production_deploy_rollback post-drain-web || fail 'post-drain Web rollback failed'
  assert_not_file "$RUNTIME_RUN_DIR/${SERVICE_NAME}-${ACTIVE}.draining"
  assert_file "$MOCK_STATE/enabled-agent-saas-server_blue"
  assert_not_file "$MOCK_STATE/enabled-agent-saas-server_green"
  old_restart=$(grep -n '^systemctl restart agent-saas-server@blue$' "$MOCK_LOG" | cut -d: -f1)
  nginx_reload=$(grep -n '^systemctl reload nginx$' "$MOCK_LOG" | cut -d: -f1)
  candidate_stop=$(grep -n '^systemctl disable --now agent-saas-server@green$' "$MOCK_LOG" | cut -d: -f1)
  [ "$old_restart" -lt "$nginx_reload" ] && [ "$nginx_reload" -lt "$candidate_stop" ] \
    || fail 'old Web was not ready before nginx rollback/candidate stop'
)

test_worker_bootstrap_failure() (
  setup_case worker-bootstrap
  WORKER_ACTIVE=""
  WORKER_CANDIDATE_STARTED=1
  WORKER_PREACTIVATED=1
  printf 'green\n' > "$WORKER_ACTIVE_COLOR_FILE"
  : > "$MOCK_STATE/enabled-agent-saas-runtime-worker_green"

  production_deploy_rollback worker-bootstrap || fail 'Worker bootstrap rollback failed'
  assert_not_file "$WORKER_ACTIVE_COLOR_FILE"
  assert_not_file "$MOCK_STATE/enabled-agent-saas-runtime-worker_green"
)

test_worker_stops_when_web_restore_fails() (
  setup_case worker-web-independent
  printf 'old upstream\n' > "$UPSTREAM_BAK"
  printf 'old api site\n' > "$API_SITE_BAK"
  UPSTREAM_CONF="$CASE_DIR/missing/upstream.conf"
  printf 'candidate api site\n' > "$API_SITE_CONF"
  UPSTREAM_HAD_ORIGINAL=1 API_SITE_HAD_ORIGINAL=1 NGINX_CONFIG_WRITTEN=1
  WORKER_CANDIDATE_STARTED=1
  WORKER_ACTIVE_DRAIN_STARTED=1
  WORKER_PREACTIVATED=1
  printf 'green\n' > "$WORKER_ACTIVE_COLOR_FILE"
  ln -sfn "$RELEASE_DIR" "$WORKER_DIR/$WORKER_IDLE"
  : > "$MOCK_STATE/enabled-agent-saas-server_green"
  : > "$MOCK_STATE/enabled-agent-saas-runtime-worker_green"

  if production_deploy_rollback worker-web-independent; then
    fail 'Web restore failure was not surfaced'
  fi
  assert_file "$MOCK_STATE/enabled-agent-saas-server_green"
  assert_not_file "$MOCK_STATE/enabled-agent-saas-runtime-worker_green"
  assert_eq "$(readlink "$WORKER_DIR/$WORKER_IDLE")" "$PREV_WORKER_IDLE_TARGET"
  assert_eq "$(readlink "$APP_LINK")" "$RELEASE_DIR"
  assert_file "$RELEASE_DIR"
)

test_preexisting_release_and_empty_current() (
  setup_case preexisting-release
  RELEASE_CREATED_BY_DEPLOY=0
  PREV_CURRENT=""

  production_deploy_rollback preexisting-release || fail 'preexisting release rollback failed'
  assert_file "$RELEASE_DIR"
  assert_not_file "$APP_LINK"
)

test_release_env_restore() (
  setup_case release-env
  API_RELEASE_ENV="$CASE_DIR/server-green.release.env"
  WORKER_RELEASE_ENV="$CASE_DIR/runtime-worker-green.release.env"
  PREV_API_RELEASE_ENV="$CASE_DIR/server-green.before.env"
  PREV_WORKER_RELEASE_ENV="$CASE_DIR/runtime-worker-green.before.env"
  API_RELEASE_ENV_EXISTED=1 WORKER_RELEASE_ENV_EXISTED=1
  printf 'candidate api\n' > "$API_RELEASE_ENV"
  printf 'candidate worker\n' > "$WORKER_RELEASE_ENV"
  printf 'old api\n' > "$PREV_API_RELEASE_ENV"
  printf 'old worker\n' > "$PREV_WORKER_RELEASE_ENV"
  production_deploy_rollback release-env || fail 'release env rollback failed'
  assert_eq "$(cat "$API_RELEASE_ENV")" 'old api'
  assert_eq "$(cat "$WORKER_RELEASE_ENV")" 'old worker'
)

test_nginx_reload_failure
test_active_color_failure
test_runtime_identity_failure
test_unit_ownership_failure
test_worker_guard_failure
test_post_drain_web_failure
test_worker_bootstrap_failure
test_worker_stops_when_web_restore_fails
test_preexisting_release_and_empty_current
test_release_env_restore
printf 'ok - production deploy rollback fault injection (10 scenarios)\n'
