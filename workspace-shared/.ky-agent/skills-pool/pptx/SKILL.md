---
name: pptx
description: "Use this skill any time a presentation is involved — in any form. Two branches: (A) Microsoft .pptx files (binary, editable in PowerPoint/Keynote, suitable for client proposals, internal reports, training decks, anything that needs to be opened or edited in Office software); (B) Single-file HTML decks (horizontal-swipe web presentations in either magazine style or Swiss International style, plus matching social-media cover images for WeChat 21:9 头图, WeChat 分享卡 1:1, 小红书 3:4, 视频号 16:9; suitable for demo days, public talks, sharing sessions, AI product launches, anything that needs a polished one-off visual artifact rather than an editable document). Triggers include any mention of: .pptx file, PowerPoint, deck, slides, presentation, pitch deck, slide template, speaker notes, 杂志风 PPT, 瑞士风 PPT, Swiss style PPT, Swiss International style, electronic ink style, horizontal swipe deck, magazine style presentation, demo day deck, 演讲分享 slides, 公众号头图, 公众号封面, 公众号分享卡, 小红书封面, 小红书 3:4, 视频号封面, 视频号横版. First identify which branch fits the user's intent, then read the corresponding sub-skill SKILL.md. If unclear, ask the user: '需要可编辑的 .pptx 文件,还是单文件网页 deck / 平台封面?'"
license: See pptx-binary/LICENSE.txt (Anthropic) and html-deck/LICENSE (MIT, op7418)
---

# Presentation Skill (Two Branches)

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

All scripts and references live under `pptx-binary/` — when that SKILL.md says `scripts/thumbnail.py` it means `pptx-binary/scripts/thumbnail.py`. The Read tool resolves these correctly because that SKILL.md is read from inside `pptx-binary/`.

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
