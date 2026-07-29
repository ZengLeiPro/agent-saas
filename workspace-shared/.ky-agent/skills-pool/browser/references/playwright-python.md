# ACS Python Playwright Patterns

Use `scripts/acs_browser.py` so Profile identity, new Headless Chromium, proxy routing, diagnostics and lease locking remain consistent.

## Custom Script Pattern

```python
page.goto('https://example.com', wait_until='domcontentloaded')
print(page.title())
screenshot('assets/20260730/browser/page.png', full_page=True)
```

One-shot execution:

```bash
python3 .ky-agent/skills/browser/scripts/acs_browser.py run assets/20260730/browser/task.py \
  --profile-id example-main \
  --run-id task-k8x2m9
```

Execution against a live cross-turn lease:

```bash
python3 .ky-agent/skills/browser/scripts/acs_browser.py run assets/20260730/browser/task.py \
  --lease-id example-login \
  --run-id task-k8x2m9
```

Start that lease with `lease-serve` through platform `Shell(mode="background", timeoutMs=14700000)`. The command must remain attached to the durable background task so ACS lifecycle management knows not to idle-pause the Sandbox. Never hide it with shell `&`, `nohup`, or an untracked detached child.

## Form Interaction

```python
page.get_by_label('Email').fill('user@example.com')
page.get_by_label('Password').fill('secret')
page.get_by_role('button', name='Sign in').click()
page.wait_for_load_state('domcontentloaded')
```

Only use credentials voluntarily provided by the user. For SMS, QR or confirmation pauses, use a lease rather than closing and reopening the page.

## Iframes

The built-in snapshot inventories all frames. Use a frame locator when the target control lives inside one:

```python
frame = page.frame_locator('iframe[name="invoice"]')
frame.get_by_role('button', name='生成发票信息').click()
```

## Downloads

```python
with page.expect_download() as download_info:
    page.get_by_role('button', name='Download').click()
download = download_info.value
target = downloads / download.suggested_filename
download.save_as(str(target))
print(target)
```

## Request Blocking

Only block resources when visual fidelity is irrelevant. Blocking fonts/images changes the effective browser environment and may break a site.

```python
def route_handler(route):
    if route.request.resource_type == 'media':
        route.abort()
    else:
        route.continue_()

page.route('**/*', route_handler)
```

## Diagnostics

```python
print(json.dumps(browser_diagnostics(), ensure_ascii=False, indent=2))
```

Failures already emit bounded, redacted artifacts. Add raw HTML/HAR only for a specific debugging task because they can contain credentials and private page data.
