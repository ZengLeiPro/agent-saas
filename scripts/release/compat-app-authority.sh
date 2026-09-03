#!/usr/bin/env bash
# Shared App authority transaction and crash-convergent rollback publication for
# the retained compatibility deployment.

commit_compat_app_active_colors() {
  local api_color="$1" worker_color="$2"
  local api_marker="${AGENT_SAAS_API_ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
  local worker_marker="${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
  local authority_dir="${AGENT_SAAS_APP_AUTHORITY_DIR:-$(dirname "$api_marker")/app-active-color-generations}"
  local authority_link="${AGENT_SAAS_APP_AUTHORITY_LINK:-$(dirname "$api_marker")/app-active-color-current}"
  local old_api old_worker old_generation new_generation link_candidate marker_candidate

  case "$api_color:$worker_color" in
    blue:blue|blue:green|blue:absent|green:blue|green:green|green:absent) ;;
    *) return 1 ;;
  esac
  old_api="$(tr -d '[:space:]' <"$api_marker")" || return 1
  if [ -f "$worker_marker" ]; then
    old_worker="$(tr -d '[:space:]' <"$worker_marker")" || return 1
  else
    old_worker=absent
  fi
  case "$old_api:$old_worker" in
    blue:blue|blue:green|blue:absent|green:blue|green:green|green:absent) ;;
    *) return 1 ;;
  esac
  mkdir -p "$authority_dir"

  # Migrate both compatibility paths while the generation still exposes the
  # complete old App authority. SIGKILL can reveal old-old or new-new only.
  old_generation="$(mktemp -d "$authority_dir/generation-old.XXXXXX")" || return 1
  printf '%s\n' "$old_api" >"$old_generation/api"
  if [ "$old_worker" != absent ]; then
    printf '%s\n' "$old_worker" >"$old_generation/worker"
    chmod 0400 "$old_generation/worker"
  fi
  chmod 0400 "$old_generation/api"
  chmod 0500 "$old_generation"
  link_candidate="$authority_link.candidate-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}-$$"
  rm -f "$link_candidate"
  ln -s "$old_generation" "$link_candidate"
  mv -fT "$link_candidate" "$authority_link"

  marker_candidate="$api_marker.authority-link-candidate-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}-$$"
  rm -f "$marker_candidate"
  ln -s "$authority_link/api" "$marker_candidate"
  mv -fT "$marker_candidate" "$api_marker"
  marker_candidate="$worker_marker.authority-link-candidate-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}-$$"
  rm -f "$marker_candidate"
  ln -s "$authority_link/worker" "$marker_candidate"
  mv -fT "$marker_candidate" "$worker_marker"

  # This rename is the only new-authority commit. Both compatibility paths
  # resolve through authority_link and change as one App generation.
  new_generation="$(mktemp -d "$authority_dir/generation.XXXXXX")" || return 1
  printf '%s\n' "$api_color" >"$new_generation/api"
  if [ "$worker_color" != absent ]; then
    printf '%s\n' "$worker_color" >"$new_generation/worker"
    chmod 0400 "$new_generation/worker"
  fi
  chmod 0400 "$new_generation/api"
  chmod 0500 "$new_generation"
  link_candidate="$authority_link.candidate-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}-$$"
  rm -f "$link_candidate"
  ln -s "$new_generation" "$link_candidate"
  mv -fT "$link_candidate" "$authority_link"
  if [ "$worker_color" = absent ]; then
    rm -f "$worker_marker"
  fi

  [ "$(tr -d '[:space:]' <"$api_marker")" = "$api_color" ] \
    && { [ "$worker_color" = absent ] && [ ! -e "$worker_marker" ] && [ ! -L "$worker_marker" ] \
      || [ "$(tr -d '[:space:]' <"$worker_marker")" = "$worker_color" ]; }
}

compat_capture_enablement() {
  local unit="$1" value rc=0
  value="$(systemctl is-enabled "$unit" 2>/dev/null)" || rc=$?
  case "$value" in
    enabled) printf 'enabled\n' ;;
    disabled) printf 'disabled\n' ;;
    not-found|'')
      [ "$rc" -ne 0 ] || return 1
      printf 'absent\n'
      ;;
    *) return 1 ;;
  esac
}

