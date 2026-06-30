#!/usr/bin/env bash
# C5 daemon packaging baseline.
#
# Installs the Kaiyan agent client daemon as a long-running OS service:
#   macOS  → launchctl + ~/Library/LaunchAgents (user-level)
#   Linux  → systemd unit + EnvironmentFile
#
# Required env vars (or flags):
#   CLIENT_DAEMON_URL              wss://server/daemon
#   CLIENT_DAEMON_ID               stable device id (matches registry)
#   CLIENT_DAEMON_AUTH_TOKEN       per-device bearer issued by ops
#   CLIENT_DAEMON_WORKSPACE_ROOT   local sandbox path
#
# Optional:
#   AGENT_DAEMON_REPO_ROOT         repo checkout path (default: this repo)
#   DAEMON_USER                    Linux systemd User= (default: $USER)
#
# Usage:
#   sudo ./install.sh                  # Linux systemd
#   ./install.sh                       # macOS launchd (per user, no sudo)
#   ./install.sh --uninstall           # remove
#
set -euo pipefail

UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      sed -n '/^# C5/,/^set -euo/p' "$0" | sed -n '/^# /p'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="${AGENT_DAEMON_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DAEMON_USER="${DAEMON_USER:-$(id -un)}"
PKG_DIR="$REPO_ROOT/daemon-packaging"

OS_NAME=$(uname -s)

require_env() {
  local var="$1"
  if [ -z "${!var:-}" ]; then
    echo "missing env $var" >&2
    exit 1
  fi
}

substitute() {
  local infile="$1"
  local outfile="$2"
  sed \
    -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
    -e "s|__CLIENT_DAEMON_URL__|${CLIENT_DAEMON_URL:-}|g" \
    -e "s|__CLIENT_DAEMON_ID__|${CLIENT_DAEMON_ID:-}|g" \
    -e "s|__CLIENT_DAEMON_AUTH_TOKEN__|${CLIENT_DAEMON_AUTH_TOKEN:-}|g" \
    -e "s|__CLIENT_DAEMON_WORKSPACE_ROOT__|${CLIENT_DAEMON_WORKSPACE_ROOT:-}|g" \
    -e "s|__DAEMON_USER__|${DAEMON_USER}|g" \
    "$infile" > "$outfile"
}

install_launchd() {
  local plist_target="$HOME/Library/LaunchAgents/com.kaiyan.agent-daemon.plist"
  if [ "$UNINSTALL" = "1" ]; then
    launchctl bootout gui/$(id -u)/com.kaiyan.agent-daemon 2>/dev/null || true
    rm -f "$plist_target"
    echo "removed $plist_target"
    return
  fi
  require_env CLIENT_DAEMON_URL
  require_env CLIENT_DAEMON_ID
  require_env CLIENT_DAEMON_AUTH_TOKEN
  require_env CLIENT_DAEMON_WORKSPACE_ROOT
  mkdir -p "$REPO_ROOT/logs"
  mkdir -p "$(dirname "$plist_target")"
  substitute "$PKG_DIR/launchd/com.kaiyan.agent-daemon.plist.template" "$plist_target"
  chmod 600 "$plist_target"
  launchctl bootout gui/$(id -u)/com.kaiyan.agent-daemon 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) "$plist_target"
  echo "installed launchd agent at $plist_target"
  echo "logs: $REPO_ROOT/logs/agent-daemon.{log,err.log}"
}

install_systemd() {
  local unit_target="/etc/systemd/system/agent-daemon.service"
  local env_target="/etc/agent-daemon/env"
  if [ "$UNINSTALL" = "1" ]; then
    systemctl stop agent-daemon || true
    systemctl disable agent-daemon || true
    rm -f "$unit_target"
    rm -rf "$(dirname "$env_target")"
    systemctl daemon-reload
    echo "removed $unit_target and $env_target"
    return
  fi
  require_env CLIENT_DAEMON_URL
  require_env CLIENT_DAEMON_ID
  require_env CLIENT_DAEMON_AUTH_TOKEN
  require_env CLIENT_DAEMON_WORKSPACE_ROOT
  install -d -m 0750 -o "$DAEMON_USER" -g "$DAEMON_USER" "$(dirname "$env_target")"
  cat > "$env_target" <<EOF
CLIENT_DAEMON_URL=$CLIENT_DAEMON_URL
CLIENT_DAEMON_ID=$CLIENT_DAEMON_ID
CLIENT_DAEMON_AUTH_TOKEN=$CLIENT_DAEMON_AUTH_TOKEN
CLIENT_DAEMON_WORKSPACE_ROOT=$CLIENT_DAEMON_WORKSPACE_ROOT
EOF
  chmod 600 "$env_target"
  chown "$DAEMON_USER:$DAEMON_USER" "$env_target"
  substitute "$PKG_DIR/systemd/agent-daemon.service.template" "$unit_target"
  chmod 644 "$unit_target"
  systemctl daemon-reload
  systemctl enable --now agent-daemon
  echo "installed systemd unit at $unit_target"
  echo "env: $env_target"
  echo "logs: journalctl -u agent-daemon -f"
}

case "$OS_NAME" in
  Darwin) install_launchd ;;
  Linux)  install_systemd ;;
  *) echo "unsupported OS: $OS_NAME" >&2; exit 1 ;;
esac
