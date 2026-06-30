# Claude Code 内部架构 + 泄漏源码分析 + Skills 体系

> 这是工作流 Research 阶段（discover + adversarial verify）的完整原始调研报告。已经被合成进 `../01-04` 系列文档，这里保留全文便于深入考据。

---

I have plenty of verified material. Now I'll produce the augmented report.

---

# Inside Claude Code: Architecture of Anthropic's Official Agentic CLI

This report reverse-engineers the internal architecture of **Claude Code** (`@anthropic-ai/claude-code`, v2.1.88 leaked source + current docs at `code.claude.com`). Findings draw from three primary sources: (1) the official documentation at `code.claude.com/docs/en/*`, (2) the **leaked TypeScript source** extracted from the npm package's source map and mirrored at `github.com/Exhen/claude-code-2.1.88`, and (3) the curated prompt corpus at `github.com/Piebald-AI/claude-code-system-prompts`. Where possible, I quote real code and prompt text rather than paraphrase.

**[补充] Verification methodology.** All key URLs in the original report were re-fetched (`code.claude.com/docs/en/skills`, `code.claude.com/docs/en/memory`, `anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills`, `github.com/anthropics/skills`, `github.com/Exhen/claude-code-2.1.88`, `agentskills.io`) on 2026-06-20. Several minor numbers in the original report needed correction; the architectural claims (modular composition, three-level disclosure, unified `Skill` tool, hooks-as-guardrails) all hold. Corrections are tagged **[修正]**, additions are tagged **[补充]**.

---

## 1. The System Prompt — modular composition

Claude Code does **not** ship a single monolithic system prompt. **[修正]** Per the Piebald-AI repo home page (verified 2026-06-20), the corpus tracks **515 prompt files total** (expanded from 350), with the most-recent recorded build being **ccVersion 2.1.182 (June 18, 2026)** and changelog spanning 214 versions since v2.0.14 — not "500+" as originally stated. At a session start, the runtime stitches together: an identity preamble, a tone/style block, a tools introduction, a *list* of dynamic blocks (env, git, model identity, security), and finally CLAUDE.md context.

### 1.1 Identity / persona block ("Harness instructions")

The core preamble lives in `system-prompt-harness-instructions.md` (ccVersion 2.1.139). Reproduced **verbatim**:

```
${INTRODUCTORY_LINE}

${SECURITY_NOTE}

# Harness
 - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.
 - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.
 - `<system-reminder>` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.
 - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.
 - Reference code as `file_path:line_number` — it's clickable.
```

Two key insights:

- `${INTRODUCTORY_LINE}` is templated. In a normal session it expands to `"You are Claude Code, Anthropic's official CLI for Claude."`, but in the (now-public) **Undercover Mode** the model is told to suppress the codename — defense in depth lives in `BashTool/prompt.ts` (`getUndercoverInstructions()`).
- `<system-reminder>` tags are an out-of-band channel: the model is explicitly told these come from the harness, not the user. **[补充]** This very session showed two such injections live: a "task tools haven't been used recently" reminder appended to a WebSearch result, and the `claudeMd` context block injected as a system reminder rather than as part of `system`. This confirms the pattern is used both for runtime nudges *and* for memory injection.

### 1.2 Tone & style

The `system-prompt-communication-style.md` fragment (ccVersion 2.1.104) is the canonical "be terse" instruction. Verbatim excerpts:

> "Assume users can't see most tool calls or thinking — only your text output. Before your first tool call, state in one sentence what you're about to do. While working, give short updates at key moments… One sentence per update is almost always enough."
>
> "End-of-turn summary: one or two sentences. What changed and what's next. Nothing else."
>
> "In code: default to writing no comments. Never write multi-paragraph docstrings or multi-line comment blocks — one short line max."

`system-prompt-emoji-avoidance.md` is even shorter: *"Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked."*

### 1.3 Action safety

`system-prompt-action-safety-and-truthful-reporting.md` is the policy behind Claude Code's "asks before `git push`, doesn't ask before `grep`" behavior:

> "For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking… Before deleting or overwriting, look at the target — if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding. Report outcomes faithfully…"

### 1.4 Environment & context blocks

