# Upstream Sync Guide

> Maintenance-only note. Do not run these commands from a normal ACS user task. Any sync that can overwrite or delete files must be reviewed as a separate repository maintenance operation with an explicit file list and confirmation.

This skill is composed of **two upstream snapshots**. Each lives in its own subdirectory and has its own upstream repo. When asked "看看 pptx skill 有没有上游更新",follow the procedure below for **each** branch independently.

---

## Branch A · `pptx-binary/` (Anthropic official)

- **Upstream repo**: <https://github.com/anthropics/skills>
- **Upstream path inside repo**: `skills/pptx/`
- **License**: see `pptx-binary/LICENSE.txt` (Anthropic proprietary)
- **Last synced commit**: `1ed29a03` (2026-02-06)
- **Last synced at**: 2026-05-11 (verified via GitHub API; remote main matches snapshot byte-for-byte)
- **Working copy on this machine**: none kept locally (Anthropic releases are infrequent; query GitHub API directly each check)

### How to check for updates

```bash
# 1. List the last 10 commits that touched skills/pptx/
curl -sf 'https://api.github.com/repos/anthropics/skills/commits?path=skills/pptx&per_page=10' \
  | python3 -c "
import json, sys
for c in json.load(sys.stdin):
    print(c['commit']['author']['date'], c['sha'][:8], c['commit']['message'].split(chr(10))[0])
"

# 2. Compare top-level file sizes against the local snapshot
curl -sf 'https://api.github.com/repos/anthropics/skills/contents/skills/pptx?ref=main' \
  | python3 -c "
import json, sys
for item in json.load(sys.stdin):
    print(f\"{item['type']:6} {item['size']:>8}  {item['name']}\")
"
# Compare against:  ls -la pptx-binary/
```

If both the commit list and the file sizes match the "Last synced" row above, there is nothing to do — report "no upstream changes since 2026-02-06" and stop.

### How to apply an update

```bash
SKILL_DIR="<workspace-shared>/.ky-agent/skills-pool/pptx"
TMP=$(mktemp -d)
cd "$TMP"
# Sparse-checkout only the pptx subdirectory to avoid pulling the whole skills repo
git clone --filter=blob:none --no-checkout https://github.com/anthropics/skills.git
cd skills
git sparse-checkout init --cone
git sparse-checkout set skills/pptx
git checkout main
LATEST_COMMIT=$(git rev-parse HEAD)

# Replace local snapshot wholesale (preserves LICENSE.txt automatically because it's upstream too)
rsync -av --delete skills/pptx/ "$SKILL_DIR/pptx-binary/"

echo "Synced to commit $LATEST_COMMIT"
# Then update the "Last synced commit" + "Last synced at" rows in this file
```

After sync: re-read `pptx-binary/SKILL.md` and `pptx-binary/editing.md` for any new workflow changes that might affect the top-level router (`SKILL.md`). If the upstream renames a sub-file or adds a new entry point, update the router's Branch A section accordingly.

### Local patches that MUST be re-applied after every sync (pptx-binary)

Added 2026-07-16 (生产 agent 反馈修复批次). All in `pptx-binary/SKILL.md`:

1. **"Environment Self-Check (run FIRST)" section** after Quick Reference — one-shot dependency check (defusedxml/markitdown/pptx/PIL/pptxgenjs/soffice/pdftoppm) before any work.
2. **QA section header** — three explicit stages (Structural / Content / Visual) + honest reporting requirement.
3. **"Structural QA" subsection** — validate.py + python-pptx geometry out-of-bounds check snippet.
4. **Content QA addition** — "Rendered-text check (CJK line breaks)" paragraph (pdftotext-based, 1–2 char orphan detection).
5. **Visual QA "Reality check first" paragraph** — no-vision environments must skip and report, not fake it.
6. **Converting to Images** — javaldx-warning-is-harmless note.
7. **"CJK Typography (Chinese decks)" section** — Microsoft YaHei guidance, Noto Sans CJK SC substitution caveat, ≥10% width headroom rule, Latin metric-compatible font list.
8. **Dependencies section rewritten** — states the actual ACS provisioning source (base.txt venv / image `/opt/ky-agent/node/node_modules` + NODE_PATH / no gcc) instead of upstream's generic wording.

