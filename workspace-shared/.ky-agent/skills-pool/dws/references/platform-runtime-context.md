# 平台运行时上下文（必读）

> 本文件是当前 Agent 平台的运行时约定，与 dws 官方升级独立维护。每次执行 `dws` 命令之前必须遵守本文档约定。

## 1. env 注入约定（三级 fallback）

当前 Agent 平台已迁到 ACS warm sandbox。容器按用户/workspace 复用，同一 workspace 的多个会话共享 NAS 持久目录；如果 dws 默认行为（写系统凭据、HOME 默认配置目录或 `~/.dws/`）被触发，会破坏 workspace 级账号隔离，也不利于审计和迁移。

**因此 dws 必须始终把 token 与配置写到当前 workspace 内部**，通过三个环境变量控制：

- `DWS_DISABLE_KEYCHAIN=1`：禁用系统凭据管理器（避免 macOS Keychain / Linux Secret Service 拒写或跨机泄漏）
- `DWS_CONFIG_DIR`：workspace 内 config 目录
- `DWS_KEYCHAIN_DIR`：workspace 内 key 目录

平台按三级 fallback 提供 env 注入：

### 1.1 ACS sandbox 容器（默认，agent 无需感知）

`acs-sandbox` 镜像 Dockerfile `ENV` 层已强制注入：

```dockerfile
ENV DWS_DISABLE_KEYCHAIN=1 \
    DWS_CONFIG_DIR=/workspace/.dws/config \
    DWS_KEYCHAIN_DIR=/workspace/.dws/keys
```

容器起来后所有 shell 会话、Python subprocess 都天然继承。**agent 直接跑 `dws <cmd>` 即可，token 会正确落到 `/workspace/.dws/keys/`**。

用**绝对路径** `/workspace/.dws/...` 而非 `$PWD/.dws/...`：agent 走到子目录（比如 `assets/YYYYMMDD/`、`downloads/` 等）时 token 归属不漂移。`WORKDIR /workspace`、`VOLUME /workspace` 保证工作区就在这里。

首次授权后目录会自动出现，无需手动 mkdir。`.dws/logs/` 用于 device flow polling 日志，首次跑授权流程时脚本自己 mkdir 即可。

### 1.2 本地开发（非 ACS 容器）

开发者笔记本上跑 skill 时容器 ENV 不存在，需自己 source `.dws/env.sh`：

```bash
# 首次 setup（一次即可）
mkdir -p .dws/config .dws/keys .dws/logs
cat > .dws/env.sh <<'EOF'
# 用法：从工作区根目录 source: . .dws/env.sh
export DWS_DISABLE_KEYCHAIN=1
export DWS_CONFIG_DIR="$PWD/.dws/config"
export DWS_KEYCHAIN_DIR="$PWD/.dws/keys"
EOF

# 每个 shell session source 一次
. .dws/env.sh && dws <command> --format json
```

⚠️ 不要用 `${BASH_SOURCE[0]}` 自动定位的写法：实测在 source 上下文里它可能返回空字符串，路径会变成 `$PWD/config` 而非 `$PWD/.dws/config`，token 会落到工作区根、与本约定不一致。务必用 `$PWD/.dws/...` 的简洁写法。

也可以一行内联：

```bash
DWS_DISABLE_KEYCHAIN=1 DWS_CONFIG_DIR="$PWD/.dws/config" DWS_KEYCHAIN_DIR="$PWD/.dws/keys" dws <command> --format json
```

**禁止**：本地开发环境直接裸跑 `dws auth login` 或 `dws aitable list`。第一次裸跑会把 token/config 写到默认 HOME 位置（`~/.config/dws/` 或 macOS Keychain），污染后续所有会话。ACS sandbox 里不会有这个问题（ENV 已默认注入）。

### 1.3 自写 Python 脚本（可选 helper）

`scripts/dws_runtime.py` 提供 workspace 规范工具，给**自写脚本**使用：

- `workspace_root() -> Path`：定位当前 workspace 根（读 `$KY_WORKSPACE_ROOT` / `$WORKSPACE_DIR` / cwd）
- `dws_env(extra=None) -> dict[str, str]`：显式构建 warm sandbox env（本地开发时给 subprocess 传）
- `today_ymd() / assets_dir(*parts) / safe_filename(name)`：workspace 规范工具

