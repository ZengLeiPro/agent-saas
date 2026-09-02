#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/opt/agent-saas-app}"
SERVICE="${SERVICE:-agent-saas-server}"
WORKER_SERVICE="${WORKER_SERVICE:-agent-saas-runtime-worker}"
ACTIVE_COLOR_FILE="${ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
WORKER_ACTIVE_COLOR_FILE="${WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
UPSTREAM_CONF="${UPSTREAM_CONF:-/etc/nginx/conf.d/agent-saas-upstream.conf}"
SERVER_UNIT_PATH="${SERVER_UNIT_PATH:-/etc/systemd/system/agent-saas-server@.service}"
WORKER_UNIT_PATH="${WORKER_UNIT_PATH:-/etc/systemd/system/agent-saas-runtime-worker@.service}"
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

trap 'log "rollback FAILED at line $LINENO"; exit 1' ERR

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
CURRENT_WORKER_ACTIVE="$(tr -d '[:space:]' <"$WORKER_ACTIVE_COLOR_FILE" 2>/dev/null || true)"
case "$CURRENT_WORKER_ACTIVE" in
  blue|green) systemctl disable --now "$WORKER_SERVICE@$CURRENT_WORKER_ACTIVE" ;;
  '') log 'current Runtime Worker color is missing'; exit 1 ;;
  *) log "invalid current Runtime Worker color: $CURRENT_WORKER_ACTIVE"; exit 1 ;;
esac

restore_required_file "$STATE/server@.service" "$SERVER_UNIT_PATH" 0644
WORKER_UNIT_PRESENT="$(read_state worker-unit-present)"
restore_optional_file "$WORKER_UNIT_PRESENT" "$STATE/runtime-worker@.service" "$WORKER_UNIT_PATH" 0644
restore_required_file "$STATE/runtime-identity.json" "$RUNTIME_IDENTITY_FILE" 0444
restore_optional_file "$(read_state api-env-present)" "$STATE/api.release.env" \
  "$RELEASE_ENV_ROOT/server-$API_ACTIVE.release.env" 0600

ln -sfn "$API_TARGET" "$ROOT/color/$API_ACTIVE"
ln -sfn "$CURRENT_TARGET" "$ROOT/previous"
ln -sfn "$API_TARGET" "$ROOT/current"

case "$WORKER_WAS_ACTIVE" in
  true)
    WORKER_ACTIVE="$(read_state worker-active-color)"
    WORKER_TARGET="$(read_state worker-release-target)"
    case "$WORKER_ACTIVE" in blue|green) ;; *) log "invalid rollback Worker color: $WORKER_ACTIVE"; exit 1 ;; esac
    WORKER_TARGET_CANONICAL="$(readlink -f "$WORKER_TARGET" 2>/dev/null || true)"
    case "$WORKER_TARGET" in
      "$ROOT"/releases/*)
        [ "$WORKER_TARGET" = "$WORKER_TARGET_CANONICAL" ] && [ -d "$WORKER_TARGET" ]
        ;;
      *) log "rollback Worker target escapes the release root: $WORKER_TARGET"; exit 1 ;;
    esac
    ln -sfn "$WORKER_TARGET" "$ROOT/worker/$WORKER_ACTIVE"
    restore_optional_file "$(read_state worker-env-present)" "$STATE/worker.release.env" \
      "$RELEASE_ENV_ROOT/runtime-worker-$WORKER_ACTIVE.release.env" 0600
    write_marker "$WORKER_ACTIVE_COLOR_FILE" "$WORKER_ACTIVE"
    ;;
  false)
    rm -f "$WORKER_ACTIVE_COLOR_FILE"
    ;;
  *) log "invalid worker-was-active marker: $WORKER_WAS_ACTIVE"; exit 1 ;;
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

switch_traffic_back() {
  cat >"$UPSTREAM_CONF" <<EOF
# active=$OTHER
# 由 rollback-compatibility-app.sh 重写
upstream agent_saas_backend {
    server 127.0.0.1:$OTHER_PORT;
    server 127.0.0.1:$CUR_PORT backup;
}
EOF
  write_marker "$ACTIVE_COLOR_FILE" "$OTHER"
  if ! { nginx -t && systemctl reload nginx; }; then
    write_marker "$ACTIVE_COLOR_FILE" "$CUR" || true
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
