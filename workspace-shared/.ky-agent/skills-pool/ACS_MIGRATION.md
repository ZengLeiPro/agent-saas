# ACS Sandbox Skill 迁移规范 v1

适用范围：`workspace-shared/.ky-agent/skills-pool` 下所有 skill。
目标运行时：agent-saas 的阿里云 ACS Sandbox，Linux 容器、warm sandbox、用户/workspace 维度复用、会话级审计。

## 0. 修复优先级

按风险而不是按目录顺序修：

1. **P0 安全阻断**：明文凭证、生产写操作、对外发送、客户系统登录、不可逆删除、旧运行时会误触发的长程任务。
2. **P1 主路径迁移**：旧路径、macOS/Homebrew/Keychain/Safari/剪贴板、系统级安装、固定 `/tmp`、输出散落、HTML 外链。
3. **P2 文案和小修**：触发描述不准、引用路径错误、诊断信息不足、过期统计。

发现真实凭证时：立即从 skill 包移除，改 secret/env 注入，并在回报中标记需要轮换。不要在报告、日志或最终回复中复述真实值。

## 1. Skill 路径

skill 内部脚本、模板、reference 必须从当前 `SKILL.md` 所在目录解析。

推荐文案：

```markdown
脚本路径必须从当前 skill 目录解析，不要假设 cwd，也不要写死 `.claude/skills/...`、`~/code/...` 或 `/Users/admin/...`。
```

示例：

```bash
SKILL_DIR="<当前 skill 目录>"
python3 "$SKILL_DIR/scripts/run.py" uploads/input.ext -o assets/20260630/output.ext
```

禁止把 workspace 本地副本当权威源。修改 skill 必须改 `workspace-shared/.ky-agent/skills-pool/<skill-name>/`。

## 2. 文件输入输出

用户上传输入默认来自 `uploads/`。

用户可见交付物默认写入：

```text
assets/yyyymmdd/<清晰文件名或任务目录>/
```

临时文件可以写 workspace 内 `tmp/` 或项目自己的临时目录，但不能让最终产物只留在 `/tmp`、当前目录、skill 目录、缓存目录或系统目录。

脚本要避免覆盖用户文件：

- 输出路径存在时默认失败，除非用户明确要求覆盖。
- 批量生成时用日期目录、run id、UUID 或任务名隔离。
- 不要用秒级时间戳作为唯一并发隔离。

## 3. 凭证与外部服务

真实凭证不得出现在：

- `SKILL.md`
- `scripts/`
- `references/`
- 示例命令
- 报告、日志、截图标注、最终回复

凭证来源只允许：

- ACS secret/env 注入
- 受控 MCP/connector 配置
- 用户本轮明确提供的临时凭据，且不得写回 skill 包

缺凭证时停止并说明需要管理员配置 secret，不要要求用户把长期 token 粘贴到对话里。

外部 API、上传、TTS、ASR、下载、客户系统访问都要在 skill 中写清楚：

- 是否会把用户数据发到第三方
- 是否可能产生费用
- 是否需要用户确认敏感内容
- 失败时不能用记忆或示例补答高精度事实

## 4. 对外操作和生产操作

以下操作必须在同轮确认目标、范围、内容和是否立即执行：

- 发送钉钉/邮件/社媒/GitHub 评论等对外消息
- 公开分享链接、上传第三方可见文件
- 写入客户系统、生产系统、CRM/数据库
- 批量修改、删除、归档、重建
- 登录客户账号或访问生产后台

默认只读。无法确认受众或权限时，输出草稿/计划，不执行。

## 5. 依赖安装

ACS Sandbox 是 Linux 容器。skill 不应指导用户执行：

- Homebrew
- `apt-get` / `yum` / 系统级包管理
- `sudo pip`
- `pip install --user`
- `--break-system-packages`
- 自建 venv
- 全局 `npm install -g`

Python 包只装 workspace 内置 `.venv`：

```bash
python3 -m pip install <package>
```

系统依赖应由镜像预置。缺系统依赖时停止并报告镜像缺口，不在普通 skill 流程里修改容器系统。

## 6. macOS 旧链路

以下属于旧本机假设，不得作为 ACS 主路径：

- Safari Web Inspector、Keychain、AppleScript、`open`
- Homebrew、`~/Library`
- macOS 桌面客户端自动化、剪贴板自动化
- Apple Silicon 专属模型或库
- 本机浏览器 profile、桌面截图、GUI 权限

如果必须保留历史方案，必须在 `description` 和正文顶部标为 `legacy`，并明确 ACS 中不要自动执行。

## 7. Warm Sandbox 并发隔离

ACS 底层容器按用户/workspace 复用，同一 workspace 的多个会话可能共享：

- 进程表
- 浏览器 profile
- `/tmp`
- `.venv` / npm cache
- 下载模型缓存
- 当前工作目录

因此 skill 脚本要做到：

- 临时目录带 `KY_SESSION_ID`、`KY_RUN_ID`、`KY_INVOCATION_ID` 或 UUID。
- 浏览器 profile、LibreOffice profile、下载目录按 run/session 隔离。
- 不用固定端口；需要端口时自动探测并输出。
- 取消/清理只处理本次 invocation 创建的进程和文件。
- 不用 `killall`、`pkill`、全局清理缓存。

## 8. HTML / PPT / HyperFrames 交付

交付给用户预览的 HTML 必须单文件自包含：

- CSS/JS 内联
- 图片/音频/视频用本地 assets 或 base64
- 不依赖 CDN、远程字体、外链脚本

HyperFrames 开发过程可以使用项目内资源，但最终给用户的 HTML/PDF/视频产物要落到 `assets/yyyymmdd/`，并在回报中列明路径。

## 9. 触发描述

`description` 必须体现当前 ACS 能力边界：

- 主路径是否可在 ACS 执行
- 是否依赖外部服务/凭证/费用
- 是否是 legacy 旧方案
- 何时不应触发

不要让旧 macOS/Claude Code/Workflow 技能因为宽泛关键词误触发。

## 10. 修后验证

每批修复至少做：

```bash
git diff --check -- <改动路径>
```

按文件类型加测：

- Python：`python3 -m py_compile <files>`
- Bash：`bash -n <files>`
- JSON：`python3 -m json.tool <file>`
- Markdown/文案：脱敏扫描真实 token/key、旧路径、危险安装命令

提交前独立查看 staged 范围：

```bash
git diff --cached --name-only
```

只提交本批文件，保留无关脏改。
