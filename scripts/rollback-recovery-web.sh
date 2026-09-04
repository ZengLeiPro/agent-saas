#!/usr/bin/env bash
set -Eeuo pipefail

: "${RECOVERY_WEB_ROOT:?Missing RECOVERY_WEB_ROOT}"
: "${RUN_ID:?Missing RUN_ID}"
printf '%s' "$RUN_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo "invalid RUN_ID" >&2; exit 1; }

RELEASES_DIR="$RECOVERY_WEB_ROOT/releases"
RECEIPT_PATH="$RECOVERY_WEB_ROOT/transactions/$RUN_ID.activation"
LOCK_PATH="$RECOVERY_WEB_ROOT/.transaction.lock"
mkdir -p "$(dirname "$RECEIPT_PATH")"
exec 9>"$LOCK_PATH"
flock 9

validate_release() {
  local release_dir="$1"
  local label="$2"
  case "$release_dir" in
    "$RELEASES_DIR"/*) ;;
    *) echo "$label is outside releases root" >&2; exit 1 ;;
  esac
  for entry in manifest.webmanifest release-identity.json index.html sw.js; do
    if [ ! -s "$release_dir/$entry" ]; then
      echo "$label is missing required entry: $entry" >&2
      exit 1
    fi
  done
}
verify_current_before() {
  test "$(readlink -f "$RECOVERY_WEB_ROOT/current")" = "$CURRENT_BEFORE"
}
verify_previous_before() {
  if [ -n "$PREVIOUS_BEFORE" ]; then
    test "$(readlink -f "$RECOVERY_WEB_ROOT/previous")" = "$PREVIOUS_BEFORE"
  else
    test ! -e "$RECOVERY_WEB_ROOT/previous" && test ! -L "$RECOVERY_WEB_ROOT/previous"
  fi
}
receipt_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$RECEIPT_PATH" | tail -n 1
}

if [ ! -s "$RECEIPT_PATH" ]; then
  : "${RECOVERY_WEB_BEFORE_TARGET:?Missing RECOVERY_WEB_BEFORE_TARGET for an unstarted activation}"
  CURRENT_BEFORE="$RECOVERY_WEB_BEFORE_TARGET"
  PREVIOUS_BEFORE=""
  validate_release "$CURRENT_BEFORE" "runner recovery Web snapshot"
  verify_current_before
  {
    printf 'state=not_started\n'
    printf 'current_before=%s\n' "$CURRENT_BEFORE"
    printf 'previous_before=\n'
    printf 'target=\n'
  } >"$RECEIPT_PATH.candidate"
  mv "$RECEIPT_PATH.candidate" "$RECEIPT_PATH"
  echo "recovery Web activation receipt is absent and current still equals transaction before"
  exit 0
fi

STATE="$(receipt_value state)"
CURRENT_BEFORE="$(receipt_value current_before)"
PREVIOUS_BEFORE="$(receipt_value previous_before)"
TARGET="$(receipt_value target)"
case "$STATE" in attempted|activated|not_started|rolled_back) ;; *) echo "invalid activation receipt state" >&2; exit 1 ;; esac
validate_release "$CURRENT_BEFORE" "receipt recovery Web before target"
if [ -n "${RECOVERY_WEB_BEFORE_TARGET:-}" ] && [ "$RECOVERY_WEB_BEFORE_TARGET" != "$CURRENT_BEFORE" ]; then
  echo "activation receipt disagrees with the runner snapshot" >&2
  exit 1
fi
if [ -n "$PREVIOUS_BEFORE" ]; then
  case "$PREVIOUS_BEFORE" in
    "$RELEASES_DIR"/*) ;;
    *) echo "receipt previous target is outside releases root" >&2; exit 1 ;;
  esac
fi

case "$STATE" in
  not_started)
    if [ -n "$TARGET" ] || [ -n "$PREVIOUS_BEFORE" ]; then
      echo "invalid not_started activation receipt" >&2
      exit 1
    fi
    verify_current_before
    echo "recovery Web activation was already proven not started: $RUN_ID"
    exit 0
    ;;
  rolled_back)
    validate_release "$TARGET" "rolled back recovery Web target"
    verify_current_before
    verify_previous_before
    echo "recovery Web transaction was already rolled back: $RUN_ID"
    exit 0
    ;;
  attempted|activated)
    validate_release "$TARGET" "receipt recovery Web target"
    ;;
esac

CURRENT_NOW="$(readlink -f "$RECOVERY_WEB_ROOT/current")"
case "$STATE" in
  attempted)
    [ "$CURRENT_NOW" = "$CURRENT_BEFORE" ] || [ "$CURRENT_NOW" = "$TARGET" ] || {
      echo "recovery Web current target drifted outside this transaction" >&2
      exit 1
    }
    ;;
  activated)
    [ "$CURRENT_NOW" = "$TARGET" ] || [ "$CURRENT_NOW" = "$CURRENT_BEFORE" ] || {
      echo "activated recovery Web receipt disagrees with current target" >&2
      exit 1
    }
    ;;
esac

ln -sfn "$CURRENT_BEFORE" "$RECOVERY_WEB_ROOT/current"
if [ -n "$PREVIOUS_BEFORE" ]; then
  ln -sfn "$PREVIOUS_BEFORE" "$RECOVERY_WEB_ROOT/previous"
else
  rm -f "$RECOVERY_WEB_ROOT/previous"
fi
verify_current_before
verify_previous_before
{
  printf 'state=rolled_back\n'
  printf 'current_before=%s\n' "$CURRENT_BEFORE"
  printf 'previous_before=%s\n' "$PREVIOUS_BEFORE"
  printf 'target=%s\n' "$TARGET"
} >"$RECEIPT_PATH.candidate"
mv "$RECEIPT_PATH.candidate" "$RECEIPT_PATH"
echo "previous recovery Web restored: $CURRENT_BEFORE"
