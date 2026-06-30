---
name: browser
description: "Browser automation via playwright-cli commands. Use when tasks involve browsing web pages, interacting with page elements, taking screenshots, filling forms, clicking buttons, extracting web content, or checking website status. Preserves login sessions, cookies, and fingerprints via per-user Chrome profiles. All operations are Bash calls to playwright-cli."
allowed-tools: "Bash(playwright-cli:*), Bash(curl:*)"
---

# Browser Automation with playwright-cli

CLI-based browser automation. All commands run via Bash tool as `playwright-cli <command>`.

## Setup

ACS Sandbox should already provide `playwright-cli` and the internal browser lifecycle API. See [references/setup.md](references/setup.md) only for diagnostics; do not install global packages during a task.

## Connection Mode (CDP)

All users use **CDP mode**. The platform sets `PLAYWRIGHT_MCP_CDP_ENDPOINT` automatically. Workflow: ensure browser → open → use → close → stop.

```bash
# headed: false(默认,无头) / true(有窗口,可观察操作过程)
curl -sf -X POST http://localhost:3000/internal/browser/ensure -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\"}"
playwright-cli -s=<name> open [url]
# ... use browser ...
playwright-cli -s=<name> close
curl -sf -X POST http://localhost:3000/internal/browser/stop -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\"}"
```

Do NOT pass `--profile` or `--user-data-dir` flags; browser isolation is enforced by the platform automatically.

## Critical Rules

1. **Always ensure browser before opening** — call the ensure API first and verify it returns `"ok": true` before proceeding to `open`. Do NOT add `--profile` or `--user-data-dir` flags
2. **Always quote URLs with single quotes** — URLs containing `?`, `&`, `#`, `=`, or other special characters will be mangled by the shell (zsh treats `?` as a glob). Always wrap URLs in single quotes: `playwright-cli -s=<name> goto 'https://example.com/page?id=123&lang=en'`
3. **Always use named sessions with random suffix (`-s=<task>-<random>`)** — every command must include a unique session name. Format: descriptive task name + hyphen + 6-character random suffix, e.g. `-s=search-k8x2m9`, `-s=login-p3f7w1`. The random suffix prevents collisions when multiple agents run concurrently. Without a unique `-s=`, agents share sessions and cause race conditions
4. **Verify navigation succeeded** — after `goto`, check the `Page URL` in the output. If it still shows `about:blank` or the previous URL, the navigation failed. Common cause: URL not quoted (see rule 2)
5. **Always snapshot before interacting** — element refs (`e1`, `e2`, ...) are ONLY valid from the most recent snapshot
6. **Re-snapshot after any page change** — clicking links, navigating, form submission all invalidate old refs
7. **Never reuse old refs** — always get fresh ones from a new snapshot
8. **Prefer snapshot over screenshot** — snapshots return structured ARIA text (token-efficient); use screenshot only for visual confirmation. Do NOT rely on screenshots for element targeting
9. **Screenshot = file → view** — save user-visible screenshots under `assets/yyyymmdd/browser/`, then view them with the current environment's image/file viewer: `playwright-cli -s=<name> screenshot --filename=assets/20260630/browser/page.png`
10. **Close your tabs before closing the session** — **You MUST run `tab-list` first, then `tab-close` every tab you created, then call `close`**. Only close tabs you opened via `tab-new` or `goto`
11. **Don't close user's existing tabs** — only close tabs you opened. Never close pre-existing user tabs
12. **Never use `kill-all` or `close-all`** — these commands kill ALL sessions including those belonging to other agents running concurrently. Only close your own session with `playwright-cli -s=<your-session> close`

## Standard Workflow

