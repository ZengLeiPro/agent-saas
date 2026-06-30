---
name: hyperframes-cli
description: HyperFrames CLI dev loop — `npx hyperframes` for scaffolding (init), validation (lint, inspect), preview, render, and environment troubleshooting (doctor, browser, info, upgrade). Use when running any of these commands or troubleshooting the HyperFrames build/render environment. For asset preprocessing commands (`tts`, `transcribe`, `remove-background`), invoke the `hyperframes-media` skill instead.
---

# HyperFrames CLI

Everything runs through `npx hyperframes`. Requires Node.js >= 22 and FFmpeg.

## ACS Workspace Defaults

- New projects go under `assets/yyyymmdd/<project-slug>/`. Run CLI commands from the project directory unless a command explicitly accepts a project path.
- User-facing outputs go under `assets/yyyymmdd/` with readable filenames. From inside a project directory, use `--output ../<name>.mp4` instead of relying on the default `renders/` folder.
- Preview URLs are only useful when the platform exposes the port to the user. If port preview is unavailable, use `inspect`, screenshots, or rendered review files as the handoff surface.
- Do not run Homebrew, `apt-get`, `sudo`, global `npm install`, or system Python installs. If a runtime dependency is missing, run `doctor` and report the image gap.
- Do not use `--docker` by default in ACS. Use it only after explicit user confirmation.
- Prefer `--workers 1` for reliable sandbox memory behavior; raise workers only after a successful draft render.

## Workflow

1. **Create date directory** — `mkdir -p assets/yyyymmdd`
2. **Scaffold** — `cd assets/yyyymmdd && npx hyperframes init my-video`
3. **Write** — author HTML composition (see the `hyperframes` skill)
4. **Lint** — `npx hyperframes lint`
5. **Visual inspect** — `npx hyperframes inspect`
6. **Preview or screenshot** — `npx hyperframes preview` only if port preview is usable
7. **Render** — `npx hyperframes render --workers 1 --output ../my-video.mp4`

Lint and inspect before preview. `lint` catches missing `data-composition-id`, overlapping tracks, and unregistered timelines. `inspect` opens the rendered composition in headless Chrome, seeks through the timeline, and reports text spilling out of bubbles/containers or off the canvas.

## Scaffolding

```bash
cd assets/yyyymmdd
npx hyperframes init my-video                         # interactive wizard
npx hyperframes init my-video --example warm-grain    # pick an example
npx hyperframes init my-video --video ../../uploads/clip.mp4  # with video file
npx hyperframes init my-video --audio ../../uploads/track.mp3 # with audio file
npx hyperframes init my-video --example blank --tailwind      # with Tailwind v4 browser runtime
npx hyperframes init my-video --non-interactive       # skip prompts (CI/agents)
```

Templates: `blank`, `warm-grain`, `play-mode`, `swiss-grid`, `vignelli`, `decision-tree`, `kinetic-type`, `product-promo`, `nyt-graph`.

`init` creates the right file structure, copies media, and may transcribe audio with Whisper. Use it instead of creating files by hand. If the CLI offers to install or modify AI coding skills, keep that operation workspace-local; never let a project scaffold write to the central `skills-pool` or unrelated global skill directories.

When using `--tailwind`, invoke the `tailwind` skill before editing classes or theme tokens. The scaffold uses Tailwind v4.2 via the browser runtime, not Studio's Tailwind v3 setup.

## Linting

```bash
npx hyperframes lint                  # current directory
npx hyperframes lint ./my-project     # specific project
npx hyperframes lint --verbose        # info-level findings
npx hyperframes lint --json           # machine-readable
```

Lints `index.html` and all files in `compositions/`. Reports errors (must fix), warnings (should fix), and info (with `--verbose`).

## Visual Inspect

```bash
npx hyperframes inspect                 # inspect rendered layout over the timeline
npx hyperframes inspect ./my-project    # specific project
npx hyperframes inspect --json          # agent-readable findings
npx hyperframes inspect --samples 15    # denser timeline sweep
npx hyperframes inspect --at 1.5,4,7.25 # explicit hero-frame timestamps
```

Use this after `lint` and `validate`, especially for compositions with speech bubbles, cards, captions, or tight typography. It reports:

- Text extending outside the nearest visual container or bubble
- Text clipped by its own fixed-width/fixed-height box
- Text extending outside the composition canvas
- Children escaping clipping containers

Errors should be fixed before rendering. Warnings are surfaced for agent review; add `--strict` to fail on warnings too. Repeated static issues are collapsed by default so JSON output stays compact for LLM context windows. If overflow is intentional for an entrance/exit animation, mark the element or ancestor with `data-layout-allow-overflow`. If a decorative element should never be audited, mark it with `data-layout-ignore`.

