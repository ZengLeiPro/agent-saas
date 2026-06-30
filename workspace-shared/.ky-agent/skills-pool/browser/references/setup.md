# Setup

ACS Sandbox should already provide Python Playwright and Chromium.

Verify the runtime:

```bash
python3 - <<'PY'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
    page = browser.new_page()
    page.set_content("<h1>ok</h1>")
    print(page.inner_text("body"))
    browser.close()
PY
```

If this fails, report an ACS image/runtime gap. Do not run Homebrew, global npm installs, or system-level package installs during a user task.
