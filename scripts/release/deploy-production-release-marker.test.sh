#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
deploy="$script_dir/deploy-production-release.sh"
bash -n "$deploy"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
marker_function="$(sed -n '/^mark_rollback_attempted() {/,/^}$/p' "$deploy")"
test -n "$marker_function"
eval "$marker_function"

# 证据落盘失败只能告警，不能让 set -e 提前终止后续真实恢复动作。
marker_failure_sentinel="$tmp/rollback-continued-after-marker-failure"
if (
  install() { return 1; }
  export -f install
  ROLLBACK_ATTEMPTED_MARKER="$tmp/unwritable/rollback-attempted-app"
  rollback_after_marker_failure() {
    mark_rollback_attempted
    : > "$marker_failure_sentinel"
  }
  trap rollback_after_marker_failure EXIT
  exit 96
); then
  echo 'marker failure injection unexpectedly succeeded' >&2
  exit 1
fi
test -f "$marker_failure_sentinel"

assert_cleanup_marks_first() {
  local phase="$1" body
  body="$(sed -n "/^  cleanup_${phase}_failure() {/,/^  }$/p" "$deploy")"
  test -n "$body"
  test "$(printf '%s\n' "$body" | grep -n 'mark_rollback_attempted' | cut -d: -f1)" -lt \
    "$(printf '%s\n' "$body" | grep -n -E 'ln -sfn|systemctl reset-failed' | head -n1 | cut -d: -f1)"
}

inject_failure() {
  local phase="$1" point="$2" attempt="$3"
  local remote="$tmp/agent-saas-promotion-318-$attempt"
  local marker="$remote/rollback-attempted-$phase"
  ROLLBACK_ATTEMPTED_MARKER="$marker"
  mkdir -p "$remote"
  rm -f "$marker"

  if [ "$point" = pre-trap ]; then
    if (exit 97); then
      echo "pre-trap fault unexpectedly succeeded for $phase" >&2
      exit 1
    fi
    test ! -e "$marker"
    return
  fi

  if (trap mark_rollback_attempted EXIT; exit 98); then
    echo "armed cleanup trap fault unexpectedly succeeded for $phase" >&2
    exit 1
  fi
  test -f "$marker"
  test "$(stat -c %a "$marker")" = 444
}

for phase in acs app; do
  assert_cleanup_marks_first "$phase"
  inject_failure "$phase" pre-trap 1
  inject_failure "$phase" armed-trap 1
done

# A marker from one run attempt cannot satisfy another attempt's evidence path.
inject_failure acs armed-trap 2
test -f "$tmp/agent-saas-promotion-318-2/rollback-attempted-acs"
test ! -e "$tmp/agent-saas-promotion-318-1/rollback-attempted-acs-from-attempt-2"

echo 'deploy rollback attempted marker and failure-isolation fault injection: ok'