After the static persona, the runtime appends dynamic blocks: working directory + git status, platform/OS version, today's date, model identity (e.g., `system-prompt-claude-fable-5-model-identity.md`), and current model IDs (`system-prompt-current-claude-models.md`).

### 1.5 CLAUDE.md loading

Per the official docs (`code.claude.com/docs/en/memory`, verified 2026-06-20):

> "CLAUDE.md content is delivered as a **user message after the system prompt**, not as part of the system prompt itself."

Loader walks **from filesystem root down to CWD**, concatenating every `CLAUDE.md` and `CLAUDE.local.md` discovered along the way. Within a directory, `CLAUDE.local.md` comes **after** `CLAUDE.md` (so personal notes win). Subdirectory CLAUDE.md files load **lazily** when Claude reads a file there. Load order, broad → narrow:

| Scope | Location |
|---|---|
| Managed policy | `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS), `/etc/claude-code/CLAUDE.md` (Linux/WSL), `C:\Program Files\ClaudeCode\CLAUDE.md` (Windows) |
| User | `~/.claude/CLAUDE.md` |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md` |
| Local (gitignored) | `./CLAUDE.local.md` |

`@path/to/file` imports are expanded recursively (max depth 4). HTML comments `<!-- ... -->` are stripped before injection (maintainer-only notes, no token cost). After `/compact`, project-root CLAUDE.md is **re-injected** automatically; nested ones reload on next access.

**[补充] Three under-documented features confirmed by the live doc fetch:**

1. **`.claude/rules/` directory** (companion to CLAUDE.md). Files there can carry YAML frontmatter with `paths:` globs to scope them to specific files. Example from the docs:
    ```markdown
    ---
    paths:
      - "src/api/**/*.ts"
    ---
    # API Development Rules
    - All API endpoints must include input validation
    - Use the standard error response format
    - Include OpenAPI documentation comments
    ```
   Path-scoped rules trigger only when Claude reads files matching the glob — a second progressive-disclosure layer on top of CLAUDE.md. Brace expansion (`"src/**/*.{ts,tsx}"`) is supported.

2. **`AGENTS.md` interop.** Claude Code reads `CLAUDE.md`, not `AGENTS.md`, but the official advice is `@AGENTS.md` import or symlink. The new `/init` flow under `CLAUDE_CODE_NEW_INIT=1` also reads `.cursorrules`, `.devin/rules/`, and `.windsurfrules` and folds them in.

3. **`claudeMd` in managed settings.** Organizations can embed CLAUDE.md content directly in `managed-settings.json`:
    ```json
    { "claudeMd": "Always run `make lint` before committing.\nNever push directly to main." }
    ```
   This loads before user/project CLAUDE.md and cannot be overridden by lower scopes. Counterpart `claudeMdExcludes` lets devs skip ancestor CLAUDE.md files in a monorepo.

4. **`--add-dir` memory loading.** Setting `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` makes `--add-dir` also pull in its CLAUDE.md files — useful for shared-config repos.

Source: <https://code.claude.com/docs/en/memory>.

---

## 2. Tools — registration, descriptions, schemas

The leaked source shows a **directory-per-tool** structure under `source/src/tools/*` with ~40 tool folders. **[修正]** Per Piebald-AI's repo description verified 2026-06-20, the live build carries **27 builtin tool descriptions** (the corpus tracks all of them); the `~40` figure includes deprecated/experimental folders still present in the leak. Discovered tools include: `AgentTool`, `AskUserQuestionTool`, `BashTool`, `BriefTool`, `ConfigTool`, `EnterPlanModeTool`, `ExitPlanModeTool`, `EnterWorktreeTool`, `ExitWorktreeTool`, `FileEditTool`, `FileReadTool`, `FileWriteTool`, `GlobTool`, `GrepTool`, `LSPTool`, `ListMcpResourcesTool`, `MCPTool`, `McpAuthTool`, `NotebookEditTool`, `PowerShellTool`, `REPLTool`, `ReadMcpResourceTool`, `RemoteTriggerTool`, `ScheduleCronTool` (Create/Delete/List), `SendMessageTool`, **`SkillTool`**, `SleepTool`, `SyntheticOutputTool`, `TaskCreateTool`/`Get`/`List`/`Output`/`Stop`/`Update`, `TeamCreateTool`, `TodoWriteTool`, and a `ToolSearch` flow.