# Publish a complete immutable rollback state before the first candidate
# symlink, App control-plane file, process, enablement, drain, or authority
# mutation. Required variables are supplied by ci.yml in the current shell.
publish_compat_deploy_rollback() {
  local state_parent state_dir state_build helper_source
  local worker_old worker_new api_env worker_env api_snapshot worker_snapshot
  local previous_current previous_previous previous_api_idle previous_worker_idle
  local api_old_enablement api_new_enablement worker_old_enablement worker_new_enablement
  local candidate target backup existed name

  : "${DEPLOY_ROOT:?}" "${RELEASE_DIR:?}" "${ACTIVE:?}" "${IDLE:?}"
  : "${SERVICE_NAME:?}" "${WORKER_SERVICE:?}" "${WORKER_DEPLOY_REQUIRED:?}"
  : "${ACTIVE_COLOR_FILE:?}" "${WORKER_ACTIVE_COLOR_FILE:?}"
  : "${API_UNIT_FILE:?}" "${WORKER_UNIT_FILE:?}" "${NGINX_DROPIN_FILE:?}"
  : "${UPSTREAM_CONF:?}" "${API_SITE_CONF:?}" "${RUNTIME_IDENTITY_FILE:?}"
  : "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"

  if [ -f "$WORKER_ACTIVE_COLOR_FILE" ]; then
    worker_old="$(tr -d '[:space:]' <"$WORKER_ACTIVE_COLOR_FILE")"
    case "$worker_old" in blue|green) ;; *) return 1 ;; esac
  else
    worker_old=absent
  fi
  if [ "$WORKER_DEPLOY_REQUIRED" = true ]; then
    case "$worker_old" in blue) worker_new=green ;; green) worker_new=blue ;; absent) worker_new=blue ;; esac
  else
    worker_new="$worker_old"
  fi

  previous_current="$(readlink "$DEPLOY_ROOT/current" 2>/dev/null || true)"
  previous_previous="$(readlink "$DEPLOY_ROOT/previous" 2>/dev/null || true)"
  previous_api_idle="$(readlink "$DEPLOY_ROOT/color/$IDLE" 2>/dev/null || true)"
  previous_worker_idle=""
  if [ "$worker_new" != absent ]; then
    previous_worker_idle="$(readlink "$DEPLOY_ROOT/worker/$worker_new" 2>/dev/null || true)"
  fi
  api_env="${AGENT_SAAS_API_RELEASE_ENV:-/etc/agent-saas/server-${IDLE}.release.env}"
  worker_env="${AGENT_SAAS_WORKER_RELEASE_ENV:-/etc/agent-saas/runtime-worker-${worker_new}.release.env}"
  api_snapshot="${AGENT_SAAS_API_PRIVATE_SNAPSHOT:-/run/${SERVICE_NAME}-${IDLE}.config-identity.json}"
  worker_snapshot="${AGENT_SAAS_WORKER_PRIVATE_SNAPSHOT:-/run/agent-saas-runtime-worker-${worker_new}.config-identity.json}"

  api_old_enablement="$(compat_capture_enablement "${SERVICE_NAME}@${ACTIVE}")" || return 1
  api_new_enablement="$(compat_capture_enablement "${SERVICE_NAME}@${IDLE}")" || return 1
  if [ "$worker_old" = absent ]; then
    worker_old_enablement=absent
  else
    worker_old_enablement="$(compat_capture_enablement "${WORKER_SERVICE}@${worker_old}")" || return 1
  fi
  if [ "$worker_new" = absent ]; then
    worker_new_enablement=absent
  elif [ "$worker_new" = "$worker_old" ]; then
    worker_new_enablement="$worker_old_enablement"
  else
    worker_new_enablement="$(compat_capture_enablement "${WORKER_SERVICE}@${worker_new}")" || return 1
  fi

  state_parent="$DEPLOY_ROOT/rollback-states"
  state_dir="$state_parent/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  state_build="$state_parent/.${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.candidate-$$"
  install -d -m 0700 "$state_parent"
  rm -rf "$state_build"
  install -d -m 0700 "$state_build"
  helper_source="${BASH_SOURCE[0]}"
  cp -a "$helper_source" "$state_build/compat-app-authority.sh"

  compat_state_var() { printf '%s=%q\n' "$1" "$2" >>"$state_build/state.env"; }
  : >"$state_build/state.env"
  chmod 0600 "$state_build/state.env"
  compat_state_var STATE_VERSION 2
  compat_state_var STATE_ROOT "$(readlink -f "$DEPLOY_ROOT")"
  compat_state_var DEPLOY_RUN_ID "$GITHUB_RUN_ID"
  compat_state_var DEPLOY_RUN_ATTEMPT "$GITHUB_RUN_ATTEMPT"
  compat_state_var DEPLOY_RELEASE "$RELEASE_DIR"
  compat_state_var API_OLD_COLOR "$ACTIVE"
  compat_state_var API_NEW_COLOR "$IDLE"
  compat_state_var WORKER_OLD_COLOR "$worker_old"
  compat_state_var WORKER_NEW_COLOR "$worker_new"
  compat_state_var PREV_CURRENT "$previous_current"
  compat_state_var PREV_PREVIOUS "$previous_previous"
  compat_state_var PREV_API_IDLE_TARGET "$previous_api_idle"
  compat_state_var PREV_WORKER_IDLE_TARGET "$previous_worker_idle"
  compat_state_var API_RELEASE_ENV "$api_env"
  compat_state_var WORKER_RELEASE_ENV "$worker_env"
  compat_state_var API_PRIVATE_SNAPSHOT "$api_snapshot"
  compat_state_var WORKER_PRIVATE_SNAPSHOT "$worker_snapshot"
  compat_state_var API_OLD_ENABLEMENT "$api_old_enablement"
  compat_state_var API_NEW_ENABLEMENT "$api_new_enablement"
  compat_state_var WORKER_OLD_ENABLEMENT "$worker_old_enablement"
  compat_state_var WORKER_NEW_ENABLEMENT "$worker_new_enablement"

  compat_capture_file() {
    target="$1"; name="$2"; existed=0
    if [ -f "$target" ]; then
      existed=1
      cp -a "$target" "$state_build/$name"
      compat_state_var "${3}_MODE" "$(stat -c %a "$target")"
      compat_state_var "${3}_UID" "$(stat -c %u "$target")"
      compat_state_var "${3}_GID" "$(stat -c %g "$target")"
    fi
    compat_state_var "$3" "$existed"
  }
  compat_capture_file "$API_UNIT_FILE" api-unit.service API_UNIT_EXISTED
  compat_capture_file "$WORKER_UNIT_FILE" worker-unit.service WORKER_UNIT_EXISTED
  compat_capture_file "$NGINX_DROPIN_FILE" nginx-dropin.conf NGINX_DROPIN_EXISTED
  compat_capture_file "$UPSTREAM_CONF" nginx-upstream.conf UPSTREAM_HAD_ORIGINAL
  compat_capture_file "$API_SITE_CONF" nginx-api-site.conf API_SITE_HAD_ORIGINAL
  compat_capture_file "$RUNTIME_IDENTITY_FILE" runtime-identity.json RUNTIME_IDENTITY_EXISTED
  compat_capture_file "$api_env" api.release.env API_RELEASE_ENV_EXISTED
  compat_capture_file "$worker_env" worker.release.env WORKER_RELEASE_ENV_EXISTED
  compat_capture_file "$api_snapshot" api-private-snapshot.json API_PRIVATE_SNAPSHOT_EXISTED
  compat_capture_file "$worker_snapshot" worker-private-snapshot.json WORKER_PRIVATE_SNAPSHOT_EXISTED

  cat >"$state_build/rollback.sh" <<'ROLLBACK'
#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="${AGENT_SAAS_COMPAT_ROOT:-/opt/agent-saas-app}"
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
STATE="${AGENT_SAAS_COMPAT_ROLLBACK_STATE:-$(dirname "$SCRIPT_PATH")}"
SERVICE="${AGENT_SAAS_API_SERVICE:-agent-saas-server}"
WORKER_SERVICE="${AGENT_SAAS_WORKER_SERVICE:-agent-saas-runtime-worker}"
ACTIVE_COLOR_FILE="${AGENT_SAAS_API_ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
WORKER_ACTIVE_COLOR_FILE="${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
UPSTREAM_CONF="${AGENT_SAAS_NGINX_UPSTREAM_FILE:-/etc/nginx/conf.d/agent-saas-upstream.conf}"
API_SITE_CONF="${AGENT_SAAS_NGINX_API_SITE_FILE:-/etc/nginx/conf.d/agent-api-kaiyan.conf}"
RUNTIME_IDENTITY_FILE="${AGENT_SAAS_RUNTIME_IDENTITY_FILE:-/etc/agent-saas/runtime-identity.json}"
SYSTEMD_DIR="${AGENT_SAAS_SYSTEMD_DIR:-/etc/systemd/system}"
APP_AUTHORITY_DIR="${AGENT_SAAS_APP_AUTHORITY_DIR:-$(dirname "$ACTIVE_COLOR_FILE")/app-active-color-generations}"
APP_AUTHORITY_LINK="${AGENT_SAAS_APP_AUTHORITY_LINK:-$(dirname "$ACTIVE_COLOR_FILE")/app-active-color-current}"
RUN_DIR="${AGENT_SAAS_RUN_DIR:-/run}"
LOCK_FILE="${AGENT_SAAS_DEPLOY_LOCK_FILE:-/run/lock/agent-saas-deploy.lock}"
ATTEMPT_LINK="$ROOT/compat-deploy-attempt-current"
log() { printf '[rollback %s] %s\n' "$(date -Is)" "$*"; }
trap 'log "rollback FAILED at line $LINENO"; exit 1' ERR
if [ "${AGENT_SAAS_DEPLOY_LOCK_HELD:-0}" -ne 1 ]; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || { log 'another deployment/rollback owns the production lock'; exit 1; }
fi
test "$SCRIPT_PATH" = "$STATE/rollback.sh"
test -s "$STATE/state.env"
# shellcheck disable=SC1090 -- generated with printf %q and immutable before publication.
source "$STATE/state.env"
test "$STATE_VERSION" = 2
test "$(readlink -f "$ROOT")" = "$STATE_ROOT"
case "$STATE" in "$STATE_ROOT/rollback-states/"*) ;; *) exit 1 ;; esac
case "$DEPLOY_RELEASE" in "$STATE_ROOT/releases/"*) ;; *) exit 1 ;; esac
if [ -L "$ATTEMPT_LINK" ]; then
  test "$(readlink -f "$ATTEMPT_LINK")" = "$STATE"
