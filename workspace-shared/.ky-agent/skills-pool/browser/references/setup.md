# Setup

ACS Sandbox should provide Python Playwright in the image-owned `/opt/ky-agent/browser-runtime` venv, plus both regular Chromium and Headless Shell. `acs_browser.py` automatically re-execs with that interpreter, so existing `python3 acs_browser.py ...` calls remain compatible. Browser tasks intentionally use regular Chromium new Headless via `channel="chromium"`.

Verify without creating a long-lived Profile:

```bash
/opt/ky-agent/browser-runtime/bin/python3 -c "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); b=p.chromium.launch(headless=True, channel='chromium', args=['--disable-dev-shm-usage']); page=b.new_page(locale='zh-CN', timezone_id='Asia/Shanghai'); page.set_content('<h1>ok</h1>'); print(page.inner_text('body')); b.close(); p.stop()"
```

If this fails, report an ACS image/runtime gap. Do not run Homebrew, global npm installs, or system-level package installs during a user task.