Re-apply by diffing against git history of this repo (`git log -p -- workspace-shared/.ky-agent/skills-pool/pptx/pptx-binary/SKILL.md`) after any upstream rsync.

---

## Branch B · `html-deck/` (op7418 / 歸藏)

- **Upstream repo**: <https://github.com/op7418/guizang-ppt-skill>
- **License**: MIT, see `html-deck/LICENSE`
- **Last synced commit**: `f6676c3f315e4cbf8abb41daa26377688a716a5f` (2026-05-11 01:30:55 +0800)
- **Last synced at**: 2026-05-11
- **Working copy**: maintenance clone only; do not assume it exists in ACS.

### How to check for updates

```bash
cd "<maintenance working clone>"
git fetch origin main
git log --oneline HEAD..origin/main           # commits we don't have yet
git diff --stat HEAD..origin/main             # what changed
```

If `git log` shows no new commits, report "no upstream changes since [last synced date]" and stop.

### How to apply an update

```bash
SKILL_DIR="<workspace-shared>/.ky-agent/skills-pool/pptx"
WORK_DIR="<maintenance working clone>"

cd "$WORK_DIR"
git pull origin main
LATEST_COMMIT=$(git rev-parse HEAD)
LATEST_DATE=$(git log -1 --format='%ci')

# Replace the snapshot, preserving subdirectory layout. The 5 files we patched
# below will be reset by this rsync — re-apply the patches afterward.
rsync -av --delete \
  --exclude='.git' --exclude='.gitignore' \
  --exclude='README.md' --exclude='README.en.md' \
  "$WORK_DIR/" "$SKILL_DIR/html-deck/"

echo "Synced to commit $LATEST_COMMIT  ($LATEST_DATE)"
```

### Local patches that MUST be re-applied after every sync

The 歸藏 upstream hard-codes the author's local "golden source" PPT path
(`/Users/guohao/Documents/op7418的仓库/项目/Thin-Harness-Fat-Skills/ppt/index.html`)
in 5 places. We rewrite all 5 references each sync. Locations:

1. `html-deck/SKILL.md` — section "4.0 · 不只看代码:必须打开网页做视觉核对", item 1
2. `html-deck/references/swiss-layout-lock.md` — "## Golden Source" block
3. `html-deck/references/checklist.md` — around line 173, item under "做法:"
4. `html-deck/references/layouts-swiss.md` — "## Swiss locked mode" block (around line 11)
5. `html-deck/references/layouts-swiss.md` — "## 视觉 + 代码双维审核" section, item 1

Standard replacement language (Chinese):
> 本仓库的 Swiss 主题 golden source 就是 `assets/template-swiss.html` 加上 `references/swiss-layout-lock.md` 登记的 22 个版式(作者本机的原始参考 PPT 对本仓库使用者不可访问)。

After re-applying patches, verify with:
```bash
grep -r "guohao" "$SKILL_DIR/html-deck/"
# Must return no matches.
```

6. `html-deck/SKILL.md` — section "#### AI 配图生成(可选)" (added 2026-07-16): upstream's Codex-only image-generation flow is rewritten as environment-aware — KY Agent / agent-saas production uses the platform `GenerateImage` tool (gpt-image-2 / seedream); Codex keeps GPT-M 2.0; no-vision environments fall back to placeholder blocks. Upstream section title was "#### Codex 配图生成(可选)".

Then update the "Last synced commit" + "Last synced at" rows in this file.

---

## When to check

There is no automatic monitor for these upstreams. Trigger a check when:

1. User asks "看看 pptx skill 有没有更新" or similar.
2. User reports a bug whose root cause might be a fix already in upstream.
3. Before any major use of the skill where the latest visual / behavioral improvements matter (e.g. preparing a 标杆客户 deck).

The cost of a check is ~30 seconds (two `curl`/`git` calls). Don't skip it before high-stakes use.
