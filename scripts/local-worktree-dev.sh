#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETUP_ONLY=false
SOURCE_CONFIG=""

while (($#)); do
  case "$1" in
    --setup-only)
      SETUP_ONLY=true
      shift
      ;;
    --source-config)
      if (($# < 2)); then
        echo "--source-config 后必须提供文件路径" >&2
        exit 1
      fi
      SOURCE_CONFIG="$2"
      shift 2
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"
if ! node -e "require.resolve('bcrypt'); require.resolve('jsonc-parser')" >/dev/null 2>&1; then
  echo "正在安装当前 worktree 依赖..."
  pnpm install --frozen-lockfile
fi

if [[ -n "$SOURCE_CONFIG" ]]; then
  node scripts/local-worktree-bootstrap.mjs --source-config "$SOURCE_CONFIG"
else
  node scripts/local-worktree-bootstrap.mjs
fi

if [[ "$SETUP_ONLY" == true ]]; then
  exit 0
fi

exec env \
  NODE_ENV=development \
  AGENT_SAAS_CONFIG_PATH="$ROOT_DIR/config.json.local-worktree" \
  AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT=1 \
  pnpm dev
