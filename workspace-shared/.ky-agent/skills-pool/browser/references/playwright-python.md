# ACS Python Playwright Patterns

The browser skill runs inside the ACS Sandbox. Use Python Playwright directly or through `scripts/acs_browser.py`.

## Custom Script Pattern

```python
page.goto('https://example.com', wait_until='domcontentloaded')
print(page.title())
page.screenshot(path='assets/20260701/browser/page.png', full_page=True)
```

Run it with:

```bash
python3 .ky-agent/skills/browser/scripts/acs_browser.py run assets/20260701/browser/task.py --session task-k8x2m9
```

## Form Interaction

```python
page.goto('https://example.com/login', wait_until='domcontentloaded')
page.fill('input[name="email"]', 'user@example.com')
page.fill('input[name="password"]', 'secret')
page.click('button[type="submit"]')
page.wait_for_load_state('domcontentloaded')
```

Only use credentials voluntarily provided by the user.

## Downloads

```python
with page.expect_download() as download_info:
    page.click('text=Download')
download = download_info.value
target = downloads / download.suggested_filename
download.save_as(str(target))
print(target)
```

## Request Blocking

```python
def route_handler(route):
    if route.request.resource_type in {'image', 'font'}:
        route.abort()
    else:
        route.continue_()

page.route('**/*', route_handler)
page.goto('https://example.com')
```

## Trace-Like Debug Artifacts

Prefer deterministic artifacts over opaque tracing archives:

```python
out_dir = workspace / 'assets/20260701/browser'
out_dir.mkdir(parents=True, exist_ok=True)
page.screenshot(path=str(out_dir / 'debug.png'), full_page=True)
(out_dir / 'debug.html').write_text(page.content(), encoding='utf-8')
```
