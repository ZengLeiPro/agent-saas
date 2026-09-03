#!/usr/bin/env bash
set -Eeuo pipefail

: "${DEPLOY_ROOT:?DEPLOY_ROOT is required}"
: "${ROLLBACK_STATE_DIR:?ROLLBACK_STATE_DIR is required}"

SERVER_UNIT_PATH="${SERVER_UNIT_PATH:-/etc/systemd/system/agent-saas-server@.service}"
WORKER_UNIT_PATH="${WORKER_UNIT_PATH:-/etc/systemd/system/agent-saas-runtime-worker@.service}"
NGINX_DROP_IN_PATH="${NGINX_DROP_IN_PATH:-/etc/systemd/system/nginx.service.d/agent-saas-nas.conf}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
NGINX_BIN="${NGINX_BIN:-nginx}"

log() { printf '[compatibility-transaction %s] %s\n' "$(date -Is)" "$*" >&2; }

assert_safe_state_dir() {
  local managed_root="$DEPLOY_ROOT/rollback-states" canonical_state
  case "$ROLLBACK_STATE_DIR" in
    "$managed_root"/*) ;;
    *) log "rollback state escapes managed root: $ROLLBACK_STATE_DIR"; return 1 ;;
  esac
  [ -d "$ROLLBACK_STATE_DIR" ] && [ ! -L "$ROLLBACK_STATE_DIR" ] || {
    log "rollback state directory is missing or unsafe: $ROLLBACK_STATE_DIR"
    return 1
  }
  canonical_state="$(readlink -f "$ROLLBACK_STATE_DIR")"
  [ "$canonical_state" = "$ROLLBACK_STATE_DIR" ] || {
    log "rollback state directory must be canonical: $ROLLBACK_STATE_DIR"
    return 1
  }
}

read_state() {
  local path="$ROLLBACK_STATE_DIR/$1" value
  [ -f "$path" ] && [ ! -L "$path" ] || {
    log "rollback state file is missing or unsafe: $path"
    return 1
  }
  IFS= read -r value <"$path"
  [ -n "$value" ] || {
    log "rollback state value is empty: $path"
    return 1
  }
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

restore_units() {
  local worker_unit_present='' nginx_drop_in_present='' restore_status=0
  assert_safe_state_dir
  restore_required_file "$ROLLBACK_STATE_DIR/server@.service" "$SERVER_UNIT_PATH" 0644 || restore_status=1
  if ! worker_unit_present="$(read_state worker-unit-present)"; then
    restore_status=1
  fi
  case "$worker_unit_present" in
    true)
      restore_required_file "$ROLLBACK_STATE_DIR/runtime-worker@.service" "$WORKER_UNIT_PATH" 0644 || restore_status=1
      ;;
    false)
      rm -f "$WORKER_UNIT_PATH" || restore_status=1
      ;;
    '') ;;
    *)
      log "invalid worker-unit-present marker: $worker_unit_present"
      restore_status=1
      ;;
  esac
  if ! nginx_drop_in_present="$(read_state nginx-drop-in-present)"; then
    restore_status=1
  fi
  case "$nginx_drop_in_present" in
    true)
      restore_required_file "$ROLLBACK_STATE_DIR/nginx-agent-saas-nas.conf" "$NGINX_DROP_IN_PATH" 0644 || restore_status=1
      ;;
    false)
      rm -f "$NGINX_DROP_IN_PATH" || restore_status=1
      ;;
    '') ;;
    *)
      log "invalid nginx-drop-in-present marker: $nginx_drop_in_present"
      restore_status=1
      ;;
  esac
  "$SYSTEMCTL_BIN" daemon-reload || restore_status=1
  if [ "$restore_status" -ne 0 ]; then
    log 'previous unit restoration completed with one or more failures'
    return 70
  fi
  log 'previous Server/Runtime Worker/nginx units restored and daemon reloaded'
}

restore_link() {
  local path="$1" target="$2"
  case "$path" in
    "$DEPLOY_ROOT"/*) ;;
    *) log "managed symlink escapes deploy root: $path"; return 1 ;;
  esac
  if [ -n "$target" ]; then
    ln -sfn "$target" "$path"
  else
    rm -f "$path"
  fi
}

restore_symlinks() {
  local restore_status=0
  : "${SYMLINKS_DIRTY:?SYMLINKS_DIRTY is required}"
  : "${WORKER_SYMLINK_DIRTY:?WORKER_SYMLINK_DIRTY is required}"
  case "$SYMLINKS_DIRTY" in 0|1) ;; *) log "invalid SYMLINKS_DIRTY: $SYMLINKS_DIRTY"; return 64 ;; esac
  case "$WORKER_SYMLINK_DIRTY" in 0|1) ;; *) log "invalid WORKER_SYMLINK_DIRTY: $WORKER_SYMLINK_DIRTY"; return 64 ;; esac

  if [ "$SYMLINKS_DIRTY" -eq 1 ]; then
    : "${PREV_LINK:?PREV_LINK is required}"
    : "${COLOR_IDLE_LINK:?COLOR_IDLE_LINK is required}"
    : "${PREVIOUS_UPDATED:?PREVIOUS_UPDATED is required}"
    restore_link "$PREV_LINK" "${PREV_CURRENT:-}" || restore_status=1
    if [ "$PREVIOUS_UPDATED" -eq 1 ]; then
      : "${PREVIOUS_LINK:?PREVIOUS_LINK is required}"
      restore_link "$PREVIOUS_LINK" "${PREV_PREVIOUS:-}" || restore_status=1
    fi
    restore_link "$COLOR_IDLE_LINK" "${PREV_IDLE_TARGET:-}" || restore_status=1
  fi

  if [ "$WORKER_SYMLINK_DIRTY" -eq 1 ]; then
    : "${WORKER_IDLE_LINK:?WORKER_IDLE_LINK is required}"
    restore_link "$WORKER_IDLE_LINK" "${PREV_WORKER_IDLE_TARGET:-}" || restore_status=1
  fi

  if [ "$restore_status" -ne 0 ]; then
    log 'pre-deploy symlink restoration completed with one or more failures'
    return 70
  fi
  log 'pre-deploy Server/Worker symlinks restored'
}

restore_optional_backup() {
  local backup="$1" target="$2"
  if [ -f "$backup" ] && [ ! -L "$backup" ]; then
    cp "$backup" "$target"
  elif [ -e "$backup" ] || [ -L "$backup" ]; then
    log "nginx backup is unsafe: $backup"
    return 1
  else
    rm -f "$target"
  fi
}

restore_nginx() {
  local restore_status=0
  : "${UPSTREAM_CONF:?UPSTREAM_CONF is required}"
  : "${UPSTREAM_BAK:?UPSTREAM_BAK is required}"
  : "${API_SITE_CONF:?API_SITE_CONF is required}"
  : "${API_SITE_BAK:?API_SITE_BAK is required}"
  restore_optional_backup "$UPSTREAM_BAK" "$UPSTREAM_CONF" || restore_status=1
  restore_optional_backup "$API_SITE_BAK" "$API_SITE_CONF" || restore_status=1
  if [ "$restore_status" -eq 0 ]; then
    "$NGINX_BIN" -t || restore_status=1
  fi
  if [ "$restore_status" -eq 0 ]; then
    "$SYSTEMCTL_BIN" reload nginx || restore_status=1
  fi
  if [ "$restore_status" -ne 0 ]; then
    log 'failed to restore and reload the previous nginx configuration'
    return 70
  fi
  log 'previous nginx configuration restored and reloaded'
}

mark_manual_recovery() {
  local marker="$ROLLBACK_STATE_DIR/manual-recovery-required" candidate
  candidate="${marker}.candidate"
  : "${RELEASE_ID:?RELEASE_ID is required}"
  : "${FAILED_STATUS:?FAILED_STATUS is required}"
  : "${FAILED_LINE:?FAILED_LINE is required}"
  assert_safe_state_dir
  rm -f "$candidate"
  {
    printf 'releaseId=%s\n' "$RELEASE_ID"
    printf 'failedStatus=%s\n' "$FAILED_STATUS"
    printf 'failedLine=%s\n' "$FAILED_LINE"
    printf 'trafficSwitched=true\n'
    printf 'rollbackStateCommitted=false\n'
    printf 'recordedAt=%s\n' "$(date -Is)"
  } >"$candidate"
  chmod 0600 "$candidate"
  mv -f "$candidate" "$marker"
  log "manual recovery required; rollback snapshot preserved: $ROLLBACK_STATE_DIR"
}

recover_nginx_switch() {
  if restore_nginx; then
    return 0
  fi
  mark_manual_recovery || log 'failed to persist manual recovery marker'
  return 70
}

case "${1:-}" in
  restore-units) restore_units ;;
  restore-symlinks) restore_symlinks ;;
  restore-nginx) restore_nginx ;;
  recover-nginx-switch) recover_nginx_switch ;;
  mark-manual-recovery) mark_manual_recovery ;;
  *)
    echo 'usage: compatibility-deploy-transaction.sh <restore-units|restore-symlinks|restore-nginx|recover-nginx-switch|mark-manual-recovery>' >&2
    exit 64
    ;;
esac
