#!/usr/bin/env bash
set -Eeuo pipefail

: "${RECOVERY_WEB_ROOT:?Missing RECOVERY_WEB_ROOT}"
: "${RELEASE_ID:?Missing RELEASE_ID}"
: "${RUN_ID:?Missing RUN_ID}"
: "${ARCHIVE:?Missing ARCHIVE}"

RELEASES_DIR="$RECOVERY_WEB_ROOT/releases"
ARTIFACTS_DIR="$RECOVERY_WEB_ROOT/artifacts"
SHARED_ROOT="$RECOVERY_WEB_ROOT/shared-root"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
STAGING_DIR="$RELEASES_DIR/.${RELEASE_ID}.${RUN_ID}.staging"
ARCHIVE_TARGET="$ARTIFACTS_DIR/${RELEASE_ID}.${RUN_ID}.tgz"
CURRENT_LINK="$RECOVERY_WEB_ROOT/current"
PREVIOUS_LINK="$RECOVERY_WEB_ROOT/previous"

mkdir -p "$RELEASES_DIR" "$ARTIFACTS_DIR" "$SHARED_ROOT/assets"
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
PREVIOUS_TARGET=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
if [ -n "$PREVIOUS_TARGET" ] && [ "$PREVIOUS_TARGET" != "$RELEASE_DIR" ]; then
  ln -sfn "$PREVIOUS_TARGET" "$PREVIOUS_LINK"
fi
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
echo "recovery Web active: $RELEASE_ID"