`npx hyperframes layout` remains available as a compatibility alias for the same visual inspection pass.

## Previewing

```bash
npx hyperframes preview                   # serve current directory
npx hyperframes preview --port 4567       # custom port (default 3002)
```

Hot-reloads on file changes. In desktop environments it may open Studio automatically; in ACS, treat the terminal output as the source of truth.

In ACS/headless sessions, do not assume the browser opened or that
`localhost` is visible to the user. Read the CLI output, and only hand back a
Studio URL if the platform exposes that port:

```text
http://localhost:<port>/#project/<project-name>
```

Use the actual port from the preview output and the project directory name. For
example, after `npx hyperframes preview --port 3017` in `codex-openai-video`,
report `http://localhost:3017/#project/codex-openai-video` only when port
preview is available. Otherwise, hand back rendered files or screenshots.

Treat `index.html` as source-code context only. It is fine to link it as an
implementation file, but do not label it as the project or preview surface.

## Rendering

```bash
npx hyperframes render --workers 1 --output ../draft.mp4 # standard MP4 from project dir
npx hyperframes render --workers 1 --output ../final.mp4 # named output from project dir
npx hyperframes render --quality draft                # fast iteration
npx hyperframes render --fps 60 --quality high        # final delivery
npx hyperframes render --format webm                  # transparent WebM
npx hyperframes render --docker                       # local/CI only, not ACS default
```

| Flag                 | Options               | Default                    | Notes                                                              |
| -------------------- | --------------------- | -------------------------- | ------------------------------------------------------------------ |
| `--output`           | path                  | renders/name_timestamp.mp4 | Always set explicitly; in ACS prefer `../name.mp4` from project dir |
| `--fps`              | 24, 30, 60            | 30                         | 60fps doubles render time                                          |
| `--quality`          | draft, standard, high | standard                   | draft for iterating                                                |
| `--format`           | mp4, webm             | mp4                        | WebM supports transparency                                         |
| `--workers`          | 1-8 or auto           | auto                       | Each spawns Chrome; ACS default should be `1`                       |
| `--docker`           | flag                  | off                        | Reproducible output; do not use in ACS unless explicitly requested  |
| `--gpu`              | flag                  | off                        | GPU-accelerated encoding                                           |
| `--strict`           | flag                  | off                        | Fail on lint errors                                                |
| `--strict-all`       | flag                  | off                        | Fail on errors AND warnings                                        |
| `--variables`        | JSON object           | —                          | Override variable values declared in `data-composition-variables`  |
| `--variables-file`   | path                  | —                          | JSON file with variable values (alternative to `--variables`)      |
| `--strict-variables` | flag                  | off                        | Fail render on undeclared keys or type mismatches in `--variables` |

**Quality guidance:** `draft` while iterating, `standard` for review, `high` for final delivery.

**Parametrized renders:** the composition declares its variables on the `<html>` root with **`data-composition-variables`** — a JSON **array of declarations** (`{id, type, label, default}` per entry) that defines the schema. Scripts inside read the resolved values via `window.__hyperframes.getVariables()`. The CLI **`--variables '{"title":"Q4 Report"}'`** is a JSON **object keyed by id** that overrides those declared defaults for one render; missing keys fall through, so the same composition runs unchanged in dev preview and in production. (Sub-comp hosts can also override per-instance with **`data-variable-values`** — same object shape, scoped to one mount of the sub-composition. See the `hyperframes` skill for the full pattern.)

## Asset Preprocessing

`npx hyperframes tts`, `transcribe`, and `remove-background` produce assets (narration audio, word-level transcripts, transparent video) that get dropped into a composition. Each downloads its own model on first run. For voice selection, whisper model rules (the `.en`-translates-non-English gotcha), output format choice (VP9 alpha WebM vs ProRes), and the TTS → transcribe → captions chain, invoke the `hyperframes-media` skill.

## Troubleshooting

```bash
npx hyperframes doctor       # check environment (Chrome, FFmpeg, Node, memory)
npx hyperframes browser      # manage bundled Chrome
npx hyperframes info         # version and environment details
npx hyperframes upgrade      # check for updates
```

Run `doctor` first if rendering fails. Common issues: missing FFmpeg, missing Chrome, low memory. In ACS, missing FFmpeg/Chrome/system libraries are image issues; report them instead of trying to install system packages from the skill.

## Other

```bash
npx hyperframes compositions   # list compositions in project
npx hyperframes docs           # may open external documentation; use only when the user needs docs
npx hyperframes benchmark .    # benchmark render performance
```
