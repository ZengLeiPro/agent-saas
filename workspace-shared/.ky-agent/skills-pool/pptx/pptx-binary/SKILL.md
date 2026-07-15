---
name: pptx
description: "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions \"deck,\" \"slides,\" \"presentation,\" or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill."
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX Skill

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | `python -m markitdown presentation.pptx` |
| Edit or create from template | Read [editing.md](editing.md) |
| Create from scratch | Read [pptxgenjs.md](pptxgenjs.md) |

---

## Environment Self-Check (run FIRST)

Verify dependencies before starting any work — do not discover a missing package halfway through:

```bash
python -c "import defusedxml, markitdown, pptx, PIL; print('python deps ok')" \
  && node -e "require('pptxgenjs'); console.log('pptxgenjs ok')" \
  && command -v soffice pdftoppm >/dev/null && echo "office toolchain ok"
```

If anything is missing, report it explicitly and pick a workable fallback (e.g. `python-pptx` instead of `pptxgenjs` for creation) **before** writing content. Do not silently improvise mid-task.

---

## Reading Content

```bash
# Text extraction
python -m markitdown presentation.pptx

# Visual overview
python scripts/thumbnail.py presentation.pptx

# Raw XML
python scripts/office/unpack.py presentation.pptx unpacked/
```

---

## Editing Workflow

**Read [editing.md](editing.md) for full details.**

1. Analyze template with `thumbnail.py`
2. Unpack → manipulate slides → edit content → clean → pack

---

## Creating from Scratch

**Read [pptxgenjs.md](pptxgenjs.md) for full details.**

Use when no template or reference presentation is available.

---

## Design Ideas

**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent. Never give all colors equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles, thick single-side borders. Carry it across every slide.

### Color Palettes

Choose colors that match your topic — don't default to generic blue. Use these palettes as inspiration:

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Midnight Executive** | `1E2761` (navy) | `CADCFC` (ice blue) | `FFFFFF` (white) |
| **Forest & Moss** | `2C5F2D` (forest) | `97BC62` (moss) | `F5F5F5` (cream) |
| **Coral Energy** | `F96167` (coral) | `F9E795` (gold) | `2F3C7E` (navy) |
| **Warm Terracotta** | `B85042` (terracotta) | `E7E8D1` (sand) | `A7BEAE` (sage) |
| **Ocean Gradient** | `065A82` (deep blue) | `1C7293` (teal) | `21295C` (midnight) |
| **Charcoal Minimal** | `36454F` (charcoal) | `F2F2F2` (off-white) | `212121` (black) |
| **Teal Trust** | `028090` (teal) | `00A896` (seafoam) | `02C39A` (mint) |
| **Berry & Cream** | `6D2E46` (berry) | `A26769` (dusty rose) | `ECE2D0` (cream) |
| **Sage Calm** | `84B59F` (sage) | `69A297` (eucalyptus) | `50808E` (slate) |
| **Cherry Bold** | `990011` (cherry) | `FCF6F5` (off-white) | `2F3C7E` (navy) |

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

**Layout options:**
- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

**Visual polish:**
- Icons in small colored circles next to section headers
- Italic accent text for key stats or taglines

### Typography

**Choose an interesting font pairing** — don't default to Arial. Pick a header font with personality and pair it with a clean body font.

| Header Font | Body Font |
|-------------|-----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |
| Impact | Arial |
| Palatino | Garamond |
| Consolas | Calibri |

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt muted |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead

---

## QA (Required)

**Assume there are problems. Your job is to find them.**

Your first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

QA is **three explicit stages** — run all that your environment supports, and honestly report which stages you could NOT run:

1. **Structural QA** — file integrity and geometry (no rendering needed)
2. **Content QA** — extracted and rendered text
3. **Visual QA** — pixel-level inspection of rendered slides (requires a vision-capable model)

### Structural QA

```bash
# OOXML schema validation
python scripts/office/validate.py output.pptx

# Geometry check: elements outside slide bounds / overlapping
python - <<'PY'
from pptx import Presentation
from pptx.util import Emu
prs = Presentation('output.pptx')
W, H = prs.slide_width, prs.slide_height
for i, slide in enumerate(prs.slides, 1):
    for sh in slide.shapes:
        if sh.left is None or sh.top is None:
            continue
        r, b = sh.left + (sh.width or 0), sh.top + (sh.height or 0)
        if sh.left < 0 or sh.top < 0 or r > W or b > H:
            print(f"slide {i}: '{sh.name}' out of bounds "
                  f"({Emu(sh.left).inches:.2f},{Emu(sh.top).inches:.2f})"
                  f"→({Emu(r).inches:.2f},{Emu(b).inches:.2f})")
print('geometry check done')
PY
```

### Content QA

```bash
python -m markitdown output.pptx
```

Check for missing content, typos, wrong order.

**When using templates, check for leftover placeholder text:**

```bash
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|this.*(page|slide).*layout"
```

If grep returns results, fix them before declaring success.