```bash
# 1. Ensure browser is running
curl -sf -X POST http://localhost:3000/internal/browser/ensure -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\"}"

# 2. Open browser session
playwright-cli -s=task-abc open

# 3. Navigate to target (ALWAYS quote URLs!)
playwright-cli -s=task-abc goto 'https://example.com/page?id=123'
# ⚠ Check output: "Page URL" must match the target. If it still shows
#   about:blank or the previous URL, navigation failed (likely unquoted URL).

# 4. Snapshot to get element refs
playwright-cli -s=task-abc snapshot

# 5. Interact using refs from snapshot
playwright-cli -s=task-abc click e5
playwright-cli -s=task-abc fill e3 "search query"

# 6. Re-snapshot after interaction (refs are now stale!)
playwright-cli -s=task-abc snapshot

# 7. Repeat until task is complete

# 8. Screenshot for visual confirmation (optional)
playwright-cli -s=task-abc screenshot --filename=assets/20260630/browser/result.png
# View the screenshot with the current environment's image/file viewer

# 9. Close tabs: MUST tab-list first, then tab-close each
playwright-cli -s=task-abc tab-list          # check which tabs exist
playwright-cli -s=task-abc tab-close         # close current tab (repeat for each)

# 10. Close session
playwright-cli -s=task-abc close

# 11. Stop browser when done (release resources)
curl -sf -X POST http://localhost:3000/internal/browser/stop -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\"}"
```

## Core Commands

### Navigation
```bash
playwright-cli goto '<url>'             # ALWAYS quote the URL
playwright-cli go-back
playwright-cli go-forward
playwright-cli reload
```

### Interaction (require ref from latest snapshot)
```bash
playwright-cli click <ref>              # click element
playwright-cli click <ref> right        # right-click
playwright-cli dblclick <ref>           # double-click
playwright-cli fill <ref> "text"        # clear + fill text input
playwright-cli type "text"              # type into focused element
playwright-cli type "text" --submit     # type and press Enter
playwright-cli select <ref> "value"     # select dropdown option
playwright-cli hover <ref>             # hover over element
playwright-cli check <ref>             # check checkbox/radio
playwright-cli uncheck <ref>           # uncheck checkbox
playwright-cli drag <startRef> <endRef> # drag and drop
playwright-cli upload uploads/file.ext  # file upload from workspace uploads/
```

### Keyboard
```bash
playwright-cli press Enter
playwright-cli press Tab
playwright-cli press ArrowDown
playwright-cli press Escape
playwright-cli press Control+a          # modifier keys
playwright-cli keydown Shift
playwright-cli keyup Shift
```

### Mouse (coordinate-based, use only when refs are unavailable)
```bash
playwright-cli mousemove 150 300
playwright-cli mousedown
playwright-cli mouseup
playwright-cli mousewheel 0 100         # scroll down
```

### Page State
```bash
playwright-cli snapshot                            # ARIA tree to stdout
playwright-cli snapshot --filename=state.yaml      # save to file
playwright-cli screenshot                          # auto-named PNG
playwright-cli screenshot --filename=assets/20260630/browser/page.png # to specific file
playwright-cli screenshot --full-page              # full scrollable page
playwright-cli screenshot <ref>                    # screenshot element
playwright-cli pdf --filename=page.pdf             # save as PDF
```

### JavaScript
```bash
playwright-cli eval "document.title"
playwright-cli eval "() => document.querySelectorAll('a').length"
playwright-cli eval "(el) => el.textContent" <ref>
```

### Dialogs
```bash
playwright-cli dialog-accept
playwright-cli dialog-accept "confirmation text"
playwright-cli dialog-dismiss
```

### DevTools
```bash
playwright-cli console              # view console messages
playwright-cli console warning      # filter by level
playwright-cli network              # list network requests
playwright-cli resize 1920 1080     # resize viewport
```

## Tabs

```bash
playwright-cli tab-list              # list all tabs
playwright-cli tab-new               # open blank tab
playwright-cli tab-new 'https://url' # open tab with URL (quote it!)
playwright-cli tab-select 0          # switch to tab by index
playwright-cli tab-close             # close current tab
playwright-cli tab-close 2           # close tab by index
```

## Session Management

```bash
playwright-cli list                     # list all active sessions
playwright-cli -s=<name> close          # close YOUR session (always use this)
# ⚠ DO NOT use close-all or kill-all — they kill other agents' sessions too
```

## Snapshots

After each command, playwright-cli outputs a snapshot of the current page state. You can also request one explicitly:

```bash
playwright-cli snapshot
```

Output format:
```
### Page
- Page URL: https://example.com/
- Page Title: Example Domain
### Snapshot
[Snapshot](.playwright-cli/page-2026-02-14T19-22-42-679Z.yml)
```

