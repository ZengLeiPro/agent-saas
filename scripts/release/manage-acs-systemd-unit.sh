#!/usr/bin/env bash

validate_acs_managed_unit() {
  local source="$1" node_executable="$2" service_name="$3"
  [ "$node_executable" = /usr/bin/node ] || {
    echo "ACS managed unit requires /usr/bin/node, got $node_executable" >&2
    return 1
  }
  [ "$service_name" = agent-saas-acs-orchestrator.service ] || {
    echo "Unexpected ACS service name: $service_name" >&2
    return 1
  }
  [ -f "$source" ] && [ ! -L "$source" ] || {
    echo "ACS managed unit source must be a regular file: $source" >&2
    return 1
  }
  [ "$(grep -c '^ExecStartPre=' "$source")" -eq 1 ] \
    && grep -Fxq 'ExecStartPre=/usr/bin/node dist/runtime-dependency.mjs --manifest=runtime-dependencies.json --component=acsOrchestrator --production=true' "$source" \
    || {
      echo 'ACS managed unit must run the Runtime guard with /usr/bin/node' >&2
      return 1
    }
  [ "$(grep -c '^ExecStart=' "$source")" -eq 1 ] \
    && grep -Fxq 'ExecStart=/usr/bin/node --enable-source-maps dist/index.js' "$source" \
    || {
      echo 'ACS managed unit must start the orchestrator with /usr/bin/node' >&2
      return 1
    }
}

install_acs_managed_unit() {
  local source="$1" target="$2" systemctl_bin="$3"
  [ -x "$systemctl_bin" ] || {
    echo "systemctl executable is unavailable: $systemctl_bin" >&2
    return 1
  }
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    echo "ACS managed unit target must be absent or a regular file: $target" >&2
    return 1
  fi
  install -m 0644 "$source" "$target.candidate"
  mv "$target.candidate" "$target"
  "$systemctl_bin" daemon-reload
}

restore_acs_managed_unit() {
  local target="$1" backup="$2" had_previous="$3" systemctl_bin="$4"
  case "$had_previous" in
    true)
      [ -f "$backup" ] && [ ! -L "$backup" ] || {
        echo "ACS managed unit backup is unavailable: $backup" >&2
        return 1
      }
      install -m 0644 "$backup" "$target.rollback"
      mv "$target.rollback" "$target"
      ;;
    false)
      rm -f "$target"
      ;;
    *)
      echo "Invalid ACS managed unit rollback state: $had_previous" >&2
      return 1
      ;;
  esac
  "$systemctl_bin" daemon-reload
}
