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
  rm -f "$candidate"
  printf '%s\n' "$value" >"$candidate"
  chmod 0644 "$candidate"
  mv -f "$candidate" "$path"
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
TARGET_READY=0
if systemctl is-active --quiet "$SERVICE@$OTHER"; then
  if curl -fsS -m 5 "http://127.0.0.1:$OTHER_PORT/api/healthz/ready" >/dev/null 2>&1; then
    TARGET_READY=1
  else
    TARGET_DRAIN_BODY="$(curl -sS -m 5 "http://127.0.0.1:$OTHER_PORT/api/healthz/drain" 2>/dev/null || true)"
    TARGET_ACTIVE_UPLOADS="$(node -e '
      try { console.log(Number(JSON.parse(process.argv[1]).activeUploads ?? 0)); }
      catch { console.log(-1); }
    ' "$TARGET_DRAIN_BODY")"
    if [ "$TARGET_ACTIVE_UPLOADS" -eq -1 ]; then
      TARGET_DRAIN_SNAPSHOT="$(cat "$RUN_DIR/$SERVICE-$OTHER.draining" 2>/dev/null || true)"
      TARGET_ACTIVE_UPLOADS="$(node -e '
        try { console.log(Number(JSON.parse(process.argv[1]).activeUploads ?? -1)); }
        catch { console.log(-1); }
      ' "$TARGET_DRAIN_SNAPSHOT")"
    fi
    [ "$TARGET_ACTIVE_UPLOADS" -eq 0 ] || {
      log "rollback refused: target $OTHER is draining with activeUploads=$TARGET_ACTIVE_UPLOADS"
      exit 1
    }
    systemctl stop "$SERVICE@$OTHER"
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
CURRENT_WORKER_ENABLED=false
if systemctl is-enabled --quiet "$WORKER_SERVICE@$CURRENT_WORKER_ACTIVE"; then
  CURRENT_WORKER_ENABLED=true
fi
CURRENT_WORKER_RUNNING=false
if systemctl is-active --quiet "$WORKER_SERVICE@$CURRENT_WORKER_ACTIVE"; then
  CURRENT_WORKER_RUNNING=true
fi

snapshot_required_file "$SERVER_UNIT_PATH" server-unit
snapshot_required_file "$WORKER_UNIT_PATH" worker-unit
snapshot_optional_file "$NGINX_DROP_IN_PATH" nginx-drop-in
snapshot_required_file "$RUNTIME_IDENTITY_FILE" runtime-identity
snapshot_optional_file "$RELEASE_ENV_ROOT/server-$API_ACTIVE.release.env" api-target-env
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
fi

systemctl disable --now "$WORKER_SERVICE@$CURRENT_WORKER_ACTIVE"
restore_required_file "$STATE/server@.service" "$SERVER_UNIT_PATH" 0644
WORKER_UNIT_PRESENT="$(read_state worker-unit-present)"
restore_optional_file "$WORKER_UNIT_PRESENT" "$STATE/runtime-worker@.service" "$WORKER_UNIT_PATH" 0644
NGINX_DROP_IN_PRESENT="$(read_state nginx-drop-in-present)"
restore_optional_file "$NGINX_DROP_IN_PRESENT" "$STATE/nginx-agent-saas-nas.conf" \
  "$NGINX_DROP_IN_PATH" 0644
API_SITE_PRESENT="$(read_state api-site-present)"
restore_required_file "$STATE/runtime-identity.json" "$RUNTIME_IDENTITY_FILE" 0444
restore_optional_file "$(read_state api-env-present)" "$STATE/api.release.env" \
  "$RELEASE_ENV_ROOT/server-$API_ACTIVE.release.env" 0600

ln -sfn "$API_TARGET" "$ROOT/color/$API_ACTIVE"
ln -sfn "$CURRENT_TARGET" "$ROOT/previous"
ln -sfn "$API_TARGET" "$ROOT/current"

case "$WORKER_WAS_ACTIVE" in
  true)
    ln -sfn "$WORKER_TARGET" "$ROOT/worker/$WORKER_ACTIVE"
    restore_optional_file "$(read_state worker-env-present)" "$STATE/worker.release.env" \
      "$RELEASE_ENV_ROOT/runtime-worker-$WORKER_ACTIVE.release.env" 0600
    write_marker "$WORKER_ACTIVE_COLOR_FILE" "$WORKER_ACTIVE"
    ;;
  false)
    rm -f "$WORKER_ACTIVE_COLOR_FILE"
    ;;
esac

