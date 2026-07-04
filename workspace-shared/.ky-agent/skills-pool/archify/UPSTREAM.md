# Upstream Sync Guide

> Maintenance-only note. Do not run these commands from a normal ACS user task. Any sync that can overwrite or delete files must be reviewed as a separate repository maintenance operation with an explicit file list and confirmation.

## Archify

- Upstream repo: <https://github.com/tt-a1i/archify>
- Upstream path inside repo: `archify/`
- License: MIT, see `LICENSE`
- Last synced tag: `v2.8.0`
- Last synced commit: `8ca7f0c4535bcc974b5a0229fd73e31250d26ab2`
- Last synced at: 2026-07-03

## Local Patches

Re-apply these after every upstream sync:

1. `assets/template.html`: remove Google Fonts / `fonts.gstatic.com` links. KY Agent HTML preview runs in an isolated sandbox and must not depend on remote resources.
2. `SKILL.md`: keep the Chinese frontmatter description and `KY Agent Runtime Rules` section.
3. `test/golden.mjs` and `test/render-examples.mjs`: keep tests and generated example HTML self-contained inside the skill directory instead of reading/writing `../examples`.

## How To Check For Updates

```bash
curl -sf 'https://api.github.com/repos/tt-a1i/archify/commits?path=archify&per_page=10' \
  | python3 -c "
import json, sys
for c in json.load(sys.stdin):
    print(c['commit']['author']['date'], c['sha'][:8], c['commit']['message'].split(chr(10))[0])
"
```

## How To Apply An Update

```bash
SKILL_DIR="<agent-saas>/workspace-shared/.ky-agent/skills-pool/archify"
TMP=$(mktemp -d)
git clone --depth 1 https://github.com/tt-a1i/archify.git "$TMP/archify-repo"

# Review the full replacement list before syncing.
rsync -avn --delete --exclude='node_modules' "$TMP/archify-repo/archify/" "$SKILL_DIR/"

# Only after explicit approval for the reviewed replacement list:
rsync -av --delete --exclude='node_modules' "$TMP/archify-repo/archify/" "$SKILL_DIR/"
```

After sync, re-apply local patches, then run:

```bash
cd "$SKILL_DIR"
npm install
npm test
```
