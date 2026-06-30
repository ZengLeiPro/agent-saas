---
name: codex
description: "调用 OpenAI Codex (GPT-5.4) 进行代码审查、对抗性审查、技术文档/方案审查或任务委托执行。当需要第二个 AI 视角审查代码、文档、方案的质量与漏洞，或将明确的编码任务（bug 修复、测试编写、重构）委托给 Codex 独立完成时使用。也适用于「让 Codex 看看这段代码/文档」「用 Codex review 一下」「交给 Codex 处理」「Codex 对抗审查这份方案」等场景。不要在不涉及审查或任务委托的普通对话中触发。"
allowed-tools: Bash(codex:*)
---

# OpenAI Codex CLI

通过 Bash 调用 `codex` CLI，将任务委托给 GPT-5.4。已通过 ChatGPT 认证，无需额外登录。

Codex 运行在独立进程中，与当前 Claude 会话完全隔离。它看不到我们的上下文，所以传给它的 prompt 必须自包含——包含足够的背景信息让它独立完成任务。

## 三种使用模式

### 1. 代码审查（针对 git 改动）

审查未提交的更改：
```bash
codex review --uncommitted -C ~/code/agent
```

审查当前分支相对于 main 的所有改动：
```bash
codex review --base main -C ~/code/agent
```

审查特定 commit：
```bash
codex review --commit <sha> -C ~/code/agent
```

带自定义审查指令（聚焦特定方面）：
```bash
codex review --base main "重点关注：1) 安全漏洞 2) 错误处理 3) 性能瓶颈" -C ~/code/agent
```

**适用条件**：审查目标在 git tracked 文件中，且 codex 能通过 `--base` / `--uncommitted` / `--commit` 定位到改动范围。

### 2. 对抗性审查（深度质疑）

**形态 A：针对 git 改动** —— 用 `codex review` + 对抗性 prompt：
```bash
codex review --base main "作为一个极其严格的代码审查者，质疑每一个设计决策。重点检查：
- 这个抽象是否必要，还是过度工程化？
- 有哪些失败模式没有被处理？
- 并发/竞态条件风险？
- 是否存在隐含的耦合或副作用？
不要客气，直接指出问题。" -C ~/code/agent
```

**形态 B：针对任意文件或非代码内容**（文档、方案、技术报告） —— 用 `codex exec` + stdin 重定向：

> 这是 review 子命令覆盖不了的场景：新生成的、未 git tracked 的、或者非代码类的文档。

```bash
# 1. 把长 prompt 写到临时文件（推荐用 Write 工具创建）
# /tmp/prompt.txt 内容：
#   作为严格的 [领域] 审查者，对 /path/to/document.md 做对抗性审查...
#   按维度组织、给严重程度标签、引用文献...

# 2. stdin 重定向 + stdout 重定向（重要：见 §4）
codex exec --sandbox read-only --ephemeral -C /workspace/repo < /tmp/prompt.txt > /tmp/codex-output.txt 2>&1
```

### 3. 任务委托（可写，Codex 独立执行）

让 Codex 独立完成编码任务。`--sandbox workspace-write` 启用沙箱化写入（安全）：
```bash
codex exec "找到并修复 src/mcp/cron/index.ts 中的权限检查 bug" --sandbox workspace-write -C ~/code/agent
```

大型任务输出到文件，避免 stdout 溢出：
```bash
codex exec "为 src/agent/options.ts 编写完整的单元测试" --sandbox workspace-write -C ~/code/agent > /tmp/codex-result.txt 2>&1
```

结构化 JSONL 输出（适合程序化处理）：
```bash
codex exec "重构 auth 中间件" --sandbox workspace-write -C ~/code/agent --json > /tmp/codex-events.jsonl
```

临时执行（不保存会话记录）：
```bash
codex exec "解释 runtime.ts 中 mcpServerFactory 的设计意图" --sandbox workspace-write --ephemeral -C ~/code/agent
```

## 4. 长 prompt 处理（实战踩坑总结）

**⚠️ 关键坑点：长 prompt 绝不要通过 shell 变量传参**

```bash
# ❌ 错误用法 1：变量插入（会卡在 "Reading additional input from stdin..." 然后空跑退出）
PROMPT=$(cat /tmp/long-prompt.txt)
codex exec "$PROMPT" --sandbox read-only -C /path  # 可能挂死或输出空文件

# ❌ 错误用法 2：直接拼长字符串作为参数
codex exec "$(cat /tmp/long-prompt.txt)" --sandbox read-only -C /path  # 同上

# ❌ 错误用法 3：管道 + 不指定 prompt 参数（行为不稳定）
cat /tmp/long-prompt.txt | codex exec --sandbox read-only -C /path  # 有时空跑

# ✅ 正确用法：stdin 重定向（最稳定）
codex exec --sandbox read-only --ephemeral -C /path < /tmp/long-prompt.txt > /tmp/output.txt 2>&1
```

