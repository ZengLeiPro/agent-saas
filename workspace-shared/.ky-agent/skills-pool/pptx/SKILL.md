---
name: pptx
description: "Any presentation task, in any form. Two branches: (A) editable Microsoft .pptx files (client proposals, internal reports, training decks, anything opened in Office/Keynote); (B) single-file HTML decks (magazine or Swiss International style, horizontal swipe) plus social cover images (公众号头图 21:9, 分享卡 1:1, 小红书 3:4, 视频号 16:9). Triggers: .pptx, PowerPoint, deck, slides, presentation, pitch deck, speaker notes, 杂志风/瑞士风 PPT, horizontal swipe deck, demo day deck, 演讲分享 slides, 公众号封面/头图/分享卡, 小红书封面, 视频号封面. Identify the branch first, then read that sub-skill's SKILL.md; if unclear ask: '需要可编辑的 .pptx 文件，还是单文件网页 deck / 平台封面？'"
license: See pptx-binary/LICENSE.txt (Anthropic) and html-deck/LICENSE (MIT, op7418)
---

# Presentation Skill (Two Branches)

> **Brand colors (Kaiyan)**: primary blue `#2E56E1`, accent orange `#E8843A`, orange text `#A0500E` (not `#B65E16`); Chinese font stack in ACS should prefer `Noto Sans SC`, `Microsoft YaHei UI`, `PingFang SC`, `sans-serif`. See `brand-guidelines` skill for the full spec. For pptx-binary use `RGBColor(0x2E, 0x56, 0xE1)`.

## ACS Sandbox Rules

- Resolve branch scripts relative to the active skill directory; do not assume `.claude/skills/pptx/`, `/Users/admin/...`, or `~/code/...`.
- Final `.pptx`, `.pdf`, thumbnail grids, and HTML deck deliverables should be written under `assets/yyyymmdd/`.
- HTML deck files delivered to the user must be single-file self-contained: no CDN, no remote fonts, no sibling JS/CSS/image dependency. Treat bundled templates as source templates until the final HTML is inlined.
- Dependencies must come from the ACS image, project-local installs, or workspace `.venv`; do not run global npm installs or system package managers during a task.

This skill handles all presentation-related tasks across two very different output formats. **Before doing anything, decide which branch fits the user's intent**, then read that branch's own `SKILL.md` for the full workflow.

## Branch Decision

| User intent / signals | Branch | Why |
|---|---|---|
| `.pptx` file mentioned, "PowerPoint", "Keynote", "我同事要在 PowerPoint 里编辑", client proposal, internal report, training deck, anything that will be opened in Office software | **A — pptx-binary** | Output is an editable Microsoft `.pptx` binary file |
| 客户提案 / 方案书 / 报价附件 / 内部汇报 / 培训课件 (collaborative editing expected) | **A — pptx-binary** | Same reason — needs to be portable across people and Office tools |
| "杂志风 PPT", "瑞士风 PPT", "Swiss style", "horizontal swipe deck", "electronic ink", "magazine style" | **B — html-deck** | Author-locked visual styles; output is a single self-contained HTML |
| 演讲 / 分享会 / 私享会 / demo day / AI 产品发布 / 行业内部讲话 | **B — html-deck** | One-off polished visual artifact, no editing afterward |
| 公众号 21:9 头图 / 公众号分享卡 1:1 / 小红书 3:4 封面 / 视频号横版封面 | **B — html-deck** | Same Skill includes social-media cover generation with consistent visual rules |
| 不确定 / 用户只说"做个 PPT" | **Ask first** | "需要可编辑的 .pptx 文件,还是单文件网页 deck / 平台封面?" |

**Hard rule**: never silently mix the two branches. If a user starts with branch B (HTML deck) and later asks "导出成 .pptx 给同事改",that is a new task that re-enters branch A from scratch (the visual fidelity does not transfer; you have to rebuild as a real pptx).

## Branch A — Microsoft `.pptx` (binary, editable)

**When**: any task whose final deliverable is a `.pptx` file, or reading / parsing / extracting content from a `.pptx`.

**Stack**: Python (`markitdown` for read, `pptxgenjs` for create) + LibreOffice (PDF rendering) + custom unpack/pack/clean scripts.

**Capabilities**: read / extract text / thumbnail / unpack-edit-pack / create from scratch / template-based editing / visual QA via PDF rasterization.

→ **Read [`pptx-binary/SKILL.md`](pptx-binary/SKILL.md) for the full workflow.**

All scripts and references live under `pptx-binary/` — when that SKILL.md says `scripts/thumbnail.py` it means `pptx-binary/scripts/thumbnail.py`. Resolve those paths from the `pptx-binary` skill directory.

## Branch B — HTML Deck (single-file, web presentation)

**When**: any task whose final deliverable is a single `.html` file (a horizontal-swipe web deck) or a platform cover image. Includes both standalone decks AND social-media covers derived from the same visual system.

**Stack**: Pure HTML + CSS + JS (WebGL background + Motion One animations). No build step. Browser opens the file directly.

**Two visual systems**:
- **Style A — 电子杂志 × 电子墨水**: serif headings (Noto Serif SC + Playfair Display) + WebGL fluid background + 5 ink-tone themes. For storytelling, humanistic sharing, industry observation, personal voice.
- **Style B — 瑞士国际主义 (Swiss Style)**: all sans-serif (Inter + Helvetica + Noto Sans SC) + single high-saturation accent (Klein Blue / Lemon Yellow / Lemon Green / Safety Orange) + 22 locked layouts + grid lock + hairline rules. For facts, products, methodology, data reports.

**Capabilities**: 22+10 named layouts / fixed theme palettes (no custom hex allowed) / Codex-driven GPT-Image 2.0 illustration generation / multi-platform cover sheets (公众号 / 小红书 / 视频号).

→ **Read [`html-deck/SKILL.md`](html-deck/SKILL.md) for the full workflow.**

The first step inside that SKILL.md is a 6-question clarification (style choice, audience, duration, materials, images, theme color, hard constraints). Do not skip it — the locked nature of these visual systems means that retrofitting decisions later is expensive.

## Directory Layout

```
pptx/
├── SKILL.md              ← this file (branch router)
├── UPSTREAM.md           ← how to sync each branch from its upstream repo
├── pptx-binary/          ← Branch A · Anthropic official pptx skill (snapshot)
│   ├── SKILL.md
│   ├── LICENSE.txt
│   ├── editing.md
│   ├── pptxgenjs.md
│   └── scripts/
└── html-deck/            ← Branch B · op7418/guizang-ppt-skill (snapshot)
    ├── SKILL.md
    ├── LICENSE          (MIT)
    ├── assets/          (template.html, template-swiss.html, motion.min.js)
    ├── references/      (layouts, themes, components, checklist, image-prompts, swiss-layout-lock)
    └── scripts/         (validate-swiss-deck.mjs)
```

Both branches are **upstream snapshots**. See [`UPSTREAM.md`](UPSTREAM.md) for sync instructions and version metadata.
