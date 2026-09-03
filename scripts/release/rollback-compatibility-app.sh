#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/opt/agent-saas-app}"
SERVICE="${SERVICE:-agent-saas-server}"
WORKER_SERVICE="${WORKER_SERVICE:-agent-saas-runtime-worker}"
ACTIVE_COLOR_FILE="${ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
WORKER_ACTIVE_COLOR_FILE="${WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
UPSTREAM_CONF="${UPSTREAM_CONF:-/etc/nginx/conf.d/agent-saas-upstream.conf}"
API_SITE_CONF="${API_SITE_CONF:-/etc/nginx/conf.d/agent-api-kaiyan.conf}"
SERVER_UNIT_PATH="${SERVER_UNIT_PATH:-/etc/systemd/system/agent-saas-server@.service}"
WORKER_UNIT_PATH="${WORKER_UNIT_PATH:-/etc/systemd/system/agent-saas-runtime-worker@.service}"
NGINX_DROP_IN_PATH="${NGINX_DROP_IN_PATH:-/etc/systemd/system/nginx.service.d/agent-saas-nas.conf}"
RUNTIME_IDENTITY_FILE="${RUNTIME_IDENTITY_FILE:-/etc/agent-saas/runtime-identity.json}"
RELEASE_ENV_ROOT="${RELEASE_ENV_ROOT:-/etc/agent-saas}"
RUN_DIR="${RUN_DIR:-/run}"
ROLLBACK_STATE_LINK="${ROLLBACK_STATE_LINK:-$ROOT/rollback-state}"
READY_ATTEMPTS="${READY_ATTEMPTS:-180}"
WORKER_READY_ATTEMPTS="${WORKER_READY_ATTEMPTS:-180}"