else
  test "$(readlink -f "$ROOT/rollback.sh")" = "$SCRIPT_PATH"
  test "$(readlink -f "$ROOT/rollback-state-current")" = "$STATE"
fi
# shellcheck disable=SC1090 -- helper is copied into and sealed with this state.
source "$STATE/compat-app-authority.sh"
restore_file() {
  local target="$1" backup="$2" existed="$3" prefix="$4" mode_var="${4}_MODE" uid_var="${4}_UID" gid_var="${4}_GID"
  rm -f "$target"
  if [ "$existed" -eq 1 ]; then
    cp -a "$backup" "$target"
    chmod "${!mode_var}" "$target"
    chown "${!uid_var}:${!gid_var}" "$target"
  fi
}
restore_link() {
  local target="$1" previous="$2" candidate
  if [ -n "$previous" ]; then
    candidate="${target}.rollback-candidate-${DEPLOY_RUN_ID}-${DEPLOY_RUN_ATTEMPT}-$$"
    rm -f "$candidate"
    ln -s "$previous" "$candidate"
    mv -fT "$candidate" "$target"
  else
    rm -f "$target"
  fi
}
assert_owned_link() {
  local target="$1" previous="$2" extra="${3:-}" current
  current="$(readlink "$target" 2>/dev/null || true)"
  [ "$current" = "$previous" ] || [ "$current" = "$DEPLOY_RELEASE" ] \
    || { [ -n "$extra" ] && [ "$current" = "$extra" ]; } || {
    log "ownership mismatch: $target=$current expected previous=$previous deploy=$DEPLOY_RELEASE extra=${extra:-<none>}"; return 1;
  }
}
enablement() { local value rc=0; value="$(systemctl is-enabled "$1" 2>/dev/null)" || rc=$?; case "$value" in enabled) printf enabled ;; disabled) printf disabled ;; not-found|'') [ "$rc" -ne 0 ] && printf absent ;; esac; }
restore_enablement() {
  local unit="$1" expected="$2"
  case "$expected" in enabled) systemctl enable "$unit" ;; disabled) systemctl disable "$unit" ;; absent) systemctl disable "$unit" >/dev/null 2>&1 || true ;; *) return 1 ;; esac
  test "$(enablement "$unit")" = "$expected"
}
wait_api_ready() { local color="$1" port; [ "$color" = blue ] && port=3200 || port=3201; for _ in $(seq 1 180); do curl -fsS -m 5 "http://127.0.0.1:$port/api/healthz/ready" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
wait_worker_ready() { local color="$1" pid ready; for _ in $(seq 1 180); do pid=$(cat "$RUN_DIR/agent-saas-runtime-worker-$color.pid" 2>/dev/null || true); ready=$(cat "$RUN_DIR/agent-saas-runtime-worker-$color.ready" 2>/dev/null || true); if systemctl is-active --quiet "$WORKER_SERVICE@$color" && [ -n "$pid" ] && [ "$pid" = "$ready" ] && kill -0 "$pid" 2>/dev/null; then return 0; fi; sleep 1; done; return 1; }

current_api="$(tr -d '[:space:]' <"$ACTIVE_COLOR_FILE")"
current_worker=absent
if [ -f "$WORKER_ACTIVE_COLOR_FILE" ]; then current_worker="$(tr -d '[:space:]' <"$WORKER_ACTIVE_COLOR_FILE")"; fi
case "$current_api:$current_worker" in "$API_OLD_COLOR:$WORKER_OLD_COLOR"|"$API_NEW_COLOR:$WORKER_NEW_COLOR") ;; *) log "authority ownership mismatch: $current_api:$current_worker"; exit 1 ;; esac
assert_owned_link "$ROOT/current" "$PREV_CURRENT"
assert_owned_link "$ROOT/previous" "$PREV_PREVIOUS" "$PREV_CURRENT"
assert_owned_link "$ROOT/color/$API_NEW_COLOR" "$PREV_API_IDLE_TARGET"
if [ "$WORKER_NEW_COLOR" != absent ]; then assert_owned_link "$ROOT/worker/$WORKER_NEW_COLOR" "$PREV_WORKER_IDLE_TARGET"; fi

