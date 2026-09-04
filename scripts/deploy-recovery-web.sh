#!/usr/bin/env bash
set -Eeuo pipefail

: "${RECOVERY_WEB_ROOT:?Missing RECOVERY_WEB_ROOT}"
: "${RELEASE_ID:?Missing RELEASE_ID}"
: "${RUN_ID:?Missing RUN_ID}"
: "${ARCHIVE:?Missing ARCHIVE}"
: "${RECOVERY_WEB_BEFORE_TARGET:?Missing RECOVERY_WEB_BEFORE_TARGET}"
printf '%s' "$RUN_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo "invalid RUN_ID" >&2; exit 1; }
printf '%s' "$RELEASE_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo "invalid RELEASE_ID" >&2; exit 1; }

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
receipt_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$RECEIPT_PATH" | tail -n 1
}
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

if [ -s "$RECEIPT_PATH" ]; then
  STATE="$(receipt_value state)"
  CURRENT_BEFORE="$(receipt_value current_before)"
  PREVIOUS_BEFORE="$(receipt_value previous_before)"
  RECEIPT_TARGET="$(receipt_value target)"
  case "$STATE" in
    not_started|rolled_back)
      echo "recovery Web activation transaction is already terminal: $STATE" >&2
      exit 1
      ;;
    attempted|activated) ;;
    *) echo "invalid activation receipt state" >&2; exit 1 ;;
  esac
  if [ "$RECEIPT_TARGET" != "$RELEASE_DIR" ]; then
    echo "activation receipt target disagrees with this deployment" >&2
    exit 1
  fi
  if [ "$CURRENT_BEFORE" != "$RECOVERY_WEB_BEFORE_TARGET" ]; then
    echo "activation receipt disagrees with the runner snapshot" >&2
    exit 1
  fi
  validate_release "$CURRENT_BEFORE" "receipt recovery Web before target"
  validate_release "$RELEASE_DIR" "receipt recovery Web target"
  if [ -n "$PREVIOUS_BEFORE" ]; then
    case "$PREVIOUS_BEFORE" in
      "$RELEASES_DIR"/*) ;;
      *) echo "receipt previous target is outside releases root" >&2; exit 1 ;;
    esac
  fi
  CURRENT_NOW="$(readlink -f "$CURRENT_LINK")"
  if [ "$STATE" = activated ]; then
    if [ "$CURRENT_NOW" != "$RELEASE_DIR" ]; then
      echo "activated recovery Web receipt disagrees with current target" >&2
      exit 1
    fi
    echo "recovery Web already active for transaction: $RUN_ID"
    exit 0
  fi
  [ "$CURRENT_NOW" = "$CURRENT_BEFORE" ] || [ "$CURRENT_NOW" = "$RELEASE_DIR" ] || {
    echo "attempted recovery Web transaction disagrees with current target" >&2
    exit 1
  }
else
  if [ ! -L "$CURRENT_LINK" ]; then
    echo "recovery Web current path must be a symlink" >&2
    exit 1
  fi
  CURRENT_BEFORE="$(readlink -f "$CURRENT_LINK")"
  if [ "$CURRENT_BEFORE" != "$RECOVERY_WEB_BEFORE_TARGET" ]; then
    echo "recovery Web current target drifted from the runner snapshot" >&2
    exit 1
  fi
  validate_release "$CURRENT_BEFORE" "recovery Web before target"

  PREVIOUS_BEFORE=""
  if [ -L "$PREVIOUS_LINK" ]; then
    PREVIOUS_BEFORE="$(readlink -f "$PREVIOUS_LINK")"
    case "$PREVIOUS_BEFORE" in
      "$RELEASES_DIR"/*) ;;
      *) echo "recovery Web previous target is outside releases root" >&2; exit 1 ;;
    esac
  elif [ -e "$PREVIOUS_LINK" ]; then
    echo "recovery Web previous path must be a symlink" >&2
    exit 1
  fi

  if [ ! -d "$RELEASE_DIR" ]; then
    if [ -e "$STAGING_DIR" ]; then
      echo "stale recovery staging directory requires manual inspection: $STAGING_DIR"
      exit 1
    fi
    mkdir "$STAGING_DIR"
    tar -xzf "$ARCHIVE" -C "$STAGING_DIR"
    validate_release "$STAGING_DIR" "staged recovery Web target"
    mv "$STAGING_DIR" "$RELEASE_DIR"
  fi
  validate_release "$RELEASE_DIR" "recovery Web target"

  mv "$ARCHIVE" "$ARCHIVE_TARGET"
  write_receipt attempted
fi

# 与 OSS 的只增不删语义一致：旧页面在 DNS 回切后仍能懒加载旧 hash chunk，
# 旧 Service Worker 也仍能加载它对应的 Workbox runtime。同名 hash 文件必须逐字节相同，
# 否则在任何复制或 symlink mutation 前失败，不能让 cp -n 静默吸收冲突。
verify_immutable_shared_file() {
  local source="$1"
  local target="$2"
  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ ! -f "$target" ] || [ -L "$target" ] || ! cmp -s "$source" "$target"; then
      echo "immutable recovery Web asset conflicts with existing shared byte: $target" >&2
      exit 1
    fi
  fi
}
if [ -d "$RELEASE_DIR/assets" ]; then
  if find "$RELEASE_DIR/assets" -type l -print -quit | grep -q .; then
    echo "recovery Web assets must not contain symlinks" >&2
    exit 1
  fi
  while IFS= read -r -d '' asset_file; do
    relative_asset="${asset_file#"$RELEASE_DIR/assets/"}"
    verify_immutable_shared_file "$asset_file" "$SHARED_ROOT/assets/$relative_asset"
  done < <(find "$RELEASE_DIR/assets" -type f -print0)
fi
for workbox_file in "$RELEASE_DIR"/workbox-*.js; do
  [ -e "$workbox_file" ] || continue
  if [ ! -f "$workbox_file" ] || [ -L "$workbox_file" ]; then
    echo "recovery Web Workbox runtime must be a regular file: $workbox_file" >&2
    exit 1
  fi
  verify_immutable_shared_file "$workbox_file" "$SHARED_ROOT/$(basename "$workbox_file")"
done

if [ -d "$RELEASE_DIR/assets" ]; then
  cp -a -n "$RELEASE_DIR/assets/." "$SHARED_ROOT/assets/"
fi
for workbox_file in "$RELEASE_DIR"/workbox-*.js; do
  [ -e "$workbox_file" ] || continue
  cp -a -n "$workbox_file" "$SHARED_ROOT/"
done

if [ "$CURRENT_BEFORE" != "$RELEASE_DIR" ]; then
  ln -sfn "$CURRENT_BEFORE" "$PREVIOUS_LINK"
fi
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
test "$(readlink -f "$CURRENT_LINK")" = "$RELEASE_DIR"
write_receipt activated
echo "recovery Web active: $RELEASE_ID"