log() { printf '[rollback %s] %s\n' "$(date -Is)" "$*"; }
write_marker() {
  local path="$1" value="$2" candidate="${1}.candidate"
  rm -f "$candidate" || return 1
  printf '%s\n' "$value" >"$candidate" || {
    rm -f "$candidate"
    return 1
  }
  chmod 0644 "$candidate" || {
    rm -f "$candidate"
    return 1
  }
  mv -f "$candidate" "$path" || {
    rm -f "$candidate"
    return 1
  }
}
read_state() {
  local path="$STATE/$1" value
  [ -f "$path" ] && [ ! -L "$path" ] || { log "rollback state file is unsafe: $path"; return 1; }
  IFS= read -r value <"$path"
  [ -n "$value" ] || { log "rollback state value is empty: $path"; return 1; }
  printf '%s' "$value"
}
restore_required_file() {
  local source="$1" target="$2" mode="$3"
  [ -f "$source" ] && [ ! -L "$source" ] || {
    log "rollback state source is missing or unsafe: $source"
    return 1
  }
  install -m "$mode" "$source" "$target"
}
restore_optional_file() {
  local present="$1" source="$2" target="$3" mode="$4"
  case "$present" in
    true) restore_required_file "$source" "$target" "$mode" ;;
    false) rm -f "$target" ;;
    *) log "invalid rollback presence marker: $present"; return 1 ;;
  esac
}
snapshot_optional_file() {
  local source="$1" name="$2"
  if [ -L "$source" ]; then
    log "current topology file must not be a symlink: $source"
    return 1
  fi
  if [ -f "$source" ]; then
    install -m 0600 "$source" "$CURRENT_SNAPSHOT_DIR/$name.file"
    printf 'true\n' >"$CURRENT_SNAPSHOT_DIR/$name.present"
  elif [ -e "$source" ]; then
    log "current topology path is not a regular file: $source"
    return 1
  else
    printf 'false\n' >"$CURRENT_SNAPSHOT_DIR/$name.present"
  fi
}
snapshot_required_file() {
  local source="$1" name="$2"
  snapshot_optional_file "$source" "$name"
  [ "$(read_snapshot_value "$name.present")" = true ] || {
    log "required current topology file is missing: $source"
    return 1
  }
}
snapshot_link() {
  local path="$1" name="$2"
  if [ -L "$path" ]; then
    readlink "$path" >"$CURRENT_SNAPSHOT_DIR/$name.target"
    printf 'true\n' >"$CURRENT_SNAPSHOT_DIR/$name.present"
  elif [ -e "$path" ]; then
    log "current topology path is not a symlink: $path"
    return 1
  else
    printf 'false\n' >"$CURRENT_SNAPSHOT_DIR/$name.present"
  fi
}
read_snapshot_value() {
  local path="$CURRENT_SNAPSHOT_DIR/$1" value
  [ -f "$path" ] && [ ! -L "$path" ] || {
    log "current topology snapshot is missing or unsafe: $path"
    return 1
  }
  IFS= read -r value <"$path"
  [ -n "$value" ] || {
    log "current topology snapshot is empty: $path"
    return 1
  }
  printf '%s' "$value"
}
restore_snapshot_file() {
  local name="$1" target="$2" mode="$3" present
  present="$(read_snapshot_value "$name.present")" || return 1
  restore_optional_file "$present" "$CURRENT_SNAPSHOT_DIR/$name.file" "$target" "$mode"
}
restore_snapshot_link() {
  local name="$1" path="$2" present target
  present="$(read_snapshot_value "$name.present")" || return 1
  case "$present" in
    true)
      target="$(read_snapshot_value "$name.target")" || return 1
      [ ! -e "$path" ] || [ -L "$path" ] || {
        log "managed topology symlink path became unsafe: $path"
        return 1
      }
      ln -sfn "$target" "$path"
      ;;
    false) rm -f "$path" ;;
    *) log "invalid current topology presence marker: $present"; return 1 ;;
  esac
}
query_systemd_state() {
  local action="$1" unit="$2" result_name="$3" output status value=''
  if output="$(systemctl "$action" "$unit" 2>/dev/null)"; then
    status=0
  else
    status=$?
  fi
  output="$(printf '%s' "$output" | tr -d '[:space:]')"
  case "$action:$status:$output" in
    is-enabled:0:enabled) value=true ;;
    is-enabled:1:disabled) value=false ;;
    is-active:0:active) value=true ;;
    is-active:3:inactive) value=false ;;
    *)
      log "failed to query whether $unit is ${action#is-}: status=$status state=${output:-<none>}"
      return 1
      ;;
  esac
  printf -v "$result_name" '%s' "$value" || return 1
}
drain_snapshot_safety() {
  node -e '
    try {
      const state = JSON.parse(process.argv[1]);
      let safe;
      if (typeof state.idle === "boolean") {
        safe = state.idle;
      } else if (Number.isFinite(Number(state.activeUploads))) {
        safe = Number(state.activeUploads) === 0;
        if (Object.hasOwn(state, "activeStreams")) {
          safe &&= Number(state.activeStreams) === 0;
        }
        if (state.activeRuns && Object.hasOwn(state.activeRuns, "blocking")) {
          safe &&= Number(state.activeRuns.blocking) === 0;
        }
      }
      if (!Object.hasOwn(state, "idle")) {
        safe &&= state.runtimeQuiesced === true;
      }
      console.log(safe === true ? "safe" : safe === false ? "busy" : "unknown");
    } catch {
      console.log("unknown");
    }
  ' "$1" || return 1
}
target_server_identity_ready() {
  local ready_body identity_match
  if ready_body="$(curl -fsS -m 5 "http://127.0.0.1:$OTHER_PORT/api/healthz/ready" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  if identity_match="$(node -e '
    try {
      const ready = JSON.parse(process.argv[1]);
      console.log(ready.release?.releaseSha === process.argv[2] ? "true" : "false");
    } catch {
      console.log("false");
    }
  ' "$ready_body" "$EXPECTED_API_RELEASE_SHA")"; then
    :
  else
    return 1
  fi
  if [ "$identity_match" != true ]; then
    log "target $OTHER readiness identity does not match rollback release SHA"
    return 1
  fi
  return 0
}

CURRENT_SNAPSHOT_DIR="$(mktemp -d /tmp/agent-saas-rollback-current.XXXXXX)"
chmod 0700 "$CURRENT_SNAPSHOT_DIR"
CURRENT_UPSTREAM_BAK="$CURRENT_SNAPSHOT_DIR/nginx-upstream.conf"
CURRENT_API_SITE_BAK="$CURRENT_SNAPSHOT_DIR/nginx-api-site.conf"
CURRENT_UPSTREAM_PRESENT=false
CURRENT_API_SITE_PRESENT=false
cleanup_current_snapshot() {
  rm -rf -- "$CURRENT_SNAPSHOT_DIR"
}
trap cleanup_current_snapshot EXIT
trap 'status=$?; log "rollback FAILED at line $LINENO (status=$status)"; exit "$status"' ERR