# Legacy old runtimes do not understand execution fencing. Stop the candidate Worker before
# restarting any old API/Worker so rollback never exposes two runtime executors concurrently.
if [ "$WORKER_NEW_COLOR" != absent ] && [ "$WORKER_NEW_COLOR" != "$WORKER_OLD_COLOR" ]; then
  systemctl disable --now "$WORKER_SERVICE@$WORKER_NEW_COLOR"
fi

# Restore the exact deployment-before unit/drop-in snapshot convergently, then prepare both
# old processes without changing their captured boot enablement.
restore_file "$SYSTEMD_DIR/$SERVICE@.service" "$STATE/api-unit.service" "$API_UNIT_EXISTED" API_UNIT_EXISTED
restore_file "$SYSTEMD_DIR/$WORKER_SERVICE@.service" "$STATE/worker-unit.service" "$WORKER_UNIT_EXISTED" WORKER_UNIT_EXISTED
restore_file "$SYSTEMD_DIR/nginx.service.d/agent-saas-nas.conf" "$STATE/nginx-dropin.conf" "$NGINX_DROPIN_EXISTED" NGINX_DROPIN_EXISTED
systemctl daemon-reload
rm -f "$RUN_DIR/$SERVICE-$API_OLD_COLOR.pid" "$RUN_DIR/$SERVICE-$API_OLD_COLOR.ready" "$RUN_DIR/$SERVICE-$API_OLD_COLOR.draining" "$RUN_DIR/$SERVICE-$API_OLD_COLOR.config-identity.json"
systemctl reset-failed "$SERVICE@$API_OLD_COLOR" >/dev/null 2>&1 || true
systemctl restart "$SERVICE@$API_OLD_COLOR"
wait_api_ready "$API_OLD_COLOR"
if [ "$WORKER_OLD_COLOR" != absent ]; then
  rm -f "$RUN_DIR/agent-saas-runtime-worker-$WORKER_OLD_COLOR.pid" "$RUN_DIR/agent-saas-runtime-worker-$WORKER_OLD_COLOR.ready" "$RUN_DIR/agent-saas-runtime-worker-$WORKER_OLD_COLOR.draining" "$RUN_DIR/agent-saas-runtime-worker-$WORKER_OLD_COLOR.config-identity.json"
  systemctl reset-failed "$WORKER_SERVICE@$WORKER_OLD_COLOR" >/dev/null 2>&1 || true
  systemctl restart "$WORKER_SERVICE@$WORKER_OLD_COLOR"
  wait_worker_ready "$WORKER_OLD_COLOR"