```python
import dws_runtime
import subprocess

env = dws_runtime.dws_env()  # ACS 里返回 os.environ 的浅副本（已含正确变量）；本地则强制写入
result = subprocess.run(
    ["dws", "contact", "user", "get-self", "--format", "json"],
    env=env,
    capture_output=True,
    text=True,
)
```

**官方 38 个脚本不 import 本 helper**——它们依赖 shell/subprocess 环境继承，ACS 容器里因 §1.1 天然生效；本地开发时必须先按 §1.2 source。**不要在 `dws_runtime.py` 里加 subprocess 猴子补丁**——那会跟官方 skill 的假设分叉、维护性极差；warm sandbox 隔离的单一真相源是 Dockerfile `ENV` 层。

## 2. 首次授权流程

每个工作区第一次使用 dws 之前需要让用户授权一次。流程：

1. 确认 dws 已安装：`command -v dws`。没有则说明 ACS 镜像或 workspace PATH 缺少 dws，不要在用户任务中执行全局安装。
2. 创建 `.dws/env.sh` 并 source（含 `DWS_DISABLE_KEYCHAIN=1` / `DWS_CONFIG_DIR` / `DWS_KEYCHAIN_DIR`）
3. **必须用当前平台支持的后台任务/轮询机制启动 device flow**，不要用 `nohup ... & disown` 或普通 shell `&` 绕开 run/tool invocation 审计。日志写到 workspace 内：
   ```bash
   bash -lc '. .dws/env.sh && dws auth login --device > .dws/logs/login.log 2>&1'
   ```
4. 从 `.dws/logs/login.log` 提取 user_code（pattern：`[A-Z0-9]{4}-[A-Z0-9]{4}`），给用户完整链接 `https://login.dingtalk.com/oauth2/device/verify.htm?user_code=<CODE>`
5. **强调让用户在自己的设备**（手机或自己的电脑浏览器）打开链接：授权页面跑在钉钉服务器上，agent 不需要代开
6. 用户完成「登录钉钉 → 选择需要授权的钉钉组织/企业 → 点同意」三步后，dws 后台轮询自动拿到 token，写入 `{工作区}/.dws/keys/`
7. 验证：`. .dws/env.sh && dws auth status`，看到 `authenticated: true` 即成功
8. 烟雾测试：`. .dws/env.sh && dws contact user get-self --format json` 拿到当前用户档案

**每个 workspace 绑定独立钉钉账号**：dws 涉及日历、待办、审批、听记、考勤、日志等**个人数据**，必须每个工作区绑定本人的钉钉账号，**禁止**复用只有少量权限的无人小号。

**Token 寿命**：access_token 2 小时（自动 refresh），refresh_token 是 30 天滑动窗口；每次成功刷新都会把窗口重新前推 30 天。正常使用无需重复登录，只有连续 30 天完全没有触发刷新才需要重走 device flow。

如果某个工作区是机器人/自动化场景（例如平台服务端定时发钉钉消息），改用 `dws auth login --client-id <key> --client-secret <secret>` 自定义应用模式，token 走同样的 env 注入路径写到本工作区。注意：必须在该应用「安全设置」里把 `http://127.0.0.1, https://login.dingtalk.com` 加到重定向 URL 白名单，并为应用申请 dws 所需的所有 scope（不能复用只有「发消息」权限的应用）。

## 3. 能力边界（与其他 skill 的协同）

| 场景 | 用哪个 |
|---|---|
| 钉钉云文档读写、知识库遍历、AI 表格操作、日历待办审批考勤听记日志等 | **dws**（本 skill） |
| TTS 语音消息 / [VOICE] 输出格式标记 / 长时间异步回复 | 不属于 dws；仅当当前会话明确启用了对应专用 skill 时才路由过去 |
| 钉钉员工 / 部门 / 工时 / 项目工时 / 审批历史归档查询 | 若当前会话启用了 `ky-data-query`，优先用它查询镜像数据库；否则 dws 更适合实时单点操作，不适合大范围历史聚合 |
| 实时拉某个员工今天的日程 / 实时查某条钉钉文档 | dws（实时） |
| 跨多人多月聚合统计（如全员本月考勤异常） | 若启用了 `ky-data-query`，走它（镜像 + DuckDB）；否则 dws 分批查询 |

简化判断：**实时单点操作 → dws；批量历史聚合 → 若启用 ky-data-query 则优先**。

## 4. 旧能力下线说明

