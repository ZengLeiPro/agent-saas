# Browser Session Management

Run multiple isolated browser sessions concurrently with state persistence.

> **Note**: All examples below assume CDP mode. Before any `open` command, call the ensure API; after `close`, call the stop API to release resources. See SKILL.md for the full workflow.

## Named Browser Sessions

Use `-s` flag to isolate browser contexts:

```bash
# Browser 1: Authentication flow
playwright-cli -s=auth-x7k2m open https://app.example.com/login

# Browser 2: Public browsing (separate cookies, storage)
playwright-cli -s=public-p3f1w open https://example.com

# Commands are isolated by browser session
playwright-cli -s=auth-x7k2m fill e1 "user@example.com"
playwright-cli -s=public-p3f1w snapshot
```

## Browser Session Isolation Properties

Each browser session has independent:
- Cookies
- LocalStorage / SessionStorage
- IndexedDB
- Cache
- Browsing history
- Open tabs

## Browser Session Commands

```bash
# List all browser sessions
playwright-cli list

# Stop a named browser session
playwright-cli -s=mysession close

# Delete browser session user data (profile directory)
playwright-cli -s=mysession delete-data
```

> **Warning**: Do NOT use `close-all` or `kill-all` — they kill ALL sessions including those belonging to other agents running concurrently. Always close your own session by name with `-s=<your-session> close`.

## Environment Variable

Set a default browser session name via environment variable:

```bash
export PLAYWRIGHT_CLI_SESSION="mysession"
playwright-cli open example.com  # Uses "mysession" automatically
```

## Common Patterns

### Concurrent Scraping

```bash
#!/bin/bash
# Scrape multiple sites concurrently

# Start all browsers
playwright-cli -s=site1-a3b2c open https://site1.com &
playwright-cli -s=site2-d4e5f open https://site2.com &
playwright-cli -s=site3-g6h7i open https://site3.com &
wait

# Take snapshots from each
playwright-cli -s=site1-a3b2c snapshot
playwright-cli -s=site2-d4e5f snapshot
playwright-cli -s=site3-g6h7i snapshot

# Cleanup — close each session individually
playwright-cli -s=site1-a3b2c close
playwright-cli -s=site2-d4e5f close
playwright-cli -s=site3-g6h7i close
```

### A/B Testing Sessions

```bash
# Test different user experiences
playwright-cli -s=variant-a-k8x2 open 'https://app.com?variant=a'
playwright-cli -s=variant-b-m9y3 open 'https://app.com?variant=b'

# Compare
playwright-cli -s=variant-a-k8x2 screenshot
playwright-cli -s=variant-b-m9y3 screenshot
```

## Browser Session Configuration

```bash
# Open with config file
playwright-cli -s=task-abc open https://example.com --config=.playwright/my-cli.json

# Open with specific browser
playwright-cli -s=task-abc open https://example.com --browser=firefox
```

> **Note**: In CDP mode, headed/headless is controlled by the ensure API's `headed` parameter, not by `--headed` flag. Browser profile is managed by the platform automatically — do NOT pass `--profile`, `--persistent`, or `--user-data-dir` flags.

## Best Practices

### 1. Name Browser Sessions Semantically

```bash
# GOOD: Clear purpose + random suffix
playwright-cli -s=github-auth-k3m7 open https://github.com
playwright-cli -s=docs-scrape-p2n8 open https://docs.example.com

# AVOID: Generic names without suffix
playwright-cli -s=s1 open https://github.com
```

### 2. Always Clean Up Your Own Sessions

```bash
# Stop your sessions individually when done
playwright-cli -s=auth-k3m7 close
playwright-cli -s=scrape-p2n8 close

# ⚠ NEVER use close-all or kill-all — they affect other agents' sessions
```

### 3. Delete Stale Browser Data

```bash
# Remove old browser data to free disk space
playwright-cli -s=oldsession delete-data
```
