#!/usr/bin/env bash
# Production 部署 rollback 桥接、流量翻回与早期恢复。候选 release 解包后由远端部署脚本 source。

production_deploy_restore_file() {
  local target="$1" backup="$2" had_original="$3"
  if [ "$had_original" -eq 1 ]; then
    cp "$backup" "$target"
  else
    rm -f "$target"
  fi
}

production_deploy_rollback() {
  local reason="${1:-deploy failure}"
  local rollback_errors=0
  local nginx_restored=1
  local web_restored=1
  local worker_restored=1
  local control_state_restored=1
  local candidate_web_stopped=1
  local candidate_worker_stopped=1
  local candidate_units_stopped=1
  local runtime_run_dir="${RUNTIME_RUN_DIR:-/run}"
  local _

  if [ "${ROLLBACK_DONE:-0}" -eq 1 ]; then
    log "rollback already completed; reason=$reason"
    return 0
  fi
  if [ "${ROLLBACK_RUNNING:-0}" -eq 1 ]; then
    log "WARN: recursive rollback suppressed; reason=$reason"
    return 0
  fi
  # 最新生产状态机加载后优先委托给它，保留 execution-fencing 与 authority
  # reclaim 语义；仅在首次 symlink 修改到内联函数定义之间使用通用早期恢复。
  if [ "${TRAFFIC_SWITCHED:-0}" -eq 0 ] \
    && declare -F rollback_idle_and_exit >/dev/null 2>&1; then
    ROLLBACK_ARMED=0
    rollback_idle_and_exit
    return $?
  fi
  ROLLBACK_RUNNING=1
  log "rollback start: reason=$reason traffic_switched=${TRAFFIC_SWITCHED:-0} nginx_written=${NGINX_CONFIG_WRITTEN:-0}"

  # 旧 Web 已进入 drain 时，先在候选仍承接流量期间恢复旧实例并等待 ready；
  # 只有旧实例可服务后才允许把 nginx 翻回去并停止候选。
  if [ -n "${ACTIVE:-}" ] && [ -n "${SERVICE_NAME:-}" ]; then
    if [ "${WEB_ACTIVE_DRAIN_STARTED:-0}" -eq 1 ] \
      || ! systemctl is-active --quiet "${SERVICE_NAME}@${ACTIVE}"; then
      rm -f "$runtime_run_dir/${SERVICE_NAME}-${ACTIVE}.pid" \
        "$runtime_run_dir/${SERVICE_NAME}-${ACTIVE}.draining" \
        || { log "ERROR: failed to clear old Web drain state"; web_restored=0; rollback_errors=1; }
      systemctl reset-failed "${SERVICE_NAME}@${ACTIVE}" >/dev/null 2>&1 || true
      systemctl enable "${SERVICE_NAME}@${ACTIVE}" \
        || { log "ERROR: failed to restore old Web unit ownership"; web_restored=0; rollback_errors=1; }
      systemctl restart "${SERVICE_NAME}@${ACTIVE}" \
        || { log "ERROR: failed to restart old Web unit"; web_restored=0; rollback_errors=1; }
      if [ "$web_restored" -eq 1 ]; then
        local web_ready=0 web_ready_timeout="${ROLLBACK_WEB_READY_TIMEOUT_SECONDS:-180}"
        for _ in $(seq 1 "$web_ready_timeout"); do
          if curl -fsS -m 5 "http://127.0.0.1:${ACTIVE_PORT}/api/healthz/ready" >/dev/null 2>&1; then
            web_ready=1
            break
          fi
          sleep 1
        done
        if [ "$web_ready" -ne 1 ]; then
          log "ERROR: old Web failed readiness during rollback"
          web_restored=0
          rollback_errors=1
        else
          log "old Web restored before nginx traffic rollback: color=$ACTIVE"
        fi
      fi
    else
      systemctl enable "${SERVICE_NAME}@${ACTIVE}" \
        || { log "ERROR: failed to preserve old Web unit ownership"; web_restored=0; rollback_errors=1; }
    fi
  fi

  # 任一受管 nginx 文件写入后都恢复双配置；reload 本身失败也必须验证并重载旧配置。
  if [ "${NGINX_CONFIG_WRITTEN:-0}" -eq 1 ] && [ "$web_restored" -eq 1 ]; then
    production_deploy_restore_file "$UPSTREAM_CONF" "$UPSTREAM_BAK" "${UPSTREAM_HAD_ORIGINAL:-0}" \
      || { log "ERROR: failed to restore nginx upstream"; nginx_restored=0; rollback_errors=1; }
    production_deploy_restore_file "$API_SITE_CONF" "$API_SITE_BAK" "${API_SITE_HAD_ORIGINAL:-0}" \
      || { log "ERROR: failed to restore nginx API site"; nginx_restored=0; rollback_errors=1; }
    if [ "$nginx_restored" -eq 1 ]; then
      if nginx -t && systemctl reload nginx; then
        log "nginx traffic restored to $ACTIVE"
      else
        log "ERROR: restored nginx configuration could not be validated/reloaded"
        nginx_restored=0
        rollback_errors=1
      fi
    fi
  elif [ "${NGINX_CONFIG_WRITTEN:-0}" -eq 1 ]; then
    nginx_restored=0
    rollback_errors=1
    log "WARN: old Web is not ready; preserving candidate nginx traffic"
  fi

  # 仅在旧 Web 与 nginx 流量均已恢复后原子回退持久控制面状态。
  if [ "$web_restored" -eq 1 ] && [ "$nginx_restored" -eq 1 ]; then
    if [ -n "${ACTIVE:-}" ] && [ -n "${ACTIVE_COLOR_FILE:-}" ]; then
      if declare -F write_color_marker >/dev/null 2>&1; then
        write_color_marker "$ACTIVE_COLOR_FILE" "$ACTIVE" \
          || { log "ERROR: failed to restore active-color marker"; control_state_restored=0; rollback_errors=1; }
      else
        printf '%s\n' "$ACTIVE" > "$ACTIVE_COLOR_FILE" \
          || { log "ERROR: failed to restore active-color marker"; control_state_restored=0; rollback_errors=1; }
      fi
    fi
    if [ -n "${RUNTIME_IDENTITY_BAK:-}" ] && [ -f "$RUNTIME_IDENTITY_BAK" ]; then
      cp "$RUNTIME_IDENTITY_BAK" "$RUNTIME_IDENTITY_FILE" \
        || { log "ERROR: failed to restore runtime identity"; control_state_restored=0; rollback_errors=1; }
    fi
  fi
  # 切流后先恢复旧 Web/nginx/控制面，再把物理运行态交给最新内联状态机；
  # 它保留 execution-fencing、legacy pre-drain 与 bootstrap authority reclaim 语义。
  if [ "${TRAFFIC_SWITCHED:-0}" -eq 1 ] && [ "$web_restored" -eq 1 ] \
    && [ "$nginx_restored" -eq 1 ] && [ "$control_state_restored" -eq 1 ] \
    && declare -F rollback_idle_and_exit >/dev/null 2>&1; then
    TRAFFIC_SWITCHED=0
    NGINX_CONFIG_WRITTEN=0
    ROLLBACK_ARMED=0
    rollback_idle_and_exit
    return $?
  fi

  # 早期通用路径没有内联状态机时，恢复旧 marker/guard/unit 后再停止候选。
  if { [ "${WORKER_ACTIVE_DRAIN_STARTED:-0}" -eq 1 ] || [ "${WORKER_PREACTIVATED:-0}" -eq 1 ]; } \
    && [ -n "${WORKER_ACTIVE:-}" ]; then
    printf '%s\n' "$WORKER_ACTIVE" > "$WORKER_ACTIVE_COLOR_FILE" \
      || { log "ERROR: failed to restore runtime Worker marker"; worker_restored=0; rollback_errors=1; }
    rm -f "$runtime_run_dir/agent-saas-runtime-worker-${WORKER_ACTIVE}.pid" \
      "$runtime_run_dir/agent-saas-runtime-worker-${WORKER_ACTIVE}.ready" \
      "$runtime_run_dir/agent-saas-runtime-worker-${WORKER_ACTIVE}.draining" \
      || { log "ERROR: failed to clear old runtime Worker guard"; worker_restored=0; rollback_errors=1; }
    systemctl reset-failed "${WORKER_SERVICE}@${WORKER_ACTIVE}" >/dev/null 2>&1 || true
    systemctl enable "${WORKER_SERVICE}@${WORKER_ACTIVE}" \
      || { log "ERROR: failed to enable old runtime Worker"; worker_restored=0; rollback_errors=1; }
    systemctl restart "${WORKER_SERVICE}@${WORKER_ACTIVE}" \
      || { log "ERROR: failed to restart old runtime Worker"; worker_restored=0; rollback_errors=1; }
    if [ "$worker_restored" -eq 1 ]; then
      local worker_ready=0 worker_pid="" worker_ready_pid=""
      local worker_ready_timeout="${ROLLBACK_WORKER_READY_TIMEOUT_SECONDS:-180}"
      for _ in $(seq 1 "$worker_ready_timeout"); do
        worker_pid=$(cat "$runtime_run_dir/agent-saas-runtime-worker-${WORKER_ACTIVE}.pid" 2>/dev/null || true)
        worker_ready_pid=$(cat "$runtime_run_dir/agent-saas-runtime-worker-${WORKER_ACTIVE}.ready" 2>/dev/null || true)
        if systemctl is-active --quiet "${WORKER_SERVICE}@${WORKER_ACTIVE}" \
          && [ -n "$worker_pid" ] && [ "$worker_pid" = "$worker_ready_pid" ] \
          && kill -0 "$worker_pid" 2>/dev/null; then
          worker_ready=1
          break
        fi
        sleep 1
      done
      if [ "$worker_ready" -ne 1 ]; then
        log "ERROR: old runtime Worker failed readiness during rollback"
        worker_restored=0
        rollback_errors=1
      else
        log "previous runtime worker restored before candidate stop: color=$WORKER_ACTIVE"
      fi
    fi
  elif [ "${WORKER_PREACTIVATED:-0}" -eq 1 ] && [ -n "${WORKER_ACTIVE_COLOR_FILE:-}" ]; then
    rm -f "$WORKER_ACTIVE_COLOR_FILE" \
      || { log "ERROR: failed to remove bootstrap Worker marker"; worker_restored=0; rollback_errors=1; }
  fi

  if [ "$nginx_restored" -eq 1 ] && [ "$web_restored" -eq 1 ] \
    && [ "$control_state_restored" -eq 1 ]; then
    if [ -n "${IDLE:-}" ] && [ -n "${SERVICE_NAME:-}" ]; then
      systemctl disable --now "${SERVICE_NAME}@${IDLE}" \
        || { log "ERROR: failed to stop candidate Web unit"; candidate_web_stopped=0; rollback_errors=1; }
    fi
  else
    candidate_web_stopped=0
    log "WARN: preserving candidate Web because Web/nginx/control-state restoration is unverified"
  fi

  # Worker 控制面与 Web 流量独立：旧 Worker ready 后必须停止候选，避免 marker
  # 已回旧色但两色仍同时消费；Web/nginx 恢复失败只保留候选 Web。
  if [ "${WORKER_CANDIDATE_STARTED:-0}" -eq 1 ] && [ -n "${WORKER_IDLE:-}" ]; then
    if [ "$worker_restored" -eq 1 ]; then
      systemctl disable --now "${WORKER_SERVICE}@${WORKER_IDLE}" \
        || { log "ERROR: failed to stop runtime Worker candidate"; candidate_worker_stopped=0; rollback_errors=1; }
    else
      candidate_worker_stopped=0
      log "WARN: preserving runtime Worker candidate because old Worker recovery failed"
    fi
  fi

  restore_release_env() {
    local target="$1" backup="$2" existed="$3"
    if [ -z "$target" ]; then return 0; fi
    if [ "$existed" -eq 1 ]; then
      cp -a "$backup" "$target"
    else
      rm -f "$target"
    fi
  }
  if [ "$candidate_web_stopped" -eq 1 ]; then
    restore_release_env "${API_RELEASE_ENV:-}" "${PREV_API_RELEASE_ENV:-}" "${API_RELEASE_ENV_EXISTED:-0}" \
      || { log "ERROR: failed to restore Web release env"; rollback_errors=1; }
  fi
  if [ "$candidate_worker_stopped" -eq 1 ]; then
    restore_release_env "${WORKER_RELEASE_ENV:-}" "${PREV_WORKER_RELEASE_ENV:-}" "${WORKER_RELEASE_ENV_EXISTED:-0}" \
      || { log "ERROR: failed to restore Worker release env"; rollback_errors=1; }
  fi

  if [ "$candidate_worker_stopped" -eq 1 ] \
    && [ "${WORKER_CANDIDATE_STARTED:-0}" -eq 1 ] && [ -n "${WORKER_IDLE:-}" ] \
    && [ "$worker_restored" -eq 1 ]; then
    if [ -n "${PREV_WORKER_IDLE_TARGET:-}" ]; then
      ln -sfn "$PREV_WORKER_IDLE_TARGET" "$WORKER_DIR/$WORKER_IDLE" \
        || { log "ERROR: failed to restore Worker symlink"; rollback_errors=1; }
    else
      rm -f "$WORKER_DIR/$WORKER_IDLE" \
        || { log "ERROR: failed to remove Worker candidate symlink"; rollback_errors=1; }
    fi
  fi

  if [ "$candidate_web_stopped" -eq 1 ]; then
    if [ -n "${PREV_CURRENT:-}" ]; then
      ln -sfn "$PREV_CURRENT" "$APP_LINK" || rollback_errors=1
    else
      rm -f "$APP_LINK" || rollback_errors=1
    fi
    if [ "${PREVIOUS_UPDATED:-0}" -eq 1 ]; then
      if [ -n "${PREV_PREVIOUS:-}" ]; then
        ln -sfn "$PREV_PREVIOUS" "$PREV_LINK" || rollback_errors=1
      else
        rm -f "$PREV_LINK" || rollback_errors=1
      fi
    fi
    if [ -n "${PREV_IDLE_TARGET:-}" ]; then
      ln -sfn "$PREV_IDLE_TARGET" "$COLOR_DIR/$IDLE" || rollback_errors=1
    elif [ -n "${IDLE:-}" ]; then
      rm -f "$COLOR_DIR/$IDLE" || rollback_errors=1
    fi
  fi
  if [ "$candidate_web_stopped" -ne 1 ] || [ "$candidate_worker_stopped" -ne 1 ]; then
    candidate_units_stopped=0
  fi

  # symlink 与 release env 都恢复后，才允许清理候选 release。
  if [ "$rollback_errors" -eq 0 ] && [ "$candidate_units_stopped" -eq 1 ] \
    && [ "${RELEASE_CREATED_BY_DEPLOY:-0}" -eq 1 ]; then
    case "${RELEASE_DIR:-}" in
      "$RELEASES_DIR"/*) rm -rf -- "$RELEASE_DIR" || rollback_errors=1 ;;
    esac
  else
    log "WARN: preserving failed release and candidate links for recovery: ${RELEASE_DIR:-unknown}"
  fi
  rm -f -- "${RELEASE_TGZ:-}" || rollback_errors=1

  ROLLBACK_RUNNING=0
  if [ "$rollback_errors" -eq 0 ]; then
    ROLLBACK_DONE=1
    ROLLBACK_ARMED=0
    TRAFFIC_SWITCHED=0
    log "rollback completed: active=$ACTIVE"
    return 0
  fi
  log "ERROR: rollback completed with recovery errors"
  return 1
}