旧 `dingtalk-docs` 已从当前 skills-pool 下线。不要再降级到该旧 skill；如果 dws 临时不可用，停止并报告 dws 授权、CLI 或网络问题。

## 5. 常用调用模板

```bash
# Source env（每个 bash session 一次）
. .dws/env.sh

# 命令与参数以当前 1.0.51 二进制的 --help 为事实源
dws chat --help
dws calendar event list --help

# dws schema 在静态端点模式下只用于 helper-only 命令
dws schema "dev app create"

# 实际调用都加 --format json
dws contact user search --keyword "张三" --format json
dws calendar event list --format json --jq '.events[] | {summary, start, end}'

# 危险操作先 dry-run 再加 --yes
dws aitable record delete --base-id xxx --table-id yyy --record-id zzz --dry-run
dws aitable record delete --base-id xxx --table-id yyy --record-id zzz --yes
```

## 6. 故障排查快表

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `keychain access denied` 或 token 写不进去 | 没注入 `DWS_DISABLE_KEYCHAIN=1` | source env.sh |
| `auth status` 显示 "not authenticated" | 当前 workspace 没跑过 `dws auth login` | 用当前平台后台任务机制跑 device flow 授权，日志写 `.dws/logs/login.log` |
| 不同 workspace 互相影响 token | env 注入路径写错了，token 落到默认 HOME 配置目录 | 不要自动删除共享配置；先确认路径和影响范围，再重新 source env.sh、重授权 |
| `command not found: dws` | ACS 镜像或 workspace PATH 缺 dws 二进制 | 报告镜像/依赖缺口；不要在用户任务中全局安装 |
| 升级到新版本 | 镜像或工具链版本落后 | 通过镜像/依赖发布流程升级；skill 文件同步独立处理，不依赖 `dws upgrade` |
| **用户已扫码确认但 auth status 仍未登录** | polling 进程已退出或授权码过期 | 查看 `.dws/logs/login.log`；失效则重新发起 device flow，让用户重扫新 code |
| **新会话第一次接管时 token 已存在但 access_token 过期** | 正常现象，refresh_token 还有效，下次调用 dws 会自动刷新 | 直接调用即可，dws 内部会自动 `lockedRefresh` |
| **`auth status` 显示 `refresh_token_valid: false`** | refresh_token 也过期了（连续 30 天没用 dws） | 重走完整 device flow 授权一次 |
| **device flow polling 日志卡在 `[1] polling`、不见 `[2] polling`** | 进程已死，输出文件被 buffer 截断 | 查看后台任务状态和 `.dws/logs/login.log`；死了则重发新 code |
| **API 报 `code: 300000` 类业务错误** | 不是认证问题，是参数错误 | 用对应层级的 `dws <command-path> --help` 查必填参数，补齐重试；helper-only 命令再用 `dws schema` |
| **`token` 拿到了但调 API 返回 `permission_denied`** | 当前账号对该资源无权限，或 dws 内置应用 scope 不够 | 换登录账号、或考虑迁到自定义应用模式 |
| **API 返回 `PAT_NO_PERMISSION` / `PAT_LOW_RISK_NO_PERMISSION` / `PAT_MEDIUM_RISK_NO_PERMISSION` / `PAT_HIGH_RISK_NO_PERMISSION`** | **预期机制**，不是 bug。钉钉对涉及个人敏感数据的 API 要求用户单独按 scope 同意一次行为 | 详见下方「PAT 行为授权机制」段；把 `authorizationUrl` 原样转给用户，说明风险等级和授权时长选项，让用户自行选择 |
| **API 返回 `PAT_SCOPE_AUTH_REQUIRED`（附 `missingScope`）** | OAuth access_token 本身缺该 scope（不是 PAT 行为同意问题） | 跑 `dws auth login --scope <missingScope>` 重走授权加 scope，与上面 PAT_*_RISK 机制不同 |
| **API 返回 `AGENT_CODE_NOT_EXISTS`** | 服务端自动建了 CLI 应用，需 host 处理 agentCode | host application（平台侧）介入；当前 PoC 阶段如撞到，向平台管理员汇报，不要自行重试 |

### Token 寿命与永久性（重要）

dws 是 **sliding window** 设计——`internal/auth/oauth_helpers.go:252,294` 每次 token exchange 都把 `RefreshExpAt` 重置为 `now + 30 天`。意味着：