systemctl daemon-reload
rm -f "$RUN_DIR/$SERVICE-$API_ACTIVE.pid" "$RUN_DIR/$SERVICE-$API_ACTIVE.draining"
if [ "$WORKER_WAS_ACTIVE" = true ]; then
  rm -f "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.pid" \
    "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.ready" \
    "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.ready.authority" \
    "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.draining"
  systemctl enable "$WORKER_SERVICE@$WORKER_ACTIVE"
  systemctl restart "$WORKER_SERVICE@$WORKER_ACTIVE"
  WORKER_READY=0
  for _ in $(seq 1 "$WORKER_READY_ATTEMPTS"); do
    WORKER_PID="$(cat "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.pid" 2>/dev/null || true)"
    WORKER_READY_PID="$(cat "$RUN_DIR/$WORKER_SERVICE-$WORKER_ACTIVE.ready" 2>/dev/null || true)"
    WORKER_MAIN_PID="$(systemctl show "$WORKER_SERVICE@$WORKER_ACTIVE" -p MainPID --value 2>/dev/null || true)"
    if systemctl is-active --quiet "$WORKER_SERVICE@$WORKER_ACTIVE" \
      && [ -n "$WORKER_PID" ] && [ "$WORKER_PID" = "$WORKER_READY_PID" ] \
      && [ "$WORKER_PID" = "$WORKER_MAIN_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
      WORKER_READY=1
      break
    fi
    sleep 1
  done
  [ "$WORKER_READY" -eq 1 ] || {
    log "$WORKER_SERVICE@$WORKER_ACTIVE not ready after ${WORKER_READY_ATTEMPTS}s"
    exit 1
  }
fi

restore_current_topology() {
  local status=0
  if [ "$WORKER_WAS_ACTIVE" = true ] && [ "$WORKER_ACTIVE" != "$CURRENT_WORKER_ACTIVE" ]; then
    systemctl disable --now "$WORKER_SERVICE@$WORKER_ACTIVE" || status=1
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
  if [ "$status" -ne 0 ]; then
    log 'current Server/Worker topology restoration completed with one or more failures'
    return 70
  fi
  log 'current Server/Worker units, identity, env, symlinks, and Worker ownership restored'
}

restore_current_nginx_files() {
  local status=0
  restore_optional_file "$CURRENT_UPSTREAM_PRESENT" "$CURRENT_UPSTREAM_BAK" \
    "$UPSTREAM_CONF" 0644 || status=1
  restore_optional_file "$CURRENT_API_SITE_PRESENT" "$CURRENT_API_SITE_BAK" \
    "$API_SITE_CONF" 0644 || status=1
  return "$status"
}

restore_current_pre_switch_state() {
  local reason="$1" status=0
  restore_current_topology || status=1
  restore_current_nginx_files || status=1
  if [ "$status" -ne 0 ]; then
    mark_nginx_recovery_required "$reason" || true
    return 70
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

restore_current_nginx_runtime() {
  local reason="$1" topology_status=0 nginx_status=0
  restore_current_topology || topology_status=1
  restore_current_nginx_files || nginx_status=1
  if [ "$nginx_status" -eq 0 ]; then
    nginx -t || nginx_status=1
  fi
  if [ "$nginx_status" -eq 0 ]; then
    systemctl reload nginx || nginx_status=1
  fi
  if [ "$nginx_status" -eq 0 ]; then
    write_marker "$ACTIVE_COLOR_FILE" "$CUR" || nginx_status=1
  fi
  if [ "$topology_status" -ne 0 ] || [ "$nginx_status" -ne 0 ]; then
    mark_nginx_recovery_required "$reason" || true
    return 70
  fi
  return 0
}

switch_traffic_back() {
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
  systemctl enable "$SERVICE@$OTHER"
  systemctl disable "$SERVICE@$CUR"
  log "traffic switched back: active=$OTHER"
}

log "rollback: active=$CUR -> target=$OTHER release=$API_TARGET"
if [ "$TARGET_READY" -eq 1 ]; then
  switch_traffic_back
  log 'rollback ok (fast path with durable state restored)'
  exit 0
fi

systemctl start "$SERVICE@$OTHER"
for _ in $(seq 1 "$READY_ATTEMPTS"); do
  if curl -fsS -m 5 "http://127.0.0.1:$OTHER_PORT/api/healthz/ready" >/dev/null 2>&1; then
    switch_traffic_back
    log 'rollback ok (slow path)'
    exit 0
  fi
  sleep 1
done
log "$SERVICE@$OTHER not ready after ${READY_ATTEMPTS}s"
exit 1
