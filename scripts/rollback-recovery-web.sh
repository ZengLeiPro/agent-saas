#!/usr/bin/env bash
set -Eeuo pipefail

: "${RECOVERY_WEB_ROOT:?Missing RECOVERY_WEB_ROOT}"
: "${RUN_ID:?Missing RUN_ID}"
printf '%s' "$RUN_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo "invalid RUN_ID" >&2; exit 1; }

RECEIPT_PATH="$RECOVERY_WEB_ROOT/transactions/$RUN_ID.activation"
LOCK_PATH="$RECOVERY_WEB_ROOT/.transaction.lock"
mkdir -p "$(dirname "$RECEIPT_PATH")"
exec 9>"$LOCK_PATH"
flock 9
if [ ! -s "$RECEIPT_PATH" ]; then
  : "${RECOVERY_WEB_BEFORE_TARGET:?Missing RECOVERY_WEB_BEFORE_TARGET for an unstarted activation}"
  case "$RECOVERY_WEB_BEFORE_TARGET" in
    "$RECOVERY_WEB_ROOT"/releases/*) ;;
    *) echo "runner recovery Web snapshot is outside releases root" >&2; exit 1 ;;
  esac
  test "$(readlink -f "$RECOVERY_WEB_ROOT/current")" = "$RECOVERY_WEB_BEFORE_TARGET"
  {
    printf 'state=not_started\n'
    printf 'current_before=%s\n' "$RECOVERY_WEB_BEFORE_TARGET"
    printf 'previous_before=\n'
    printf 'target=\n'
  } >"$RECEIPT_PATH.candidate"
  mv "$RECEIPT_PATH.candidate" "$RECEIPT_PATH"
  echo "recovery Web activation receipt is absent and current still equals transaction before"
  exit 0
fi
receipt_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$RECEIPT_PATH" | tail -n 1
}
STATE="$(receipt_value state)"
CURRENT_BEFORE="$(receipt_value current_before)"
PREVIOUS_BEFORE="$(receipt_value previous_before)"
TARGET="$(receipt_value target)"
case "$STATE" in attempted|activated) ;; *) echo "invalid activation receipt state" >&2; exit 1 ;; esac
case "$CURRENT_BEFORE" in
  "$RECOVERY_WEB_ROOT"/releases/*) ;;
  *) echo "previous recovery Web target is outside releases root" >&2; exit 1 ;;
esac
if [ ! -s "$CURRENT_BEFORE/index.html" ]; then
  echo "previous recovery Web is unavailable; manual recovery required" >&2
  exit 1
fi
if [ -n "${RECOVERY_WEB_BEFORE_TARGET:-}" ] && [ "$RECOVERY_WEB_BEFORE_TARGET" != "$CURRENT_BEFORE" ]; then
  echo "activation receipt disagrees with the runner snapshot" >&2
  exit 1
fi
CURRENT_NOW="$(readlink -f "$RECOVERY_WEB_ROOT/current")"
case "$STATE" in
  attempted)
    [ "$CURRENT_NOW" = "$CURRENT_BEFORE" ] || [ "$CURRENT_NOW" = "$TARGET" ] || {
      echo "recovery Web current target drifted outside this transaction" >&2
      exit 1
    }
    ;;
  activated)
    [ "$CURRENT_NOW" = "$TARGET" ] || {
      echo "activated recovery Web receipt disagrees with current target" >&2
      exit 1
    }
    ;;
esac
ln -sfn "$CURRENT_BEFORE" "$RECOVERY_WEB_ROOT/current"
if [ -n "$PREVIOUS_BEFORE" ]; then
  case "$PREVIOUS_BEFORE" in
    "$RECOVERY_WEB_ROOT"/releases/*) ;;
    *) echo "receipt previous target is outside releases root" >&2; exit 1 ;;
  esac
  ln -sfn "$PREVIOUS_BEFORE" "$RECOVERY_WEB_ROOT/previous"
else
  rm -f "$RECOVERY_WEB_ROOT/previous"
fi
test "$(readlink -f "$RECOVERY_WEB_ROOT/current")" = "$CURRENT_BEFORE"
if [ -n "$PREVIOUS_BEFORE" ]; then
  test "$(readlink -f "$RECOVERY_WEB_ROOT/previous")" = "$PREVIOUS_BEFORE"
else
  test ! -e "$RECOVERY_WEB_ROOT/previous" && test ! -L "$RECOVERY_WEB_ROOT/previous"
fi
{
  printf 'state=rolled_back\n'
  printf 'current_before=%s\n' "$CURRENT_BEFORE"
  printf 'previous_before=%s\n' "$PREVIOUS_BEFORE"
  printf 'target=%s\n' "$TARGET"
} >"$RECEIPT_PATH.candidate"
mv "$RECEIPT_PATH.candidate" "$RECEIPT_PATH"
echo "previous recovery Web restored: $CURRENT_BEFORE"
