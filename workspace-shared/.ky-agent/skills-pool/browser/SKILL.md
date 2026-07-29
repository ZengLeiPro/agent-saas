---
name: browser
description: "ACS-native browser automation using Python Playwright inside the sandbox. Use for browsing dynamic pages, interacting with forms and iframe content, retaining site login state, taking screenshots/PDFs, diagnosing challenge pages, and pausing browser work for SMS/QR/manual confirmation across conversation turns."
allowed-tools: "Bash(python3:*), Bash(rg:*), Bash(mkdir:*)"
---

# Browser Automation

Use Python Playwright inside the current ACS Sandbox. The runtime provides regular Chromium and persistent workspace storage. Do not call the legacy host-side `/internal/browser` API or depend on `playwright-cli`.

## Runtime Contract

- Regular Chromium new Headless is selected with `channel="chromium"`; do not downgrade to the separate Headless Shell unless debugging a verified compatibility regression.
- Browser identity and task execution are separate:
  - `--profile-id` is a stable site/account identity. Reuse it across tasks that must share cookies and login state.
  - `--run-id` identifies only the current execution and its diagnostic artifacts. Use a fresh value for each task.
- The old `--session` flag remains a compatibility alias for existing Profiles, but new workflows should not use it.
- Without `--profile-id`, the helper derives a stable public profile from the URL hostname. For login or multiple accounts on one site, always pass an explicit profile ID.
- Profile identity settings are frozen on first creation: `zh-CN`, `Asia/Shanghai`, 1440×1000 viewport, 1920×1080 screen, DPR 1, light color scheme. Do not spoof User-Agent or mutate these values mid-profile.
- Profile data lives under `.ky-agent/runtime/browser-profiles/`; downloads use `$DOWNLOAD_DIR` / `$XDG_DOWNLOAD_DIR`.
- A Profile is exclusive: do not launch two browsers against the same Profile. Use the existing lease when one is active.
- Outputs belong under `assets/yyyymmdd/browser/`.
- Screenshots use bounded font waiting and automatic Chromium CDP fallback.

## Locate the Helper

Skill files are synced under `.ky-agent/skills/`:

```bash
SKILL_DIR=".ky-agent/skills/browser"
```

If the directory does not exist, report a platform skill-sync gap. Do not search for or install an alternative Playwright runtime.

## One-Shot Tasks

Public text snapshot; the helper derives `site:example.com` as the Profile:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" snapshot 'https://example.com' \
  --run-id example-read-k8x2m9 \
  --out assets/20260730/browser/example.txt
```

Logged-in site; keep one stable Profile for this account:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" screenshot 'https://portal.example.com/home' \
  --profile-id portal-main-account \
  --run-id portal-home-p3f7w1 \
  --out assets/20260730/browser/portal.png \
  --text-out assets/20260730/browser/portal.txt \
  --full-page
```

Export PDF:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" pdf 'https://example.com/report' \
  --profile-id example-reporting \
  --run-id report-v4m8n2 \
  --out assets/20260730/browser/report.pdf
```

Evaluate JavaScript:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" eval 'https://example.com' \
  '() => ({ title: document.title, links: [...document.links].length })' \
  --run-id inspect-z6c1q4
```

## Diagnose Blocks and Rendering Problems

`diagnose` records the final status/URL, suspected challenge signals, effective browser identity, iframe inventory, console/page errors, and failed or HTTP 4xx/5xx requests. Query strings and common secret fields are redacted.

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" diagnose 'https://example.com' \
  --profile-id example-main \
  --run-id diagnose-j2d9s5 \
  --out assets/20260730/browser/diagnostics.json
