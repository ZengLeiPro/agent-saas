#!/usr/bin/env bash
set -Eeuo pipefail

: "${RECOVERY_WEB_ROOT:?Missing RECOVERY_WEB_ROOT}"
: "${RELEASE_ID:?Missing RELEASE_ID}"
: "${RUN_ID:?Missing RUN_ID}"
: "${ARCHIVE:?Missing ARCHIVE}"
printf '%s' "$RUN_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo "invalid RUN_ID" >&2; exit 1; }

RELEASES_DIR="$RECOVERY_WEB_ROOT/releases"
ARTIFACTS_DIR="$RECOVERY_WEB_ROOT/artifacts"
SHARED_ROOT="$RECOVERY_WEB_ROOT/shared-root"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
STAGING_DIR="$RELEASES_DIR/.${RELEASE_ID}.${RUN_ID}.staging"
ARCHIVE_TARGET="$ARTIFACTS_DIR/${RELEASE_ID}.${RUN_ID}.tgz"
CURRENT_LINK="$RECOVERY_WEB_ROOT/current"
PREVIOUS_LINK="$RECOVERY_WEB_ROOT/previous"
TRANSACTIONS_DIR="$RECOVERY_WEB_ROOT/transactions"
RECEIPT_PATH="$TRANSACTIONS_DIR/$RUN_ID.activation"
LOCK_PATH="$RECOVERY_WEB_ROOT/.transaction.lock"

mkdir -p "$RELEASES_DIR" "$ARTIFACTS_DIR" "$SHARED_ROOT/assets" "$TRANSACTIONS_DIR"
exec 9>"$LOCK_PATH"
flock 9
if [ ! -d "$RELEASE_DIR" ]; then
  if [ -e "$STAGING_DIR" ]; then
    echo "stale recovery staging directory requires manual inspection: $STAGING_DIR"
    exit 1
  fi
  mkdir "$STAGING_DIR"
  tar -xzf "$ARCHIVE" -C "$STAGING_DIR"
  test -s "$STAGING_DIR/index.html"
  test -s "$STAGING_DIR/sw.js"
  mv "$STAGING_DIR" "$RELEASE_DIR"
fi

test -s "$RELEASE_DIR/index.html"
test -s "$RELEASE_DIR/sw.js"

# 与 OSS 的只增不删语义一致：旧页面在 DNS 回切后仍能懒加载旧 hash chunk，
# 旧 Service Worker 也仍能加载它对应的 Workbox runtime。
if [ -d "$RELEASE_DIR/assets" ]; then
  cp -a -n "$RELEASE_DIR/assets/." "$SHARED_ROOT/assets/"
fi
for workbox_file in "$RELEASE_DIR"/workbox-*.js; do
  [ -e "$workbox_file" ] || continue
  cp -a -n "$workbox_file" "$SHARED_ROOT/"
done

mv "$ARCHIVE" "$ARCHIVE_TARGET"
CURRENT_BEFORE=""
PREVIOUS_BEFORE=""
if [ -L "$CURRENT_LINK" ]; then
  CURRENT_BEFORE="$(readlink -f "$CURRENT_LINK")"
elif [ -e "$CURRENT_LINK" ]; then
  echo "recovery Web current path must be a symlink" >&2
  exit 1
fi
if [ -L "$PREVIOUS_LINK" ]; then
  PREVIOUS_BEFORE="$(readlink -f "$PREVIOUS_LINK")"
elif [ -e "$PREVIOUS_LINK" ]; then
  echo "recovery Web previous path must be a symlink" >&2
  exit 1
fi
receipt_candidate="$RECEIPT_PATH.candidate"
write_receipt() {
  local state="$1"
  {
    printf 'state=%s\n' "$state"
    printf 'current_before=%s\n' "$CURRENT_BEFORE"
    printf 'previous_before=%s\n' "$PREVIOUS_BEFORE"
    printf 'target=%s\n' "$RELEASE_DIR"
  } >"$receipt_candidate"
  mv "$receipt_candidate" "$RECEIPT_PATH"
}
write_receipt attempted
if [ -n "$CURRENT_BEFORE" ] && [ "$CURRENT_BEFORE" != "$RELEASE_DIR" ]; then
  ln -sfn "$CURRENT_BEFORE" "$PREVIOUS_LINK"
fi
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
test "$(readlink -f "$CURRENT_LINK")" = "$RELEASE_DIR"
write_receipt activated
echo "recovery Web active: $RELEASE_ID"
