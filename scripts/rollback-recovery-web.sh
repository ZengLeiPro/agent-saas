#!/usr/bin/env bash
set -Eeuo pipefail

: "${RECOVERY_WEB_ROOT:?Missing RECOVERY_WEB_ROOT}"

PREVIOUS_TARGET="${RECOVERY_WEB_BEFORE_TARGET:-$(readlink -f "$RECOVERY_WEB_ROOT/previous" 2>/dev/null || true)}"
case "$PREVIOUS_TARGET" in
  "$RECOVERY_WEB_ROOT"/releases/*) ;;
  *) echo "previous recovery Web target is outside releases root" >&2; exit 1 ;;
esac
if [ -z "$PREVIOUS_TARGET" ] || [ ! -s "$PREVIOUS_TARGET/index.html" ]; then
  echo "previous recovery Web is unavailable; manual recovery required"
  exit 1
fi

ln -sfn "$PREVIOUS_TARGET" "$RECOVERY_WEB_ROOT/current"
echo "previous recovery Web restored: $PREVIOUS_TARGET"
