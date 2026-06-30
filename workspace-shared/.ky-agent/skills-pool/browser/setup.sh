#!/usr/bin/env bash
set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Browser skill setup is a legacy maintenance helper."
echo "ACS Sandbox runtime should already provide Python Playwright and Chromium."
echo "This script no longer installs global npm packages or rewrites references/."

echo ""
echo "==> Verifying runtime..."
python3 - <<'PY'
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
    page = browser.new_page()
    page.set_content("<h1>ok</h1>")
    assert page.inner_text("body") == "ok"
    browser.close()
print("Python Playwright OK")
PY

echo ""
echo "==> Setup complete!"
echo ""
echo "Quick test:"
echo "  python3 \"$SKILL_DIR/scripts/acs_browser.py\" snapshot https://example.com --out assets/browser/example.txt"