fi

restore_file "$API_RELEASE_ENV" "$STATE/api.release.env" "$API_RELEASE_ENV_EXISTED" API_RELEASE_ENV_EXISTED
restore_file "$WORKER_RELEASE_ENV" "$STATE/worker.release.env" "$WORKER_RELEASE_ENV_EXISTED" WORKER_RELEASE_ENV_EXISTED
restore_file "$API_PRIVATE_SNAPSHOT" "$STATE/api-private-snapshot.json" "$API_PRIVATE_SNAPSHOT_EXISTED" API_PRIVATE_SNAPSHOT_EXISTED
restore_file "$WORKER_PRIVATE_SNAPSHOT" "$STATE/worker-private-snapshot.json" "$WORKER_PRIVATE_SNAPSHOT_EXISTED" WORKER_PRIVATE_SNAPSHOT_EXISTED
restore_file "$RUNTIME_IDENTITY_FILE" "$STATE/runtime-identity.json" "$RUNTIME_IDENTITY_EXISTED" RUNTIME_IDENTITY_EXISTED
restore_link "$ROOT/color/$API_NEW_COLOR" "$PREV_API_IDLE_TARGET"
if [ "$WORKER_NEW_COLOR" != absent ]; then restore_link "$ROOT/worker/$WORKER_NEW_COLOR" "$PREV_WORKER_IDLE_TARGET"; fi
restore_link "$ROOT/current" "$PREV_CURRENT"
restore_link "$ROOT/previous" "$PREV_PREVIOUS"
restore_file "$UPSTREAM_CONF" "$STATE/nginx-upstream.conf" "$UPSTREAM_HAD_ORIGINAL" UPSTREAM_HAD_ORIGINAL
restore_file "$API_SITE_CONF" "$STATE/nginx-api-site.conf" "$API_SITE_HAD_ORIGINAL" API_SITE_HAD_ORIGINAL
nginx -t

