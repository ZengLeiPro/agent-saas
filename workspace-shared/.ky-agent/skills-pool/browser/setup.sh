#!/usr/bin/env bash
set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Browser skill setup is a legacy maintenance helper."
echo "ACS Sandbox runtime should already provide playwright-cli."
echo "This script no longer installs global npm packages or rewrites references/."

echo ""
echo "==> Verifying runtime..."
if ! command -v playwright-cli >/dev/null 2>&1; then
  echo "ERROR: playwright-cli not found. Fix the ACS image or platform runtime; do not install globally during a task." >&2
  exit 1
fi
playwright-cli --version

echo ""
echo "==> Setup complete!"
echo ""
echo "Quick test (CDP mode):"
echo "  curl -sf -X POST http://localhost:3000/internal/browser/ensure -H 'Content-Type: application/json' -d '{\"username\":\"test\"}'"
echo "  playwright-cli -s=test-abc123 open https://example.com"
echo "  playwright-cli -s=test-abc123 snapshot"
echo "  playwright-cli -s=test-abc123 close"
echo "  curl -sf -X POST http://localhost:3000/internal/browser/stop -H 'Content-Type: application/json' -d '{\"username\":\"test\"}'"