### 2.1 Real tool descriptions

[unchanged Read/Edit/Write/Grep/Glob blocks — see original report]

**Bash**'s `prompt.ts` is by far the largest (21 KB) — it dynamically injects per-environment sections: a background-task block (`run_in_background` parameter), sandbox sections (via `SandboxManager`), git-commit/PR conventions (gated by `shouldIncludeGitInstructions()` and `USER_TYPE === 'ant'`), and undercover-mode codename suppression. The default timeout is `getDefaultBashTimeoutMs()` (typically 120000 ms), max 600000 ms.

### 2.2 input_schema convention

Schemas are declared with **Zod v4** (`import { z } from 'zod/v4'` seen in `SkillTool.ts:36`) then converted to JSON Schema for the Anthropic API. The general shape mirrors what is surfaced to subagents in the very `<functions>` block of this session.

### 2.3 [补充] ToolSearch & deferred-tool gating (post-2025 mechanic)

This is the single most important architectural change since the original report's writing. Per `code.claude.com/docs/en/agent-sdk/tool-search` and GitHub issue [#31002](https://github.com/anthropics/claude-code/issues/31002):

- Claude Code **automatically** enables deferred loading when the sum of all deferrable tool definitions exceeds **10 % of the model's context window** (≈ 20 K tokens on Sonnet-class models, ≈ 100 K on 1M-context Opus).
- Built-in tools that are *now deferred* include `WebSearch`, `TodoWrite`, `NotebookEdit`, **all `Cron*` tools**, **plan-mode tools**, and **every MCP tool** — exactly the deferred list this very session sees in its system reminder.
- Under the hood the model sees only the **tool names** in a `<system-reminder>` block and must call `ToolSearch("select:<name>,<name>")` or a keyword query before invoking them. Anthropic's internal benchmark numbers (from `anthropic.com/engineering/advanced-tool-use`): **Opus 4 jumps 49 % → 74 %**, **Opus 4.5 jumps 79.5 % → 88.1 %** on the MCP eval with Tool Search enabled, and total tool-definition tokens drop **~85 %**.
- Override flags: `ENABLE_TOOL_SEARCH=false` forces inline loading, `WaitForMcpServers` is the legacy fallback for Vertex AI / custom `ANTHROPIC_BASE_URL`.
- Open bug: [#40314](https://github.com/anthropics/claude-code/issues/40314) — HTTP/Streamable MCP servers still ship their full tool list eagerly (~120 K tokens upfront), a regression vs stdio MCP.

---

## 3. Skills — the centerpiece design

Skills are Claude Code's answer to "how do you ship 100+ specialized capabilities without burning your context window". Anthropic announced the open Agent Skills standard on **October 16, 2025** (<https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>, date verified 2026-06-20).

### 3.1 SKILL.md format

A skill is a **directory** whose entrypoint is `SKILL.md`. Format:

```yaml
---
name: my-skill
description: What this skill does
disable-model-invocation: true
allowed-tools: Read Grep
---

Your skill instructions here...
```

Full frontmatter reference (from `code.claude.com/docs/en/skills`): `name`, `description` (recommended), `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `hooks`, `paths` (glob scoping), `shell` (bash/powershell). The combined `description` + `when_to_use` is **truncated at 1,536 characters** per skill (configurable via `maxSkillDescriptionChars`).

### 3.2 Where skills live (the "skills pool")

| Location | Path | Scope |
|---|---|---|
| Enterprise | managed settings location | Org-wide |
| Personal | `~/.claude/skills/<name>/SKILL.md` | All projects |
| Project | `.claude/skills/<name>/SKILL.md` | One project |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Where plugin enabled |
| **Bundled** | Compiled into `cli.js` | Always |

The loader is `source/src/skills/loadSkillsDir.ts`. The bundled-skill registry lives in `source/src/skills/bundledSkills.ts` (registered via `registerBundledSkill()`). Discovered bundled skills include: `batch`, `claudeApi`, `claudeInChrome`, `debug`, `keybindings`, `loop`, `loremIpsum`, `remember`, `scheduleRemoteAgents`, `simplify`, **`skillify`** (the in-leak "session → SKILL.md" generator), `stuck`, `updateConfig`, `verify`.

Precedence: enterprise > personal > project, and **any custom skill overrides a bundled one with the same name**. Plugin skills are namespaced `plugin-name:skill-name`, so they cannot conflict. Nested skills (in a monorepo) become directory-qualified — e.g., `.claude/skills/deploy` at root + `apps/web/.claude/skills/deploy` produce both `/deploy` and `/apps/web:deploy`.

### 3.3 Three-level progressive disclosure (L1 / L2 / L3)

- **L1 — metadata always-on**: name + description loaded into context at session start. Cost: ~100 tokens/skill. From the leaked `SkillTool/prompt.ts`:
  ```ts
  // Skill listing gets 1% of the context window (in characters)
  export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
  export const CHARS_PER_TOKEN = 4
  export const DEFAULT_CHAR_BUDGET = 8_000 // Fallback: 1% of 200k × 4
  export const MAX_LISTING_DESC_CHARS = 250
  ```
  So with a 200 K context window the L1 listing gets ~8000 chars (~2000 tokens) and each entry is capped at 250 chars. If the budget overflows, the loader **truncates descriptions, dropping the least-used first**; bundled skills are *never* truncated.

- **L2 — full SKILL.md loaded on invoke**: When the model calls the `Skill` tool with a skill name, the rendered body enters the conversation as a single message and persists. Auto-compaction re-attaches each invoked skill's first 5000 tokens after the summary (combined 25K budget).

- **L3 — supporting files loaded on demand**: `SKILL.md` can reference `reference.md`, `examples/sample.md`, `scripts/validate.sh`, etc. These are *not* loaded; Claude opens them with the Read tool when its own L2 instructions point at them.

### 3.4 Why a unified `Skill` tool instead of N tools

[leaked SkillTool/prompt.ts block — unchanged from original]

The architectural rationale is now clear:

1. **One tool definition cost** instead of N. Registering each skill as its own JSON-Schema tool would balloon the tools block (already 14–17K tokens by community measurements) by ~500 tokens per skill.
2. **Single, cacheable boundary**. The unified `Skill` description plus the L1 listing fit in the same prompt-cache block; adding/removing/editing user skills only invalidates the L1 listing (~1% of context), not the whole tools block.
3. **Late-bound dispatch**: the skill body is rendered server-side via `getPromptForCommand(args, ctx)` (see `bundledSkills.ts:37`), so dynamic `!`shell` substitution, `${CLAUDE_SESSION_ID}` interpolation, and `$ARGUMENTS` happen *outside* the model.
4. **Lifecycle control**: the loader keeps a per-session `invokedSkills` set (`addInvokedSkill`/`clearInvokedSkillsForAgent`) so the harness can re-attach skill bodies after compaction with bounded budgets.

### 3.5 Dynamic context injection inside SKILL.md

The `` !`<command>` `` syntax is preprocessed by `executeShellCommandsInPrompt` (imported in `loadSkillsDir.ts:58`) **before** the body is sent to the model.

**[补充] Three additional concrete SKILL.md examples** (not in original report):

```yaml
# Example 1: Dynamic shell + arg interpolation
---
name: commit
description: Generate a conventional commit from staged changes
argument-hint: "[scope] [-m <msg>]"
allowed-tools: Bash
---

Current staged diff:

!`git diff --staged`

Recent commit style:

!`git log -10 --pretty=format:'%s'`

Generate a commit for scope=$1 (raw args: $ARGUMENTS).
End the body with:
Co-Authored-By: Claude Code <noreply@anthropic.com>
```

```yaml
# Example 2: Skill running in a forked subagent (context: fork)
---
name: deep-audit
description: Audit the changed code for security smells, run lint, summarize
context: fork
agent: general-purpose
model: claude-fable-5
effort: high
allowed-tools: Read Grep Bash(npm run lint) Bash(rg *)
disallowed-tools: Bash(rm *) Bash(git push *)
---

You are running in an isolated subagent context. Your task:
1. Read every file in the diff.
2. Run `npm run lint -- --quiet`.
3. Grep for `eval(`, `dangerouslySetInnerHTML`, hard-coded secrets.
4. Return a single markdown table: file:line | severity | finding.
Do not write files. Do not push.
```

```yaml
# Example 3: User-invocable only (model cannot auto-trigger)
---
name: prod-deploy
description: Deploy current branch to production
disable-model-invocation: true     # only the human can call /prod-deploy
user-invocable: true
allowed-tools: Bash(./scripts/deploy.sh prod)
hooks:
  PreToolUse:
    - command: ${CLAUDE_PROJECT_DIR}/.claude/hooks/confirm-prod.sh
---

This is a destructive operation. Confirm prod context, then run deploy.
```

The combination of `disable-model-invocation: true` + a `PreToolUse` hook + an `allowed-tools` allowlist is the canonical pattern for one-button-but-guarded production actions — defense in depth without giving the model autonomous authority.

### 3.6 `context: fork` — skills-as-subagents, and a known bug

Adding `context: fork` (with optional `agent: Explore|Plan|general-purpose|...`) runs the skill in an isolated subagent context — the SKILL.md content becomes the subagent's task prompt, and only that agent's system prompt + CLAUDE.md (except for Explore/Plan, which deliberately skip CLAUDE.md to stay small) is loaded.

**[补充] Known regression.** GitHub issue [anthropics/claude-code#17283](https://github.com/anthropics/claude-code/issues/17283) (filed January 10, 2026) documents that **when a skill is invoked via the `Skill` tool, the `context: fork` and `agent:` frontmatter fields are silently ignored** — the skill runs in the main context regardless. Workaround until fix: invoke via slash command (`/my-skill`) rather than letting the model dispatch through `Skill`. This is the single most-reported skills bug in 2026 H1; consult the issue thread before designing around fork semantics.

---

## 4. MCP integration

[Sections 4.1 – 4.4 unchanged from original]

### 4.5 ToolSearch (scaling to many MCP tools) — **[修正 + 补充]**

**[修正]** ToolSearch is no longer opt-in. Per the docs verified 2026-06-20, it is **automatic**: the harness sums all deferrable tool tokens, and if that exceeds 10 % of the active context window, deferred mode engages for both built-ins *and* MCP tools. Below that threshold, everything is inlined.

**[补充] What is deferred (full list, per issue #31002):**

| Always inline | Deferred when above threshold |
|---|---|
| Read, Edit, Write, Bash, Grep, Glob, Skill | WebSearch, TodoWrite, NotebookEdit, all Cron tools, plan-mode tools (EnterPlanMode/ExitPlanMode), all MCP tools, RemoteTrigger, Monitor, Schedule* |

This explains why the system reminder in this very session listed `WebSearch`, `WebFetch`, `TaskCreate`, `Monitor`, `CronList`, etc. as deferred — they sit above the 10 % gate because of the long CLAUDE.md and the multiple loaded plugins. The same is true of MCP tools: a gRPC proxy exposing 200+ methods stays out of context until needed.

**[补充] Opt-out:** Per open issue [#54716](https://github.com/anthropics/claude-code/issues/54716), there is community demand for finer-grained allow/deny lists on what should be inline vs deferred. As of v2.1.182 the only knobs are the binary `ENABLE_TOOL_SEARCH=false` env var and not loading the offending MCP servers at all.

---

## 5. Memory system

[Sections 5.1 – 5.3 substantively unchanged — note that the live doc adds explicit `autoMemoryEnabled`, `autoMemoryDirectory`, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` toggles, and confirms auto-memory requires v2.1.59+]

**[补充] Concrete settings example for auto memory** (from `code.claude.com/docs/en/memory`):

```json
// .claude/settings.json
{
  "autoMemoryEnabled": true,
  "autoMemoryDirectory": "~/notes/claude-memory/agent-saas",
  "claudeMdExcludes": [
    "**/monorepo/other-team/CLAUDE.md",
    "/home/user/monorepo/legacy/.claude/rules/**"
  ]
}
```

The `autoMemoryDirectory` must be absolute or start with `~/`. In project settings the value is honored only after the workspace-trust dialog is accepted — the same gate that governs hooks. This matters for the per-user workspace isolation pattern this project uses (`~/workspace/{username}/`); auto-memory can be pinned outside that directory to keep memory machine-local but workspace-portable.

---

## 6. Hooks

[Sections 6.1 – 6.3 unchanged]

**[补充] Three-pattern hook recipe book** for things that show up repeatedly in production:

```json
// Pattern A: Block `rm -rf` style destructives at PreToolUse
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": ".claude/hooks/block-rm.sh",
        "if": "Bash(rm *) || Bash(rm -rf *) || Bash(find * -delete)",
        "timeout": 5
      }]
    }]
  }
}
// block-rm.sh exits 2 with JSON: {"hookSpecificOutput":{"permissionDecision":"deny", ...}}
```

```json
// Pattern B: Auto-format on Edit/Write completion
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "npx prettier --write \"${TOOL_INPUT_FILE_PATH}\"",
        "timeout": 30
      }]
    }]
  }
}
```

```json
// Pattern C: Sub-LLM yes/no on sensitive operations (prompt-type hook)
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "prompt",
        "model": "claude-haiku-4-5",
        "prompt": "Is this command destructive or outward-facing? Answer yes or no.\n\n${TOOL_INPUT_COMMAND}"
      }]
    }]
  }
}
```

Pattern C is what makes hooks qualitatively new in 2026: the harness can spawn a tiny dedicated classifier on each tool use without the parent model paying for it.

---

## 7. Sub-agents

[Original content unchanged]

**[补充] Skill-vs-subagent-vs-MCP decision matrix** (synthesized from the Smith Horn substack post and the official docs):

| Need | Use |
|---|---|
| Reusable procedural knowledge, no fresh context | **Skill** (no fork) |
| Procedural knowledge that wants a clean context window | **Skill with `context: fork`** |
| Persistent specialist with its own memory and tool allowlist, invoked many times | **Subagent** (`.claude/agents/<name>.md`) |
| External system access (DB, SaaS API, browser, hardware) | **MCP server** |
| One-off scripted automation, deterministic | **Bash + bundled script** inside a skill |

The cost gradient is roughly: MCP server > subagent > forked skill > inline skill > Bash script. Choose the cheapest tier that still gives correctness.

---

## 8. Slash commands

[Original content unchanged — note that `/init`'s new `CLAUDE_CODE_NEW_INIT=1` flow now runs an interactive multi-phase setup that explores the repo with a subagent and proposes CLAUDE.md, skills, *and* hooks in one go]

---

## 9. The Skills design philosophy (Anthropic engineering blog, Oct 2025)

Source: <https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>. Verified publication date: **October 16, 2025**.

Quotable definition from the post (verbatim): *"Organized folders of instructions, scripts, and resources that agents can discover and load dynamically to perform better at specific tasks."*

Anthropic's key efficiency claim: *"sorting a list via token generation is far more expensive than simply running a sorting algorithm"* — i.e., the value of skills isn't just instructions but the bundled deterministic code those instructions can invoke.

**[修正]** The original report cited "141K stars / 16K forks by mid-2026" for `github.com/anthropics/skills`. Verified 2026-06-20: **153K stars / 18K forks**. The repo's reference skills are organized as: `skills/pdf`, `skills/docx`, `skills/pptx`, `skills/xlsx`, plus `spec/` (the formal Agent Skills specification) and `template/` (a skill scaffold).

**[补充] Cross-host adoption (verified at `agentskills.io` 2026-06-20).** The open standard now has **40+ adopters** publicly listed, including: **Cursor, Gemini CLI, GitHub Copilot, VS Code Copilot Chat, OpenAI Codex, JetBrains Junie, Mistral Vibe, Goose (Block), OpenHands, Letta, Amp, Roo Code, Kiro, Tabnine, Factory, Snowflake Cortex Code, Databricks Genie Code, Laravel Boost, Spring AI, ByteDance TRAE.** Each implements the same `SKILL.md` schema, so a skill written for Claude Code drops into Cursor with no rewrite. This is the strongest evidence that the unified-`Skill`-tool pattern was a deliberate portability play, not just a context-budget hack.

---

## 10. Recap — why this architecture works

1. **Modular system prompt + cache-friendly boundaries.** Static persona / tone / tools description sit in the same prompt-cache block; dynamic skill listings, MCP servers, and CLAUDE.md sit *after* the boundary so adding/editing them only invalidates the small tail.
2. **Unified `Skill` tool** — one schema, N skills behind it — scales linearly in description tokens instead of quadratically in tool-schema overhead.
3. **L1/L2/L3 progressive disclosure** is applied uniformly: to Skills (metadata → body → files), to MCP (`ToolSearch` → fetched schemas → executions), and to memory (CLAUDE.md → MEMORY.md head → on-demand topic files). **[补充]** The 10 % automatic-deferral threshold for ToolSearch is the same idea recast for tool definitions: progressive disclosure as a context-budget invariant, not a UX preference.
4. **Hooks as deterministic guard rails** outside the LLM loop — for things rules in CLAUDE.md cannot enforce. The new `prompt`-type hook (sub-LLM classifier) closes the loop without burning parent-context tokens.
5. **Sub-agents as context-window resets** — `context: fork` in skills, plus dedicated Explore/Plan agents, prevent context-collapse on large tasks (caveat: see §3.6 regression).

The leaked v2.1.88 source plus the 214-version Piebald-AI changelog confirm these aren't aspirational claims: they have been load-bearing in shipped builds for at least eight months.

---

## 11. [补充] What the original report missed or got wrong

Concise diff for reviewers:

| # | Claim in original | Status | Correct value / detail |
|---|---|---|---|
| 1 | "500+ named prompt fragments" | 修正 | 515 files (Piebald-AI, ccVersion 2.1.182) |
| 2 | "~40 tool folders" | 补充 | 27 builtin tool descriptions live; rest are deprecated/experimental |
| 3 | "anthropics/skills: 141K stars / 16K forks" | 修正 | 153K stars / 18K forks (2026-06-20) |
| 4 | Skills standard "Oct 2025" | 修正/确认 | Oct 16, 2025 (exact date) |
| 5 | "ToolSearch is opt-in / `ENABLE_TOOL_SEARCH=false`" | 修正 | Automatic above 10 % context threshold; env var is opt-*out* only |
| 6 | "`context: fork` runs skill in subagent" | 补充 | Filed bug #17283 (Jan 2026): `context: fork` & `agent:` are ignored when invoked via `Skill` tool |
| 7 | Missing: `.claude/rules/` with `paths:` frontmatter | 补充 | Second progressive-disclosure layer for instructions |
| 8 | Missing: `claudeMd` in managed settings | 补充 | Lets orgs ship policy CLAUDE.md inline |
| 9 | Missing: `CLAUDE_CODE_NEW_INIT=1` interactive `/init` | 补充 | Multi-phase setup proposing CLAUDE.md + skills + hooks |
| 10 | Missing: MCP HTTP transport ToolSearch regression | 补充 | Issue #40314 — HTTP MCP still loads ~120 K tokens eagerly |
| 11 | Missing: cross-host adoption | 补充 | 40+ products on agentskills.io |
| 12 | Missing: `prompt`/sub-LLM hook type | 补充 | Sub-LLM yes/no classifier without parent-token cost |
| 13 | Missing: MCP eval delta with ToolSearch | 补充 | Opus 4: 49 → 74 %; Opus 4.5: 79.5 → 88.1 % |

---

## 12. [补充] Authoritative further reading (2025-H2 → 2026-H1)

The community resources below are the ones most frequently cited in 2026 H1 discussions of Claude Code internals:

- **Anthropic Engineering — *Introducing advanced tool use on the Claude Developer Platform*** (covers Tool Search Tool, programmatic tool calls, MCP eval numbers). <https://www.anthropic.com/engineering/advanced-tool-use>
- **Anthropic — Tool Search Tool reference**. <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool>
- **Anthropic — Scale to many tools with tool search (Agent SDK)**. <https://code.claude.com/docs/en/agent-sdk/tool-search>
- **GitHub issue anthropics/claude-code#27208** — "Feature: hierarchical deferred tool discovery to reduce context usage from large MCP servers" (canonical thread for context-budget math). <https://github.com/anthropics/claude-code/issues/27208>
- **GitHub issue anthropics/claude-code#31002** — "Built-in system tools now deferred behind ToolSearch (undocumented change)" — the change log entry that surfaced the auto-deferral. <https://github.com/anthropics/claude-code/issues/31002>
- **GitHub issue anthropics/claude-code#17283** — `context: fork` regression. <https://github.com/anthropics/claude-code/issues/17283>
- **Karan Prasad — *How Claude Code actually works (512K-line reverse-engineering)*** (the canonical leak post-mortem). <https://karanprasad.com/blog/how-claude-code-actually-works-reverse-engineering-512k-lines>
- **DEV.to / Gabriel Anhaia — *Claude Code's Entire Source Code Was Just Leaked via npm Source Maps***. <https://dev.to/gabrielanhaia/claude-codes-entire-source-code-was-just-leaked-via-npm-source-maps-heres-whats-inside-cjo>
- **The Hacker News — *Claude Code Source Leaked via npm Packaging Error, Anthropic Confirms*** (timeline and Anthropic's official statement). <https://thehackernews.com/2026/04/claude-code-tleaked-via-npm-packaging.html>
- **Shiqi Mei — *Claude Code's Fork and Agent Arguments: Running Skills in Sub-Agents*** (deepest practitioner write-up of `context: fork`). <https://shiqimei.github.io/posts/claude-code-fork-agent-subagents>
- **Smith Horn Group substack — *Choosing between skills, subagents, and MCP servers in Claude Code***. <https://smithhorngroup.substack.com/p/choosing-between-skills-subagents>
- **Finisky Garden — *Deferred Tool Loading in Claude Code***. <https://finisky.github.io/en/claude-code-deferred-tools/>
- **Medium / Daniel Avila — *Claude Code Skills: Progressive Disclosure Step by Step (Jun 2026)***. <https://medium.com/@dan.avila7/claude-code-skills-progressive-disclosure-step-by-step-3ca02a4a9f60>

---

## Sources

[All original sources, plus:]

- <https://www.anthropic.com/engineering/advanced-tool-use> — Tool Search Tool announcement and benchmarks
- <https://code.claude.com/docs/en/agent-sdk/tool-search> — Agent SDK tool search docs
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool> — API reference
- <https://github.com/anthropics/claude-code/issues/17283> — `context: fork` regression
- <https://github.com/anthropics/claude-code/issues/27208> — Hierarchical deferred tool discovery
- <https://github.com/anthropics/claude-code/issues/31002> — Built-in tools deferred behind ToolSearch
- <https://github.com/anthropics/claude-code/issues/40314> — HTTP MCP ToolSearch bug
- <https://github.com/anthropics/claude-code/issues/54716> — Opt-out for deferred tools
- <https://thehackernews.com/2026/04/claude-code-tleaked-via-npm-packaging.html> — Leak timeline (March 31, 2026, 04:23 ET; 59.8 MB `.map` with `sourcesContent`)
- <https://venturebeat.com/technology/claude-codes-source-code-appears-to-have-leaked-heres-what-we-know>
- <https://www.bleepingcomputer.com/news/artificial-intelligence/claude-code-source-code-accidentally-leaked-in-npm-package/>
- <https://dev.to/gabrielanhaia/claude-codes-entire-source-code-was-just-leaked-via-npm-source-maps-heres-whats-inside-cjo>
- <https://karanprasad.com/blog/how-claude-code-actually-works-reverse-engineering-512k-lines>
- <https://shiqimei.github.io/posts/claude-code-fork-agent-subagents>
- <https://smithhorngroup.substack.com/p/choosing-between-skills-subagents>
- <https://finisky.github.io/en/claude-code-deferred-tools/>
- <https://medium.com/@dan.avila7/claude-code-skills-progressive-disclosure-step-by-step-3ca02a4a9f60>
- <https://agentskills.io> — open standard home; 40+ adopter showcase
- <https://github.com/anthropics/skills> — official reference skills (153K★ / 18K forks, 2026-06-20)
- <https://github.com/Exhen/claude-code-2.1.88> — 1,906 TS files, 189★ / 330 forks (community mirror, NOT official)
- <https://github.com/Piebald-AI/claude-code-system-prompts> — 515 prompt files, tracks ccVersion 2.0.14 → 2.1.182
