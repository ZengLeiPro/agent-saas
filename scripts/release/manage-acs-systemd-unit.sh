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
  [ -f "$source" ] && [ -r "$source" ] && [ ! -L "$source" ] || {
    echo "ACS managed unit source must be a readable regular file: $source" >&2
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
  [ "$(grep -c '^EnvironmentFile=' "$source")" -eq 1 ] \
    && grep -Fxq 'EnvironmentFile=/etc/agent-saas/acs-orchestrator.env' "$source" \
    && [ "$(grep -c '^Environment=' "$source")" -eq 5 ] \
    && grep -Fxq 'Environment=NODE_ENV=production' "$source" \
    && grep -Fxq 'Environment=ACS_ORCH_PORT=3400' "$source" \
    && grep -Fxq 'Environment=ACS_NAMESPACE=agent-saas-coding' "$source" \
    && grep -Fxq 'Environment=ACS_ORCH_RUNTIME_CONFIG_FILE=/var/lib/agent-saas/acs-orchestrator-runtime.json' "$source" \
    && grep -Fxq 'Environment=ACS_RELEASE_IDENTITY_FILE=/etc/agent-saas/acs-release-identity.json' "$source" \
    || {
      echo 'ACS managed unit must use only the managed EnvironmentFile and fixed Environment values' >&2
      return 1
    }
}

assert_no_acs_managed_unit_dropins() {
  local service_name="$1"
  shift
  local roots=("$@")
  if [ "${#roots[@]}" -eq 0 ]; then
    roots=(
      /etc/systemd/system
      /run/systemd/system
      /run/systemd/transient
      /run/systemd/generator.early
      /usr/local/lib/systemd/system
      /usr/lib/systemd/system
      /lib/systemd/system
      /run/systemd/generator
      /run/systemd/generator.late
    )
  fi
  # Mirror every systemd system unit load-path tier, including generated units.
  local stem="${service_name%.service}" root prefix dropin_dir
  local -a dropin_dirs entries
  for root in "${roots[@]}"; do
    dropin_dirs=("$root/service.d" "$root/$service_name.d")
    prefix="$stem"
    while [[ "$prefix" == *-* ]]; do
      prefix="${prefix%-*}"
      dropin_dirs+=("$root/${prefix}-.service.d")
    done
    for dropin_dir in "${dropin_dirs[@]}"; do
      [ -d "$dropin_dir" ] || continue
      shopt -s nullglob
      entries=("$dropin_dir"/*.conf)
      shopt -u nullglob
      if [ "${#entries[@]}" -ne 0 ]; then
        echo "Unmanaged systemd drop-in can override ACS Runtime environment: ${entries[0]}" >&2
        return 1
      fi
    done
  done
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
