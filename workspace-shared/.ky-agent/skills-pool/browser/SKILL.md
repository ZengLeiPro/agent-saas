---
name: browser
description: "ACS-native browser automation using Python Playwright inside the sandbox. Use for browsing web pages, interacting with forms, taking screenshots, exporting PDFs, checking rendered pages, and inspecting dynamic web content."
allowed-tools: "Bash(python3:*), Bash(rg:*), Bash(mkdir:*)"
---

# Browser Automation

Use the browser through Python Playwright inside the current ACS Sandbox. The sandbox image provides Chromium/Playwright; do not call the legacy host-side `/internal/browser` API and do not depend on `playwright-cli`.

## Runtime Contract

- Browser runs inside the current user's persistent workspace sandbox.
- Browser profile data is stored under `.ky-agent/runtime/browser-profiles/<session>/`.
- Downloads go to `$DOWNLOAD_DIR` / `$XDG_DOWNLOAD_DIR`, normally `downloads/`.
- Outputs for the user should be saved under `assets/yyyymmdd/browser/`.
- If Python Playwright is missing, report an ACS image/runtime dependency gap. Do not install global packages during a user task.

## Quick Commands

Set the skill path once:

```bash
SKILL_DIR="workspace-shared/.ky-agent/skills-pool/browser"
```

Take a text snapshot:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" snapshot 'https://example.com' \
  --session task-k8x2m9 \
  --out assets/20260701/browser/example.txt
```

Take a screenshot:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" screenshot 'https://example.com' \
  --session task-k8x2m9 \
  --out assets/20260701/browser/example.png \
  --text-out assets/20260701/browser/example.txt \
  --full-page
```

Export PDF:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" pdf 'https://example.com' \
  --session task-k8x2m9 \
  --out assets/20260701/browser/example.pdf
```

Evaluate JavaScript:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" eval 'https://example.com' \
  '() => ({ title: document.title, links: [...document.links].length })'
```

Run a custom Playwright workflow:

```bash
python3 "$SKILL_DIR/scripts/acs_browser.py" run assets/20260701/browser/task.py \
  --session task-k8x2m9 \
  --url 'https://example.com'
```

Inside a `run` script, these globals are available:

- `page`: Playwright Page
- `context`: Playwright BrowserContext
- `workspace`: workspace root as `Path`
- `downloads`: downloads directory as `Path`
- `Path`, `json`

Example custom script:

```python
page.fill('input[name="q"]', 'kaiyan')
page.keyboard.press('Enter')
page.wait_for_load_state('domcontentloaded')
out = workspace / 'assets/20260701/browser/search.png'
out.parent.mkdir(parents=True, exist_ok=True)
page.screenshot(path=str(out), full_page=True)
print(out)
```

## Rules

1. Always quote URLs with single quotes in shell commands.
2. Use a unique `--session` name with a random suffix for each task, such as `search-k8x2m9`.
3. Prefer `snapshot` before writing custom interactions; it prints body text and common interactive elements.
4. Use stable selectors in custom scripts: text role, label, name, id, or visible text. Avoid brittle absolute XPath unless necessary.
5. Save screenshots, PDFs, and extracted data under `assets/yyyymmdd/browser/`.
6. Do not use `kill-all`, `pkill`, or `killall`. Browser processes are scoped to each helper invocation and profile data persists on close.
7. Do not use `/internal/browser`, `localhost:3000`, `PLAYWRIGHT_MCP_CDP_ENDPOINT`, `--profile`, or `--user-data-dir`.
8. Do not install Playwright or Chromium during a user task. Missing runtime packages are platform image issues.

## Login-Required Sites

If a site requires login, do not immediately give up. Ask the user whether they want to assist with login. Good options:

- SMS code: you fill the phone number and the user gives the received code.
- QR login: take a screenshot of the QR code and ask the user to scan it.
- Account/password: only use credentials if the user voluntarily provides them.

Explain accurately: the browser profile is stored in the user's workspace sandbox and can be reused by later sessions for the same user/workspace. Do not promise absolute invisibility or that platform administrators can never access the data.

## Troubleshooting

- `ModuleNotFoundError: playwright`: ACS runtime venv is missing the base Python package. Report the runtime gap.
- Browser launch fails with missing executable: ACS image did not install Chromium or `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` is broken.
- Login state not retained: reuse the same `--session` name; profile persistence is per session name.
- Page is blank or blocked: try a custom script with longer waits, lower concurrency, or ask the user to complete a headed/manual login path if the platform supports it.