Snapshot files accumulate in `.playwright-cli/` in the working directory. Use `--filename=` to save to a specific path.

## Screenshot Viewing

Screenshots are saved as PNG files. To view:
```bash
playwright-cli screenshot --filename=assets/20260630/browser/screenshot.png
```
Then view the image with the current environment's image/file viewer.

Do NOT rely on screenshots for element targeting — always use snapshot refs instead.

## Example: Login and Extract Data

```bash
curl -sf -X POST http://localhost:3000/internal/browser/ensure -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\"}"
playwright-cli -s=login open
playwright-cli -s=login goto 'https://app.example.com/login'
playwright-cli -s=login snapshot
playwright-cli -s=login fill e1 "user@example.com"
playwright-cli -s=login fill e2 "password123"
playwright-cli -s=login click e3                    # Submit button
playwright-cli -s=login snapshot                    # Re-snapshot after page change
playwright-cli -s=login goto 'https://app.example.com/dashboard'
playwright-cli -s=login snapshot
playwright-cli -s=login eval "() => document.querySelector('.stats').textContent"
playwright-cli -s=login tab-list             # check tabs before closing
playwright-cli -s=login tab-close            # close the tab
playwright-cli -s=login close
curl -sf -X POST http://localhost:3000/internal/browser/stop -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\"}"
```

## Example: Multi-tab Workflow

```bash
curl -sf -X POST http://localhost:3000/internal/browser/ensure -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\"}"
playwright-cli -s=tabs open
playwright-cli -s=tabs goto 'https://example.com'
playwright-cli -s=tabs tab-new 'https://example.com/other'
playwright-cli -s=tabs tab-list
playwright-cli -s=tabs tab-select 0
playwright-cli -s=tabs snapshot
playwright-cli -s=tabs tab-list              # always tab-list before closing
playwright-cli -s=tabs tab-close 1           # close second tab you opened
playwright-cli -s=tabs tab-close             # close first tab you opened
playwright-cli -s=tabs close
curl -sf -X POST http://localhost:3000/internal/browser/stop -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\"}"
```

## Anti-Bot / Headless Detection

某些网站会检测无头浏览器并拦截访问（返回空白页、验证码墙、403、或 JS 挑战）。如果遇到以下情况：

- 页面加载后内容为空或只有验证码
- 反复出现 Cloudflare / reCAPTCHA 挑战
- 页面提示"请使用真实浏览器"或类似反爬信息
- 相同 URL 在 snapshot 中缺少预期内容

**应尝试切换到有头模式**：先 stop 当前无头实例，再用 `headed: true` 重新 ensure：

```bash
# 1. 关闭当前无头实例
curl -sf -X POST http://localhost:3000/internal/browser/stop -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\"}"
# 2. 以有头模式重新启动（注意 headed: true）
curl -sf -X POST http://localhost:3000/internal/browser/ensure -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\",\"headed\":true}"
# 3. 重新打开会话
playwright-cli -s=<name> open [url]
```

有头模式下浏览器有真实窗口，反爬检测更难识别。代价是多占一些资源，用完后记得 stop 释放。

## Login-Required Sites

遇到需要登录的网站时，**不要直接放弃或告诉用户"无法访问"**。应主动询问用户是否愿意协助登录。

### 操作流程

1. **先切换到有头模式**（如果当前是无头），以便用户能看到登录页面：
   ```bash
   curl -sf -X POST http://localhost:3000/internal/browser/stop -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\"}"
   curl -sf -X POST http://localhost:3000/internal/browser/ensure -H 'Content-Type: application/json' -d "{\"username\":\"$(basename $PWD)\",\"headed\":true}"
   playwright-cli -s=<name> open
   ```

2. **导航到登录页面**，截图发给用户，说明情况

3. **向用户提出协助请求**，使用类似以下表述：

   > 这个网站需要登录才能访问。我可以帮你完成登录操作——你只需要：
   > - **短信验证码**：我来输入手机号并点击发送，你告诉我收到的验证码
   > - **扫码登录**：我截图展示二维码，你用手机扫一下即可
   >
   > 请放心，这个浏览器运行在你专属的隔离沙箱中，登录凭证只保存在你的个人浏览器配置里，其他人无法访问。
   >
   > 你希望用哪种方式登录？

