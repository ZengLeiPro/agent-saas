#!/usr/bin/env bash
set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${HOME:-}" ]; then
  echo "HOME is not set; cannot choose a user-writable npm global prefix" >&2
  exit 1
fi
NPM_GLOBAL_PREFIX="${NPM_GLOBAL_PREFIX:-${NPM_CONFIG_PREFIX:-$HOME/.npm-global}}"

mkdir -p "$NPM_GLOBAL_PREFIX"
export NPM_CONFIG_PREFIX="$NPM_GLOBAL_PREFIX"
export PATH="$NPM_GLOBAL_PREFIX/bin:$PATH"

echo "==> Installing @playwright/cli to user prefix: $NPM_GLOBAL_PREFIX"
npm install -g @playwright/cli@latest

echo ""
echo "==> Verifying installation..."
playwright-cli --version

echo ""
echo "==> Copying reference docs..."
REFS_SRC="$(npm root -g)/@playwright/cli/node_modules/playwright/lib/skill/references"
REFS_DST="$SKILL_DIR/references"
if [ -d "$REFS_SRC" ]; then
  rm -rf "$REFS_DST"
  cp -r "$REFS_SRC" "$REFS_DST"
  echo "Copied $(ls "$REFS_DST" | wc -l | tr -d ' ') reference files to $REFS_DST"
else
  echo "Warning: reference docs not found at $REFS_SRC"
fi

echo ""
echo "==> Setup complete!"
echo ""
echo "Quick test (CDP mode):"
echo "  curl -sf -X POST http://localhost:3000/internal/browser/ensure -H 'Content-Type: application/json' -d '{\"username\":\"test\"}'"
echo "  playwright-cli -s=test-abc123 open https://example.com"
echo "  playwright-cli -s=test-abc123 snapshot"
echo "  playwright-cli -s=test-abc123 close"
echo "  curl -sf -X POST http://localhost:3000/internal/browser/stop -H 'Content-Type: application/json' -d '{\"username\":\"test\"}'"