- **access_token 2h**：dws 自动刷新，用户无感
- **refresh_token 30d**：但**每次自动刷新 access_token 时也会重置 refresh_token 的过期时间为 now + 30d**
- **实际效果**：只要月内调过一次 dws 命令，refresh_token 就被前推。**等于永不过期**
- **唯一掉线场景**：连续 30 天工作区完全不用 dws，refresh_token 才真过期

如果一个工作区超过 30 天没用，next call 会报 `refresh_token expired`，需要让用户重走 device flow。平台若要做到长期免重复登录，应在连接管理层对已绑定账号按不超过 21 天的周期执行一次 `dws auth status --format json`；该命令只检查并按需刷新凭证，不读取用户业务数据。多 profile 用户需逐个带 `--profile <corpId>` 检查。保活失败时只标记连接失效并提示重新授权，不得静默改绑其他账号。

### 进程生命周期（debug 必读）

device flow 启动后 dws 主进程会派生两个 PID：
- Node.js 包装层（npm wrapper）
- Go 二进制 `vendor/dws auth login --device`

确认进程活着：`ps -ef | grep "dws auth" | grep -v grep`，应该看到 2 个进程。

如果只看到 0 个进程：polling 死了，已扫的 code 作废，必须通过平台后台任务机制重发。

如果看到 2 个进程但日志一直在 `[N] polling ... Waiting for user authorization`：正常，等用户扫码。15 分钟 user_code 超时则进程会自然退出并报 `expired_token`。

## 7. PAT 行为授权机制（首次撞到时必读）

> 2026-05-17 13:00 首次实战触发，机制由源码 `internal/errors/pat.go` + `internal/app/pat_auth_retry.go` + `dws pat --help` 三处交叉验证。实测确认 PAT 授权页面有「永久」选项。

### 这是什么

**PAT = Personal Action Token（个人行为令牌）**，中文官方叫「**行为授权**」。它**不是 OAuth 的另一层 token**，而是 OAuth access_token 之上的一道**按 scope + 按行为**的细粒度用户同意机制。

钉钉把 API 按风险分 4 档：

| 错误码 | 风险 | 典型 API |
|---|---|---|
| `PAT_NO_PERMISSION` | 通用 | 应用未获权限 |
| `PAT_LOW_RISK_NO_PERMISSION` | 低风险 | 部分轻量个人数据 |
| `PAT_MEDIUM_RISK_NO_PERMISSION` | 中风险 | 个人聊天记录、个人邮件、个人日程详情 |
| `PAT_HIGH_RISK_NO_PERMISSION` | 高风险 | 代发消息、删除/修改个人数据等 |

调到该 API 时，钉钉服务端动态判定"该用户对这个 scope 的这个行为是否同意过"，没同意就返回 `PAT_*_RISK_NO_PERMISSION` + `authorizationUrl` + `flowId` + `userCode`，让用户在浏览器完成一次性的"同意"操作。

### 用户视角

打开 `authorizationUrl` 后，用户会看到钉钉的 PAT 授权页面，**有三个授权时长选项**（源码 `dws pat chmod --grant-type` 确认）：

| 选项 | 行为 |
|---|---|
| **一次性（once）** | 该 scope 用一次就失效，下次同操作还要再授权一次 |
| **本次会话（session）** | 当前会话内有效，下次会话还要再授权 |
| **永久（permanent）** | **该 scope 永久有效，以后调用不再问** |

Agent 引导用户时必须解释授权时长差异和风险等级，让用户自行选择。低风险、频繁读取类能力可说明「永久」会减少反复授权；代发、删除、修改等高风险能力即使 PAT 已授权，业务动作本身仍要逐次确认。

### Agent 处理流程

收到 PAT_*_RISK_NO_PERMISSION 错误时，按以下流程：

```bash
# 1. 不要重试，不要修改命令——这不是参数错误
# 2. 从错误 JSON 提取 authorizationUrl
# 3. 原样转给用户，明确告知：
echo "钉钉对【$API 名】这类 API 要求你单独授权一次。请在你自己的手机或电脑浏览器打开："
echo "  <authorizationUrl 原文>"
echo "页面会让你选择授权时长。请根据页面说明自行选择；完成后告诉我，我重新尝试调用。"
# 4. 等用户告知完成后，重跑原命令
```