**Rendered-text check (CJK line breaks)**: after converting to PDF (see below), run `pdftotext output.pdf -` and compare against the source text. For Chinese content, look specifically for bad breaks — a 1–2 character orphan wrapped to the next line (e.g. 「持续更/新」「企业记/忆」). Fix by widening the text box or shortening the line; leave ≥10% width headroom because font substitution shifts line breaks between environments (see CJK Typography below).

### Visual QA

**Reality check first**: this stage requires a model that can actually see images. If `Read` on a PNG returns a file path or binary garbage instead of visual content, your environment has **no vision path** — subagents in the same environment are equally blind. In that case: complete Structural + Content QA, skip this stage, and **state explicitly in your final report that pixel-level visual QA was not performed**. Never claim visual inspection you could not do.

**⚠️ USE SUBAGENTS** (when vision is available) — even for 2-3 slides. You've been staring at the code and will see what you expect, not what's there. Subagents have fresh eyes.

Convert slides to images (see [Converting to Images](#converting-to-images)), then use this prompt:

```
Visually inspect these slides. Assume there are issues — find them.

Look for:
- Overlapping elements (text through shapes, lines through words, stacked elements)
- Text overflow or cut off at edges/box boundaries
- Decorative lines positioned for single-line text but title wrapped to two lines
- Source citations or footers colliding with content above
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Columns or similar elements not aligned consistently
- Low-contrast text (e.g., light gray text on cream-colored background)
- Low-contrast icons (e.g., dark icons on dark backgrounds without a contrasting circle)
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content

For each slide, list issues or areas of concern, even if minor.

Read and analyze these images:
1. /path/to/slide-01.jpg (Expected: [brief description])
2. /path/to/slide-02.jpg (Expected: [brief description])

Report ALL issues found, including minor ones.
```

### Verification Loop

1. Generate slides → Convert to images → Inspect
2. **List issues found** (if none found, look again more critically)
3. Fix issues
4. **Re-verify affected slides** — one fix often creates another problem
5. Repeat until a full pass reveals no new issues

**Do not declare success until you've completed at least one fix-and-verify cycle.**

---

## Converting to Images

Convert presentations to individual slide images for visual inspection:

```bash
python scripts/office/soffice.py --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
```

This creates `slide-01.jpg`, `slide-02.jpg`, etc.

> `Warning: failed to launch javaldx` on stderr is **harmless** (the ACS image ships LibreOffice without a JRE; Impress→PDF does not need Java). Ignore it — do not spend time "fixing" it.

To re-render specific slides after fixes:

```bash
pdftoppm -jpeg -r 150 -f N -l N output.pdf slide-fixed
```

---

## CJK Typography (Chinese decks)

- **Font choice**: for decks the client will open in PowerPoint on Windows, set Chinese text to `Microsoft YaHei`（微软雅黑）— guaranteed on client machines. The ACS sandbox does not have it; LibreOffice silently substitutes **Noto Sans CJK SC** when rendering, so metrics differ slightly between your QA render and the client's screen.
- **Consequence**: a line that wraps cleanly in your PDF render may break differently on the client machine. Leave **≥10% width headroom** in every CJK text box; treat any 1–2 character orphan line as a bug even if it "just fits".
- **Latin fonts**: the image has Liberation (metric-compatible with Arial/Times/Courier) and Carlito/Caladea (metric-compatible with Calibri/Cambria). Fonts like Georgia, Impact, Palatino, Trebuchet MS are **not** in the image — if you use them, your QA render substitutes them and is not what the client sees. Prefer Arial/Calibri/Cambria families when render fidelity matters.
- Do not mix CJK and Latin in one run with a Latin-only font — set the font per language run, or use Microsoft YaHei for mixed runs.

---

## Dependencies

How each dependency is provided **in the ACS sandbox** (source of truth: `acs-orchestrator/requirements/base.txt` + the acs-sandbox image):

- `markitdown[pptx]` — text extraction & content QA; workspace runtime venv (base.txt)
- `defusedxml` — required by **every** script under `scripts/` (unpack/pack/clean/validate/thumbnail/add_slide); workspace runtime venv (base.txt)
- `Pillow`, `python-pptx` — thumbnail grids, geometry QA, fallback creation path; workspace runtime venv (base.txt)
- `pptxgenjs` — creating from scratch; preinstalled in the sandbox image at `/opt/ky-agent/node/node_modules`, resolved via `NODE_PATH` so `require('pptxgenjs')` works from any cwd. Outside ACS, install project-locally (`npm install pptxgenjs`); never global npm installs during a task
- LibreOffice (`soffice`) — PDF conversion (auto-configured via `scripts/office/soffice.py`). The `javaldx` stderr warning is harmless (no JRE in image)
- Poppler (`pdftoppm`, `pdftotext`) — PDF to images / rendered-text QA
- `gcc` — **not** in the ACS image and not needed there (AF_UNIX sockets work; the LD_PRELOAD shim in `soffice.py` never triggers). Only relevant in other sandboxes that block AF_UNIX

If the self-check at the top fails on any of these in ACS, that is an image/venv regression — report it, don't work around it silently.
