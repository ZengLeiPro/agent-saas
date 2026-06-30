# Setup

## 1. Runtime expectation

ACS Sandbox should already provide `playwright-cli`, `curl`, and the internal browser lifecycle API. Do not run global installs during a user task.

## 2. Verify

```bash
playwright-cli --version
```

The platform automatically configures `PLAYWRIGHT_MCP_CDP_ENDPOINT` for each user. No manual browser or token setup is needed.

If `playwright-cli` is missing, report an ACS image dependency gap. Do not run Homebrew, `npm install -g`, or mutate the shared skill directory from a normal task.