# Cross-system atomicity is impossible. Minimize the boundary and never expose
# old API routing with new Worker authority: old authority commits first, then
# old nginx routing reloads immediately with no intervening bookkeeping.
AGENT_SAAS_API_ACTIVE_COLOR_FILE="$ACTIVE_COLOR_FILE" AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE="$WORKER_ACTIVE_COLOR_FILE" AGENT_SAAS_APP_AUTHORITY_DIR="$APP_AUTHORITY_DIR" AGENT_SAAS_APP_AUTHORITY_LINK="$APP_AUTHORITY_LINK" commit_compat_app_active_colors "$API_OLD_COLOR" "$WORKER_OLD_COLOR"
systemctl reload nginx

systemctl disable --now "$SERVICE@$API_NEW_COLOR"
restore_file "$API_RELEASE_ENV" "$STATE/api.release.env" "$API_RELEASE_ENV_EXISTED" API_RELEASE_ENV_EXISTED
restore_file "$WORKER_RELEASE_ENV" "$STATE/worker.release.env" "$WORKER_RELEASE_ENV_EXISTED" WORKER_RELEASE_ENV_EXISTED
restore_file "$API_PRIVATE_SNAPSHOT" "$STATE/api-private-snapshot.json" "$API_PRIVATE_SNAPSHOT_EXISTED" API_PRIVATE_SNAPSHOT_EXISTED
restore_file "$WORKER_PRIVATE_SNAPSHOT" "$STATE/worker-private-snapshot.json" "$WORKER_PRIVATE_SNAPSHOT_EXISTED" WORKER_PRIVATE_SNAPSHOT_EXISTED
restore_file "$RUNTIME_IDENTITY_FILE" "$STATE/runtime-identity.json" "$RUNTIME_IDENTITY_EXISTED" RUNTIME_IDENTITY_EXISTED
restore_enablement "$SERVICE@$API_OLD_COLOR" "$API_OLD_ENABLEMENT"
restore_enablement "$SERVICE@$API_NEW_COLOR" "$API_NEW_ENABLEMENT"
if [ "$WORKER_OLD_COLOR" != absent ]; then restore_enablement "$WORKER_SERVICE@$WORKER_OLD_COLOR" "$WORKER_OLD_ENABLEMENT"; fi
if [ "$WORKER_NEW_COLOR" != absent ] && [ "$WORKER_NEW_COLOR" != "$WORKER_OLD_COLOR" ]; then restore_enablement "$WORKER_SERVICE@$WORKER_NEW_COLOR" "$WORKER_NEW_ENABLEMENT"; fi
systemctl is-active --quiet "$SERVICE@$API_OLD_COLOR"
! systemctl is-active --quiet "$SERVICE@$API_NEW_COLOR"
if [ "$WORKER_OLD_COLOR" != absent ]; then systemctl is-active --quiet "$WORKER_SERVICE@$WORKER_OLD_COLOR"; fi
[ "$(tr -d '[:space:]' <"$ACTIVE_COLOR_FILE")" = "$API_OLD_COLOR" ]
if [ "$WORKER_OLD_COLOR" = absent ]; then [ ! -e "$WORKER_ACTIVE_COLOR_FILE" ] && [ ! -L "$WORKER_ACTIVE_COLOR_FILE" ]; else [ "$(tr -d '[:space:]' <"$WORKER_ACTIVE_COLOR_FILE")" = "$WORKER_OLD_COLOR" ]; fi
if [ -L "$ATTEMPT_LINK" ] && [ "$(readlink -f "$ATTEMPT_LINK")" = "$STATE" ]; then rm -f "$ATTEMPT_LINK"; fi
log "rollback ok: exact snapshots and enablement restored; old authority committed immediately before old nginx reload"
ROLLBACK
  chmod 0500 "$state_build/rollback.sh"
  bash -n "$state_build/rollback.sh"
  chmod -R a-w "$state_build"
  test ! -e "$state_dir"
  mv -T "$state_build" "$state_dir"

  for target in rollback.sh rollback-state-current compat-deploy-attempt-current; do
    candidate="$DEPLOY_ROOT/.${target}.candidate-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-$$"
    rm -f "$candidate"
    if [ "$target" = rollback.sh ]; then
      ln -s "$state_dir/rollback.sh" "$candidate"
    else
      ln -s "$state_dir" "$candidate"
    fi
    mv -fT "$candidate" "$DEPLOY_ROOT/$target"
  done

  ROLLBACK_STATE_DIR="$state_dir"
  ROLLBACK_STATE_BUILD="$state_dir"
  ROLLBACK_WORKER_OLD_COLOR="$worker_old"
  ROLLBACK_WORKER_NEW_COLOR="$worker_new"
  COMPAT_ROLLBACK_PUBLISHED=1
}