**禁止**：
- 自行重试（钉钉服务端没拿到同意，重试只会再得同样错误）
- 把 `authorizationUrl` 重组、转码、缩短（源码 `PATAuthorizationURL()` 已做了 hash 路由的特殊处理，URL 必须原样转给用户）
- 代用户完成授权（同 device flow，授权页面跑在钉钉服务器，用户用自己设备打开）

### PAT vs OAuth：别混

| 维度 | OAuth Device Flow（`dws auth login --device`） | PAT 行为授权（API 调用时动态触发） |
|---|---|---|
| 何时发生 | 工作区**首次**接入 dws | 调到中/高风险 API 且用户没授权过 |
| 拿到什么 | access_token + refresh_token | 让该 scope 行为可调（无新 token） |
| 由谁触发 | 主动跑 `dws auth login --device` | 被动：API 报错 PAT_*_NO_PERMISSION |
| 用户操作 | 浏览器输 user_code → 选组织 → 同意 | 浏览器开 authorizationUrl → 选时长 → 同意 |
| 寿命 | refresh_token sliding window 月用一次=永久 | 选 permanent 后永久；选 once/session 下次还要 |
| 错误码 | `auth status: not authenticated` | `PAT_*_RISK_NO_PERMISSION` 或 `PAT_SCOPE_AUTH_REQUIRED` |

### 还有两类特殊错误码

- **`PAT_SCOPE_AUTH_REQUIRED`**（附 `missingScope`）：OAuth access_token 本身缺该 scope，不是 PAT 行为同意问题。**解决路径不同**：跑 `dws auth login --scope <missingScope>` 重走 device flow 加上该 scope，**不是开 authorizationUrl 这一套**
- **`AGENT_CODE_NOT_EXISTS`**：服务端自动建了 CLI 应用，需 host application 处理 agentCode。当前 PoC 阶段如撞到，向平台管理员汇报，不要自行重试

### 进阶：预先批量授权（host application 用）

`dws pat chmod <scope>...` 可以在 CLI 端预先授权某些 scope，跳过"撞墙再授权"流程。语法：

```bash
dws pat chmod chat.message:list aitable.record:read \
  --agentCode <agent-code> \
  --grant-type permanent
```

但这需要 `--agentCode`（环境变量 `DINGTALK_DWS_AGENTCODE`）参数，是给平台 host application 用的，**普通用户不需要也不能跑**——当前阶段 agent 不要主动调这个命令。

## 8. 多组织（profile）注意事项（v1.0.45+）

dws v1.0.45 起支持在同一 workspace 同时登录多个钉钉组织（`dws profile list/switch/use` + 全局 `--profile <name|corpId>`）。多租户 SaaS 场景下：

- 单组织租户：不需要额外操作，dws 自动把首次登录的组织标记为 primary 与 current
- 多组织租户：可能需要在同一 workspace 依次跑多次 `dws auth login --device`，每次授权后自动追加为新 profile
- **找群/找人/找数据在当前组织没命中，且 `dws profile list --format json` 显示 ≥2 个组织时**：对每个组织带一次性 `--profile <corpId>` 各搜一遍；命中即用，全部组织都没有才追问用户。**禁止**在当前组织搜不到就判定「不存在」或直接甩给用户选
- 平台侧不代替用户在多个组织间自动切换 primary（`profile switch` 是持久化操作，会改默认组织）；一次性跨组织读用 `--profile` 单次覆盖

profile 元数据（不含 token）写在 `.dws/config/profiles.json`；token 仍走 keychain 抽象（在我们 warm sandbox 里被 `DWS_KEYCHAIN_DIR` 重定向到 workspace 内）。这意味着 profile 机制与我们 §1 env 注入约定完全兼容，不需要额外配置。

## 9. 与 dws 官方文档关系

本文件**仅追加平台运行时约定**，不重复 dws 官方 SKILL.md / references/ 已经讲过的内容。任何与官方文档冲突的描述，以本文件为准（特指 env 注入、账号绑定、PAT 处理规则、多组织行为）。其他产品细节、命令参数、schema 用法、错误码——以 `dws schema` 实时输出和官方 references 为准。

本 skill 基于官方 **v1.0.51**（static-endpoint baseline）；skills-pool 维护「官方 baseline + 本文件 overlay」的组合快照，CLI 升级时由维护者手动 rsync 官方 tree 覆盖 + 保留本文件。**不要在容器里自动跑 `dws skill setup`**——那会用官方原始 skill 冲掉本 overlay。