**根因**：长 prompt 含中文/换行/引号等特殊字符时，通过 shell 字符串参数传入会被 codex 误判为"还需要从 stdin 读更多输入"，于是它真的去等 stdin。参数模式下 stdin 是 TTY，等不到 EOF，最终挂死或乱退出。

**实操流程**：
1. 用 Write 工具把 prompt 写到 `/tmp/codex-prompt.txt`
2. `codex exec [flags] < /tmp/codex-prompt.txt > /tmp/codex-output.txt 2>&1`
3. Read `/tmp/codex-output.txt` 提取最终结果

## 5. 输出处理：`>` 优于 `-o`

| 方式 | 行为 | 适用 |
|------|------|------|
| `> file 2>&1` | 捕获完整对话流（codex 元信息 + prompt 回显 + 读文件 dump + 子命令输出 + 最终回答 + token 摘要） | **默认推荐**。中途崩溃也能看到失败点 |
| `-o file` | 只写"最后一条 agent 消息" | codex 中途崩溃 → 文件可能不生成。**风险**：看不到失败原因 |

**输出文件结构**（使用 `>` 时）：
```
1. Codex 版本/sandbox/session 信息（前 ~12 行）
2. user prompt 回显
3. codex 读文件的 dump（如果 codex 在工作区读了文件）
4. codex 运行的 exec 命令 + 输出
5. codex 最终回答 ← 这才是你要的
6. tokens used 摘要
```

**提取最终报告**：
```bash
# 方法 1：tail -n +N（如果回答位置稳定）
# 方法 2：awk 提取 codex 块
awk '/^codex$/{flag=1} flag{print} /^tokens used$/{flag=0}' /tmp/codex-output.txt

# 方法 3：在 prompt 里要求 codex"直接给最终报告，不要再读文档/不要 web search"
```

## 参数速查

| 参数 | 作用 | 适用命令 |
|------|------|----------|
| `-C <dir>` | 指定工作目录（必须是 git 仓库） | review, exec |
| `--base <branch>` | 对比基准分支 | review |
| `--uncommitted` | 审查所有未提交更改 | review |
| `--commit <sha>` | 审查特定 commit | review |
| `--sandbox workspace-write` | 允许写入工作区（替代已弃用的 `--full-auto`） | exec |
| `--sandbox read-only` | 只读模式 | exec |
| `-o <file>` | 写入最后一条消息（不可靠，见 §5） | exec |
| `--json` | JSONL 事件流输出 | exec |
| `--ephemeral` | 不持久化会话 | exec |
| `-m <model>` | 覆盖模型（默认 gpt-5.4） | review, exec |

## 常用项目路径

| 项目 | 路径 |
|------|------|
| Agent 平台 (Karazhan) | `~/code/agent` |
| 业务系统 (Azeroth) | `~/code/project/ky-azeroth` |

## 注意事项

- **Codex 需要 git 仓库**：`-C` 指向的目录必须是 git repo，否则会报错。**workspace 目录**（如 `/Users/admin/workspace/admin`）也是 git repo，可以指向
- **`--full-auto` 已弃用**：codex 会显示 deprecated warning。统一用 `--sandbox workspace-write`（可写）或 `--sandbox read-only`（只读）
- **超时分两档**：
  - 简单任务（单文件审查、小代码块、解释）：**timeout 300000ms (5 min)**
  - 复杂任务（对抗审查、跨文件分析、长 prompt、文档评估）：**timeout 600000ms (10 min)**
- **exec 会修改文件**：`--sandbox workspace-write` 允许 Codex 写文件，执行前确认用户意图
- **不要用 `--sandbox danger-full-access`**：除非用户明确要求，始终用 `workspace-write`（沙箱保护）
- **Prompt 自包含**：Codex 看不到我们的对话上下文，给它的指令要包含完整的任务描述、相关文件路径、用户画像/背景

## Prompt 工程要点

Codex 在 sandbox 下有一些行为偏好，写 prompt 时要主动管理：

- **Codex 会主动读文件 / 跑 rg / 做 web search 来"核验"** —— Web search 实测可用（2026-05-14 验证：read-only sandbox 下能查到 GPT-5.5 发布日期 2026-04-23）。要不要联网让 codex 自己决定,不必在 prompt 中强行指定。
- **结构化输出指令响应良好**：
  - "按维度组织"
  - "每个发现给出严重程度标签（高/中/低）"
  - "引用具体文献名/年份/作者"
  - "不要做'总体不错'式的客套总结"
- **明确角色定位**：「作为一个极其严格的 [领域] 审查者，质疑每一个设计决策」比「请审查」效果好得多
- **给出审查维度清单**：列出 5-6 个具体维度（如证据等级、设计争议、内在矛盾），比开放性"看看有什么问题"产出质量高