```

Passing BrowserScan or Sannysoft is not proof that a real site will accept automation. Use diagnostics to explain failures, not to patch `navigator.webdriver`, forge fingerprints, or defeat CAPTCHA/security controls.

## Cross-Turn Browser Lease

Use a lease whenever the browser page must remain alive while waiting for an SMS code, QR scan, user confirmation, or a later conversation turn.

Start the lease host with the platform `Shell` tool in durable background mode. This is required: the background task registers ACS lifecycle protection, so the Sandbox is not paused by the normal idle policy while the browser is waiting.

```json
{
  "command": "SKILL_DIR=.ky-agent/skills/browser; python3 \"$SKILL_DIR/scripts/acs_browser.py\" lease-serve --lease-id portal-login --profile-id portal-main-account --lease-ttl-seconds 1800 --url 'https://portal.example.com/login'",
  "mode": "background",
  "timeoutMs": 14700000
}
```

`lease-serve` intentionally stays in the foreground of that durable background task. Do not add `&`, `nohup`, `disown`, or launch it with ordinary foreground `Shell`. After `Shell(mode="background")` returns its task ID, call `lease-status` until status is `ready` before interacting.

Operate the live browser by passing the lease ID. The helper renews the lease after each connected action:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" screenshot \
  --lease-id portal-login \
  --run-id login-qr-r7n4x2 \
  --out assets/20260730/browser/login-qr.png
```

After the user scans or supplies a code, run a custom workflow against the same page and context:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" run assets/20260730/browser/finish-login.py \
  --lease-id portal-login \
  --run-id finish-login-b5m3k8
```

Inspect, renew, and stop explicitly:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" lease-status --lease-id portal-login
python3 "$SKILL_DIR/scripts/acs_browser.py" lease-touch --lease-id portal-login --lease-ttl-seconds 1800
python3 "$SKILL_DIR/scripts/acs_browser.py" lease-stop --lease-id portal-login
```

Lease properties:

- CDP listens only on `127.0.0.1` inside the ACS Sandbox.
- Default TTL is 30 minutes; allowed range is 1 minute to 4 hours, with a hard 4-hour cap from initial start.
- The durable background task protects the ACS Sandbox for 4 hours plus a 5-minute shutdown margin. `lease-stop` ends the host, after which the platform clears that protection.
- The Profile remains on workspace storage after stop/expiry, but the browser process does not survive Sandbox pause/rebuild. Start the same lease/Profile again to rehydrate it.
- A lease serializes connected actions. If it reports busy, wait for the current action instead of creating another browser with the same Profile.
- Stop the lease when the user-visible workflow finishes.

## Custom Playwright Workflow

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" run assets/20260730/browser/task.py \
  --profile-id example-main \
  --run-id task-k8x2m9 \
  --url 'https://example.com'
```

Available globals:

- `page`, `context`
- `workspace`, `downloads`, `Path`, `json`
- `screenshot(path, full_page=False)`: resilient screenshot helper
- `browser_diagnostics()`: current navigation, fingerprint and redacted runtime events

Prefer Playwright locators by role, label, name, ID, or visible text. The built-in snapshot already traverses every Playwright frame and open Shadow DOM; inspect it before inventing brittle selectors.

## Behavior and Network Discipline

- Use semantic waits, page readiness, server-provided `Retry-After`, and conservative per-domain pacing.
- Do not add random mouse paths, arbitrary delays, stealth plugins, or JavaScript patches that pretend automation is a human.
- Do not rotate proxies during a Profile lifetime. Enterprise portals should use a stable tenant/site egress identity and customer-side IP allowlisting when available.
- Do not automatically solve or bypass CAPTCHA. Keep the lease alive and request user assistance.
- Only use credentials the user voluntarily provides; do not ask them to paste account passwords when SMS or QR assistance is available.

## Failure Handling

Browser action failures automatically save a screenshot, recursive text snapshot, redacted console/network events, and block classification under `assets/yyyymmdd/browser/failures/<run-id>/`.

- `ModuleNotFoundError: playwright`: ACS runtime venv is missing a base dependency.
- Missing executable: ACS image and `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` are inconsistent.
- Profile busy: reuse/stop the active lease or wait for its current action.
- Lease `stale`: its host process disappeared, usually after Sandbox rebuild; restart the same lease/Profile.
- `fontsReady=false`: the current raster was still captured; do not retry only for fonts.
- `method=cdp-fallback`: standard capture failed but recovery succeeded.

Never use `kill-all`, `pkill`, `killall`, `/internal/browser`, `localhost:3000`, `PLAYWRIGHT_MCP_CDP_ENDPOINT`, `--user-data-dir`, or a manually supplied Chromium executable.