CUR="$(tr -d '[:space:]' <"$ACTIVE_COLOR_FILE")"
case "$CUR" in
  blue) OTHER=green; OTHER_PORT=3201; CUR_PORT=3200 ;;
  green) OTHER=blue; OTHER_PORT=3200; CUR_PORT=3201 ;;
  *) log "invalid active color: '$CUR'"; exit 1 ;;
esac
STATE="$(readlink -f "$ROLLBACK_STATE_LINK")"
case "$STATE" in
  "$ROOT"/rollback-states/*) ;;
  *) log "rollback state escapes $ROOT/rollback-states: $STATE"; exit 1 ;;
esac
[ -d "$STATE" ] && [ ! -L "$STATE" ] || { log "rollback state directory is unsafe: $STATE"; exit 1; }
MANUAL_RECOVERY_MARKER="$STATE/rollback-nginx-manual-recovery-required"
if [ -e "$MANUAL_RECOVERY_MARKER" ] || [ -L "$MANUAL_RECOVERY_MARKER" ]; then
  log "rollback refused: unresolved manual recovery marker exists at $MANUAL_RECOVERY_MARKER"
  exit 70
fi
if [ -L "$UPSTREAM_CONF" ] || [ -L "$API_SITE_CONF" ]; then
  log 'current nginx configuration must not be a symlink'
  exit 1
fi
if [ -f "$UPSTREAM_CONF" ]; then
  install -m 0600 "$UPSTREAM_CONF" "$CURRENT_UPSTREAM_BAK"
  CURRENT_UPSTREAM_PRESENT=true
fi
if [ -f "$API_SITE_CONF" ]; then
  install -m 0600 "$API_SITE_CONF" "$CURRENT_API_SITE_BAK"
  CURRENT_API_SITE_PRESENT=true
fi

API_ACTIVE="$(read_state api-active-color)"
API_TARGET="$(read_state api-release-target)"
API_ENV_PRESENT="$(read_state api-env-present)"
EXPECTED_API_RELEASE_SHA=''
case "$API_ENV_PRESENT" in
  true)
    [ -f "$STATE/api.release.env" ] && [ ! -L "$STATE/api.release.env" ] || {
      log 'rollback API release environment is missing or unsafe'
      exit 1
    }
    EXPECTED_API_RELEASE_SHA="$(awk -F= '$1 == "AGENT_SAAS_RELEASE_SHA" { print substr($0, index($0, "=") + 1); found = 1 } END { if (!found) exit 1 }' "$STATE/api.release.env")" || {
      log 'rollback API release environment has no release SHA'
      exit 1
    }
    [ -n "$EXPECTED_API_RELEASE_SHA" ] || { log 'rollback API release SHA is empty'; exit 1; }
    ;;
  false) ;;
  *) log "invalid api-env-present marker: $API_ENV_PRESENT"; exit 1 ;;
esac
[ "$API_ACTIVE" = "$OTHER" ] || {
  log "rollback API color $API_ACTIVE does not match inactive color $OTHER"
  exit 1
}
API_TARGET_CANONICAL="$(readlink -f "$API_TARGET" 2>/dev/null || true)"
case "$API_TARGET" in
  "$ROOT"/releases/*)
    [ "$API_TARGET" = "$API_TARGET_CANONICAL" ] && [ -d "$API_TARGET" ]
    ;;
  *) log "rollback API target escapes the release root: $API_TARGET"; exit 1 ;;
esac
CURRENT_TARGET="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
case "$CURRENT_TARGET" in
  "$ROOT"/releases/*) [ -d "$CURRENT_TARGET" ] ;;
  *) log "current release target escapes the release root: ${CURRENT_TARGET:-<none>}"; exit 1 ;;
esac
TARGET_SERVER_WAS_ACTIVE=''
TARGET_SERVER_NEEDS_STOP=false
TARGET_SERVER_STOP_ATTEMPTED_BY_ROLLBACK=false
TARGET_SERVER_START_ATTEMPTED_BY_ROLLBACK=false
query_systemd_state is-active "$SERVICE@$OTHER" TARGET_SERVER_WAS_ACTIVE
TARGET_READY=0
if [ "$TARGET_SERVER_WAS_ACTIVE" = true ]; then
  TARGET_IDENTITY_READY=false
  if target_server_identity_ready; then
    TARGET_IDENTITY_READY=true
  fi
  TARGET_DRAIN_BODY="$(curl -sS -m 5 "http://127.0.0.1:$OTHER_PORT/api/healthz/drain" 2>/dev/null || true)"
  TARGET_DRAIN_SAFETY="$(drain_snapshot_safety "$TARGET_DRAIN_BODY")"
  if [ "$TARGET_DRAIN_SAFETY" = unknown ]; then
    TARGET_DRAIN_SNAPSHOT="$(cat "$RUN_DIR/$SERVICE-$OTHER.draining" 2>/dev/null || true)"
    TARGET_DRAIN_SAFETY="$(drain_snapshot_safety "$TARGET_DRAIN_SNAPSHOT")"
  fi
  [ "$TARGET_DRAIN_SAFETY" = safe ] || {
    log "rollback refused: target $OTHER verified drain state is $TARGET_DRAIN_SAFETY"
    exit 1
  }
  if [ "$TARGET_IDENTITY_READY" = true ]; then
    TARGET_READY=1
  else
    TARGET_SERVER_NEEDS_STOP=true
  fi
fi

WORKER_WAS_ACTIVE="$(read_state worker-was-active)"
case "$WORKER_WAS_ACTIVE" in
  true)
    WORKER_ACTIVE="$(read_state worker-active-color)"
    WORKER_TARGET="$(read_state worker-release-target)"
    [ "$WORKER_ACTIVE" = "$OTHER" ] || {
      log "rollback Worker color $WORKER_ACTIVE does not match inactive color $OTHER"
      exit 1
    }
    WORKER_TARGET_CANONICAL="$(readlink -f "$WORKER_TARGET" 2>/dev/null || true)"
    case "$WORKER_TARGET" in
      "$ROOT"/releases/*)
        [ "$WORKER_TARGET" = "$WORKER_TARGET_CANONICAL" ] && [ -d "$WORKER_TARGET" ]
        ;;
      *) log "rollback Worker target escapes the release root: $WORKER_TARGET"; exit 1 ;;
    esac
    ;;
  false) ;;
  *) log "invalid worker-was-active marker: $WORKER_WAS_ACTIVE"; exit 1 ;;
esac

CURRENT_WORKER_ACTIVE="$(tr -d '[:space:]' <"$WORKER_ACTIVE_COLOR_FILE" 2>/dev/null || true)"
case "$CURRENT_WORKER_ACTIVE" in
  blue|green) ;;
  '') log 'current Runtime Worker color is missing'; exit 1 ;;
  *) log "invalid current Runtime Worker color: $CURRENT_WORKER_ACTIVE"; exit 1 ;;
esac
CURRENT_SERVER_ENABLED=''
TARGET_SERVER_ENABLED=''
CURRENT_WORKER_ENABLED=''
CURRENT_WORKER_RUNNING=''
TARGET_WORKER_ENABLED=''
TARGET_WORKER_RUNNING=''
query_systemd_state is-enabled "$SERVICE@$CUR" CURRENT_SERVER_ENABLED
query_systemd_state is-enabled "$SERVICE@$OTHER" TARGET_SERVER_ENABLED
query_systemd_state is-enabled "$WORKER_SERVICE@$CURRENT_WORKER_ACTIVE" CURRENT_WORKER_ENABLED
query_systemd_state is-active "$WORKER_SERVICE@$CURRENT_WORKER_ACTIVE" CURRENT_WORKER_RUNNING
if [ "$OTHER" != "$CURRENT_WORKER_ACTIVE" ]; then
  query_systemd_state is-enabled "$WORKER_SERVICE@$OTHER" TARGET_WORKER_ENABLED
  query_systemd_state is-active "$WORKER_SERVICE@$OTHER" TARGET_WORKER_RUNNING
fi

snapshot_required_file "$SERVER_UNIT_PATH" server-unit
snapshot_required_file "$WORKER_UNIT_PATH" worker-unit
snapshot_optional_file "$NGINX_DROP_IN_PATH" nginx-drop-in
snapshot_required_file "$RUNTIME_IDENTITY_FILE" runtime-identity
snapshot_optional_file "$RELEASE_ENV_ROOT/server-$API_ACTIVE.release.env" api-target-env
snapshot_optional_file "$RUN_DIR/$SERVICE-$OTHER.draining" target-server-draining
snapshot_required_file "$WORKER_ACTIVE_COLOR_FILE" worker-active-color
snapshot_link "$ROOT/current" current-link
[ "$(read_snapshot_value current-link.present)" = true ] || {
  log 'current release symlink is missing'
  exit 1
}
snapshot_link "$ROOT/previous" previous-link
snapshot_link "$ROOT/color/$API_ACTIVE" api-target-color-link
if [ "$WORKER_WAS_ACTIVE" = true ]; then
  snapshot_link "$ROOT/worker/$WORKER_ACTIVE" worker-target-link
  snapshot_optional_file \
    "$RELEASE_ENV_ROOT/runtime-worker-$WORKER_ACTIVE.release.env" worker-target-env
  snapshot_optional_file \
    "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.draining" target-worker-draining
fi

prepare_target_topology() {
  if [ "$TARGET_SERVER_NEEDS_STOP" = true ]; then
    TARGET_SERVER_STOP_ATTEMPTED_BY_ROLLBACK=true
    systemctl stop "$SERVICE@$OTHER" || return $?
  fi
  systemctl disable --now "$WORKER_SERVICE@$CURRENT_WORKER_ACTIVE" || return $?
  if [ "$WORKER_WAS_ACTIVE" = false ] && [ "$OTHER" != "$CURRENT_WORKER_ACTIVE" ]; then
    systemctl disable --now "$WORKER_SERVICE@$OTHER" || return $?
  fi
  restore_required_file "$STATE/server@.service" "$SERVER_UNIT_PATH" 0644 || return $?
  WORKER_UNIT_PRESENT="$(read_state worker-unit-present)" || return $?
  restore_optional_file \
    "$WORKER_UNIT_PRESENT" "$STATE/runtime-worker@.service" "$WORKER_UNIT_PATH" 0644 || return $?
  NGINX_DROP_IN_PRESENT="$(read_state nginx-drop-in-present)" || return $?
  restore_optional_file "$NGINX_DROP_IN_PRESENT" "$STATE/nginx-agent-saas-nas.conf" \
    "$NGINX_DROP_IN_PATH" 0644 || return $?
  API_SITE_PRESENT="$(read_state api-site-present)" || return $?
  restore_required_file "$STATE/runtime-identity.json" "$RUNTIME_IDENTITY_FILE" 0444 || return $?
  restore_optional_file "$API_ENV_PRESENT" "$STATE/api.release.env" \
    "$RELEASE_ENV_ROOT/server-$API_ACTIVE.release.env" 0600 || return $?

  ln -sfn "$API_TARGET" "$ROOT/color/$API_ACTIVE" || return $?
  ln -sfn "$CURRENT_TARGET" "$ROOT/previous" || return $?
  ln -sfn "$API_TARGET" "$ROOT/current" || return $?

  case "$WORKER_WAS_ACTIVE" in
    true)
      ln -sfn "$WORKER_TARGET" "$ROOT/worker/$WORKER_ACTIVE" || return $?
      restore_optional_file "$(read_state worker-env-present)" "$STATE/worker.release.env" \
        "$RELEASE_ENV_ROOT/runtime-worker-$WORKER_ACTIVE.release.env" 0600 || return $?
      write_marker "$WORKER_ACTIVE_COLOR_FILE" "$WORKER_ACTIVE" || return $?
      ;;
    false)
      rm -f "$WORKER_ACTIVE_COLOR_FILE" || return $?
      ;;
  esac

  systemctl daemon-reload || return $?
  if [ "$TARGET_READY" -ne 1 ]; then
    rm -f "$RUN_DIR/$SERVICE-$API_ACTIVE.pid" \
      "$RUN_DIR/$SERVICE-$API_ACTIVE.draining" || return $?
  fi
  if [ "$WORKER_WAS_ACTIVE" = true ]; then
    rm -f "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.pid" \
      "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.ready" \
      "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.ready.authority" \
      "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.draining" || return $?
    systemctl enable "$WORKER_SERVICE@$WORKER_ACTIVE" || return $?
    systemctl restart "$WORKER_SERVICE@$WORKER_ACTIVE" || return $?
    WORKER_READY=0
    for ((attempt = 1; attempt <= WORKER_READY_ATTEMPTS; attempt++)); do
      WORKER_PID="$(cat "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.pid" 2>/dev/null || true)"
      WORKER_READY_PID="$(cat "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.ready" 2>/dev/null || true)"
      WORKER_MAIN_PID="$(systemctl show "$WORKER_SERVICE@$WORKER_ACTIVE" -p MainPID --value 2>/dev/null || true)"
      if systemctl is-active --quiet "$WORKER_SERVICE@$WORKER_ACTIVE" \
        && [ -n "$WORKER_PID" ] && [ "$WORKER_PID" = "$WORKER_READY_PID" ] \
        && [ "$WORKER_PID" = "$WORKER_MAIN_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
        WORKER_READY=1
        break
      fi
      sleep 1 || return $?
    done
    if [ "$WORKER_READY" -ne 1 ]; then
      log "$WORKER_SERVICE@$WORKER_ACTIVE not ready after ${WORKER_READY_ATTEMPTS}s"
      return 1
    fi
  fi
}

restore_current_topology() {
  local status=0
  if [ "$TARGET_SERVER_START_ATTEMPTED_BY_ROLLBACK" = true ]; then
    systemctl stop "$SERVICE@$OTHER" || status=1
  fi
  restore_snapshot_file server-unit "$SERVER_UNIT_PATH" 0644 || status=1
  restore_snapshot_file worker-unit "$WORKER_UNIT_PATH" 0644 || status=1
  restore_snapshot_file nginx-drop-in "$NGINX_DROP_IN_PATH" 0644 || status=1
  restore_snapshot_file runtime-identity "$RUNTIME_IDENTITY_FILE" 0444 || status=1
  restore_snapshot_file api-target-env \
    "$RELEASE_ENV_ROOT/server-$API_ACTIVE.release.env" 0600 || status=1
  restore_snapshot_file worker-active-color "$WORKER_ACTIVE_COLOR_FILE" 0644 || status=1
  restore_snapshot_link current-link "$ROOT/current" || status=1
  restore_snapshot_link previous-link "$ROOT/previous" || status=1
  restore_snapshot_link api-target-color-link "$ROOT/color/$API_ACTIVE" || status=1
  if [ "$WORKER_WAS_ACTIVE" = true ]; then
    restore_snapshot_link worker-target-link "$ROOT/worker/$WORKER_ACTIVE" || status=1
    restore_snapshot_file worker-target-env \
      "$RELEASE_ENV_ROOT/runtime-worker-$WORKER_ACTIVE.release.env" 0600 || status=1
  fi
  systemctl daemon-reload || status=1
  if [ "$CURRENT_SERVER_ENABLED" = true ]; then
    systemctl enable "$SERVICE@$CUR" || status=1
  else
    systemctl disable "$SERVICE@$CUR" || status=1
  fi
  if [ "$TARGET_SERVER_ENABLED" = true ]; then
    systemctl enable "$SERVICE@$OTHER" || status=1
  else
    systemctl disable "$SERVICE@$OTHER" || status=1
  fi
  if [ "$TARGET_SERVER_STOP_ATTEMPTED_BY_ROLLBACK" = true ] \
    && [ "$TARGET_SERVER_WAS_ACTIVE" = true ]; then
    systemctl restart "$SERVICE@$OTHER" || status=1
  fi
  restore_snapshot_file target-server-draining \
    "$RUN_DIR/$SERVICE-$OTHER.draining" 0644 || status=1
  if [ "$OTHER" != "$CURRENT_WORKER_ACTIVE" ]; then
    if [ "$TARGET_WORKER_ENABLED" = true ]; then
      systemctl enable "$WORKER_SERVICE@$OTHER" || status=1
    else
      systemctl disable "$WORKER_SERVICE@$OTHER" || status=1
    fi
    if [ "$TARGET_WORKER_RUNNING" = true ]; then
      systemctl restart "$WORKER_SERVICE@$OTHER" || status=1
    else
      systemctl stop "$WORKER_SERVICE@$OTHER" || status=1
    fi
  fi
  if [ "$CURRENT_WORKER_ENABLED" = true ]; then
    systemctl enable "$WORKER_SERVICE@$CURRENT_WORKER_ACTIVE" || status=1
  else
    systemctl disable "$WORKER_SERVICE@$CURRENT_WORKER_ACTIVE" || status=1
  fi
  if [ "$CURRENT_WORKER_RUNNING" = true ]; then
    systemctl restart "$WORKER_SERVICE@$CURRENT_WORKER_ACTIVE" || status=1
  else
    systemctl stop "$WORKER_SERVICE@$CURRENT_WORKER_ACTIVE" || status=1
  fi
  if [ "$WORKER_WAS_ACTIVE" = true ]; then
    restore_snapshot_file target-worker-draining \
      "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.draining" 0644 || status=1
  fi
  if [ "$status" -ne 0 ]; then
    log 'current Server/Worker topology restoration completed with one or more failures'
    return 70
  fi
  log 'current Server/Worker units, enablement, activity, draining state, identity, env, symlinks, and Worker ownership restored'
}

restore_current_nginx_files() {
  local status=0
  restore_optional_file "$CURRENT_UPSTREAM_PRESENT" "$CURRENT_UPSTREAM_BAK" \
    "$UPSTREAM_CONF" 0644 || status=1
  restore_optional_file "$CURRENT_API_SITE_PRESENT" "$CURRENT_API_SITE_BAK" \
    "$API_SITE_CONF" 0644 || status=1
  return "$status"
}

current_server_ready_for_reversal() {
  local running=''
  if ! query_systemd_state is-active "$SERVICE@$CUR" running; then
    return 1
  fi
  if [ "$running" != true ]; then
    log "cannot reverse traffic: current Server $SERVICE@$CUR is inactive"
    return 1
  fi
  if ! curl -fsS -m 5 "http://127.0.0.1:$CUR_PORT/api/healthz/ready" >/dev/null 2>&1; then
    log "cannot reverse traffic: current Server $SERVICE@$CUR is not ready"
    return 1
  fi
  return 0
}

mark_nginx_recovery_required() {
  local marker="$STATE/rollback-nginx-manual-recovery-required" candidate="${STATE}/rollback-nginx-manual-recovery-required.candidate"
  rm -f "$candidate" || return 1
  {
    printf 'fromColor=%s\n' "$CUR"
    printf 'targetColor=%s\n' "$OTHER"
    printf 'reason=%s\n' "$1"
    printf 'recordedAt=%s\n' "$(date -Is)"
  } >"$candidate" || return 1
  chmod 0600 "$candidate" || {
    rm -f "$candidate"
    return 1
  }
  mv -f "$candidate" "$marker" || {
    rm -f "$candidate"
    return 1
  }
}

restore_current_pre_switch_state() {
  local reason="$1" status=0 marker_ready=false
  local marker="$STATE/rollback-nginx-manual-recovery-required"
  if mark_nginx_recovery_required "$reason"; then
    marker_ready=true
  else
    log 'failed to stage the manual recovery marker before topology restoration'
  fi
  restore_current_topology || status=1
  restore_current_nginx_files || status=1
  if [ "$status" -ne 0 ]; then
    if [ "$marker_ready" != true ] && ! mark_nginx_recovery_required "$reason"; then
      log 'CRITICAL: topology restoration and manual recovery marker persistence both failed'
    fi
    return 70
  fi
  if ! rm -f "$marker"; then
    log 'restoration succeeded but the manual recovery marker could not be cleared'
    return 70
  fi
  return 0
}

restore_current_nginx_runtime() {
  local reason="$1" topology_status=0 nginx_status=0 marker_ready=false
  local marker="$STATE/rollback-nginx-manual-recovery-required"
  if mark_nginx_recovery_required "$reason"; then
    marker_ready=true
  else
    log 'failed to stage the manual recovery marker before nginx reversal'
  fi
  current_server_ready_for_reversal || nginx_status=1
  if [ "$nginx_status" -eq 0 ]; then
    restore_current_nginx_files || nginx_status=1
  fi
  if [ "$nginx_status" -eq 0 ]; then
    nginx -t || nginx_status=1
  fi
  if [ "$nginx_status" -eq 0 ]; then
    systemctl reload nginx || nginx_status=1
  fi
  if [ "$nginx_status" -eq 0 ]; then
    current_server_ready_for_reversal || nginx_status=1
  fi
  if [ "$nginx_status" -eq 0 ]; then
    write_marker "$ACTIVE_COLOR_FILE" "$CUR" || nginx_status=1
  fi
  if [ "$nginx_status" -eq 0 ]; then
    restore_current_topology || topology_status=1
  fi
  if [ "$topology_status" -ne 0 ] || [ "$nginx_status" -ne 0 ]; then
    if [ "$marker_ready" != true ] && ! mark_nginx_recovery_required "$reason"; then
      log 'CRITICAL: runtime reversal and manual recovery marker persistence both failed'
    fi
    return 70
  fi
  if ! rm -f "$marker"; then
    log 'runtime reversal succeeded but the manual recovery marker could not be cleared'
    return 70
  fi
  return 0
}

switch_traffic_back() {
  if ! target_server_identity_ready; then
    log 'target Server identity/readiness changed before traffic switch; restoring current topology'
    restore_current_pre_switch_state 'target-identity-readiness-and-current-restore-failed' || return 70
    return 1
  fi
  if ! restore_optional_file "$API_SITE_PRESENT" "$STATE/api-site.conf" \
    "$API_SITE_CONF" 0644; then
    restore_current_pre_switch_state 'target-api-site-install-and-topology-restore-failed' || return 70
    return 1
  fi
  if ! cat >"$UPSTREAM_CONF" <<EOF
# active=$OTHER
# 由 rollback-compatibility-app.sh 重写
upstream agent_saas_backend {
    server 127.0.0.1:$OTHER_PORT;
    server 127.0.0.1:$CUR_PORT backup;
}
EOF
  then
    restore_current_pre_switch_state 'target-upstream-write-and-topology-restore-failed' || return 70
    return 1
  fi
  if ! nginx -t; then
    restore_current_pre_switch_state 'target-nginx-test-and-topology-restore-failed' || return 70
    return 1
  fi
  if ! systemctl reload nginx; then
    log 'target nginx reload failed; restoring the complete pre-rollback runtime'
    restore_current_nginx_runtime 'target-nginx-reload-and-reverse-failed' || return 70
    return 1
  fi
  if ! write_marker "$ACTIVE_COLOR_FILE" "$OTHER"; then
    log 'target nginx is live but active marker update failed; reversing the complete runtime'
    restore_current_nginx_runtime 'active-marker-update-and-nginx-reverse-failed' || return 70
    return 1
  fi
  if ! systemctl enable "$SERVICE@$OTHER"; then
    log 'target Server enable failed after traffic switch; reversing the complete runtime'
    restore_current_nginx_runtime 'target-server-enable-and-runtime-reverse-failed' || return 70
    return 1
  fi
  if ! systemctl disable "$SERVICE@$CUR"; then
    log 'current Server disable failed after traffic switch; reversing the complete runtime'
    restore_current_nginx_runtime 'current-server-disable-and-runtime-reverse-failed' || return 70
    return 1
  fi
  log "traffic switched back: active=$OTHER"
}

exit_after_pre_switch_recovery() {
  local failed_status="$1" reason="$2"
  if restore_current_pre_switch_state "$reason"; then
    exit "$failed_status"
  fi
  exit 70
}

if prepare_target_topology; then
  :
else
  PREPARE_STATUS=$?
  log "target topology preparation failed; restoring the pre-rollback runtime"
  exit_after_pre_switch_recovery \
    "$PREPARE_STATUS" 'target-topology-preparation-and-current-restore-failed'
fi

log "rollback: active=$CUR -> target=$OTHER release=$API_TARGET"
if [ "$TARGET_READY" -eq 1 ]; then
  switch_traffic_back
  log 'rollback ok (fast path with durable state restored)'
  exit 0
fi

TARGET_SERVER_START_ATTEMPTED_BY_ROLLBACK=true
if systemctl start "$SERVICE@$OTHER"; then
  :
else
  START_STATUS=$?
  log "failed to start $SERVICE@$OTHER; restoring the pre-rollback runtime"
  exit_after_pre_switch_recovery \
    "$START_STATUS" 'target-server-start-and-current-restore-failed'
fi
for ((attempt = 1; attempt <= READY_ATTEMPTS; attempt++)); do
  if target_server_identity_ready; then
    switch_traffic_back
    log 'rollback ok (slow path)'
    exit 0
  fi
  if sleep 1; then
    :
  else
    SLEEP_STATUS=$?
    log 'target Server readiness wait failed; restoring the pre-rollback runtime'
    exit_after_pre_switch_recovery \
      "$SLEEP_STATUS" 'target-server-readiness-wait-and-current-restore-failed'
  fi
done
log "$SERVICE@$OTHER not ready after ${READY_ATTEMPTS}s; restoring the pre-rollback runtime"
exit_after_pre_switch_recovery 1 'target-server-readiness-and-current-restore-failed'