4. **执行登录**：根据用户选择的方式操作：
   - 短信验证码：填写手机号 → 点击发送 → 等用户告知验证码 → 填入 → 提交
   - 扫码登录：截图二维码 → 发给用户 → 等用户确认扫码完成 → 刷新检查登录状态
   - 账号密码：如果用户主动提供，直接填写提交（不要主动索要密码）

5. **登录成功后**，继续执行原任务。用户的登录状态会保存在平台管理的浏览器配置中，后续访问同一网站无需重复登录。

### 用户犹豫或表达隐私顾虑时

当用户说"账号比较私人"、"不太想登录"、"安全吗"、"会不会泄露"等，**不要立即放弃或说"换其他方式"**。这是用户在寻求你的解释和保证，不是在拒绝你。你应该：

1. **先共情**：表示理解用户的顾虑（"完全理解，账号安全确实很重要"）
2. **然后具体解释安全机制**：
   > 这个浏览器运行在平台管理的用户隔离环境里：
   > - 它按用户/工作区隔离，和其他用户的浏览器实例分开
   > - cookie、登录状态保存在你的浏览器配置中；同一用户后续会话可能复用
   > - 如需清理登录状态，可以明确要求退出登录或清理对应站点状态
   > - 如果用扫码登录，我甚至看不到你的密码——你只需要在手机上确认一下就行
3. **再次给出选择**：让用户决定是否继续（"你可以先试试扫码登录，不满意随时退出"）

只有在用户**明确表示"不要登录"或"算了"**之后，才放弃登录方案并寻找替代路径。用户的犹豫 ≠ 拒绝。

### 关键原则

- **永远不要因为"需要登录"就放弃任务**——先问用户
- **用户犹豫时解释安全性，不是立即退让**——犹豫是在寻求保证，不是在拒绝
- **准确说明安全性**：浏览器在平台管理的用户隔离环境中运行，登录状态可能在同一用户后续会话复用；不要承诺绝对无痕或管理员不可访问
- **不要主动索要账号密码**：只在用户主动提供时使用
- **截图是关键**：登录页面、二维码、验证码输入框都要截图让用户看到实际状态
- **保持耐心**：登录流程可能需要多轮交互，这是正常的

## Troubleshooting

- **"browser 'default' is not open"**: Run the `open` command first. Make sure you called the ensure API beforehand
- **CDP connection refused**: The browser CDP endpoint is not running. Call the ensure API to start it
- **Anti-bot / blank page**: Switch to headed mode (see "Anti-Bot / Headless Detection" above)
- **Login required**: Don't give up — ask the user to assist with login (see "Login-Required Sites" above)
- **Stale refs / element not found**: Take a new `snapshot` — refs from previous snapshots are invalid after page changes
- **`goto` failed / page URL unchanged**: The URL was not quoted. Retry with single quotes: `goto 'https://...'`
- **`eval` returns empty or unexpected results**: Run `snapshot` first to confirm you are on the expected page
- **`Tab undefined not found` on close**: Run `tab-list` to see actual tab state before `tab-close`
- **Any command fails unexpectedly**: Run `snapshot` to check current page state before deciding next steps
- **Session conflicts**: Run `playwright-cli list` to check active sessions, then close your specific session with `-s=<name> close` and re-open
- **Command not found**: 当前 ACS 镜像缺少 `playwright-cli`。停止并报告平台镜像依赖缺口，不要在任务运行期全局安装或升级。

## References

> **Note**: Reference docs may omit `-s=<name>` session names and ensure/stop API calls for brevity. In actual usage, always follow the Critical Rules above — use named sessions and the full CDP lifecycle.

* **Setup & installation** [references/setup.md](references/setup.md)
* **Request mocking** [references/request-mocking.md](references/request-mocking.md)
* **Running Playwright code** [references/running-code.md](references/running-code.md)
* **Browser session management** [references/session-management.md](references/session-management.md)
* **Storage state (cookies, localStorage)** [references/storage-state.md](references/storage-state.md)
* **Test generation** [references/test-generation.md](references/test-generation.md)
* **Tracing** [references/tracing.md](references/tracing.md)
* **Video recording** [references/video-recording.md](references/video-recording.md)
