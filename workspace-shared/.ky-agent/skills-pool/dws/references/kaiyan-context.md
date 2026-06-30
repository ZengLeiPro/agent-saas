# 开沿专属上下文（必读）

> 本文件由开沿维护，与 dws 官方升级无关。每次执行 `dws` 命令之前必须遵守本文档约定。

## 1. 强制 env 注入（硬约束）

开沿 KY Agent 部署在单台 macmini 上，所有用户工作区共享同一个 macOS 用户 `admin`、共享同一个 `$HOME`、共享同一个 macOS Keychain。如果 dws 默认行为（写 Keychain 或写 `~/.config/dws/`）被触发，所有工作区会**共用同一份 token**，破坏账号隔离。

**因此调用 dws 之前必须显式注入三个环境变量，把 token 与配置都强制写到当前工作区内部：**

```bash
export DWS_DISABLE_KEYCHAIN=1
export DWS_CONFIG_DIR="$PWD/.dws/config"
export DWS_KEYCHAIN_DIR="$PWD/.dws/keys"
mkdir -p "$DWS_CONFIG_DIR" "$DWS_KEYCHAIN_DIR"
```

**推荐做法**：在工作区根目录建 `.dws/env.sh`（首次 setup 时生成）：

```bash
# .dws/env.sh
# 用法: 从工作区根目录 source: source .dws/env.sh
# 注：此脚本依赖 source 时 cwd 在工作区根目录，请勿在子目录 source
export DWS_DISABLE_KEYCHAIN=1
export DWS_CONFIG_DIR="$PWD/.dws/config"
export DWS_KEYCHAIN_DIR="$PWD/.dws/keys"
```

确保目录存在（首次 setup 时执行一次）：

```bash
mkdir -p .dws/config .dws/keys
```

每次执行 dws 命令时 source 一次（必须从工作区根目录）：

```bash
source .dws/env.sh && dws <command> --format json
```

⚠️ 不要用 `${BASH_SOURCE[0]}` 自动定位的写法：实测在 source 上下文里它可能返回空字符串，路径会变成 `$PWD/config` 而非 `$PWD/.dws/config`，导致 token 落到工作区根，与本约定不一致。务必用上面这种 `$PWD/.dws/...` 的简洁写法。

或者写成一行：

```bash
DWS_DISABLE_KEYCHAIN=1 DWS_CONFIG_DIR="$PWD/.dws/config" DWS_KEYCHAIN_DIR="$PWD/.dws/keys" dws <command> --format json
```

**禁止**：直接裸跑 `dws auth login` 或 `dws aitable list`。第一次裸跑会把 token 写到 macOS Keychain，污染所有工作区。

## 2. 首次授权流程

每个工作区第一次使用 dws 之前需要让用户授权一次。流程：

1. 确认 dws 已安装：`which dws`，没有则提示用户跑 `npm install -g dingtalk-workspace-cli`（macmini 全局装一次即可，所有工作区共享二进制）
2. 创建 `.dws/env.sh` 并 source（含 `DWS_DISABLE_KEYCHAIN=1` / `DWS_CONFIG_DIR` / `DWS_KEYCHAIN_DIR`）
3. **必须用 `nohup ... & disown` 启动 device flow**，不能直接 `dws auth login --device &`（普通后台会被 shell SIGHUP 杀掉，polling 在十几秒后死掉，用户扫码后 token 也收不回来）。推荐写法：
   ```bash
   nohup bash -c 'source .dws/env.sh && dws auth login --device' > /tmp/dws-login.log 2>&1 < /dev/null & disown
   ```
4. 从 log 提取 user_code（pattern：`[A-Z0-9]{4}-[A-Z0-9]{4}`），给用户完整链接 `https://login.dingtalk.com/oauth2/device/verify.htm?user_code=<CODE>`
5. **强调让用户在自己的设备**（手机或自己的电脑浏览器）打开链接：device flow 不需要触碰 macmini，授权页面跑在钉钉服务器上
6. 用户完成「登录钉钉 → 选组织 → 点同意」三步后，dws 后台轮询自动拿到 token，写入 `{工作区}/.dws/keys/`
7. 验证：`source .dws/env.sh && dws auth status`，看到 `authenticated: true` 即成功
8. 烟雾测试：`dws contact user get-self --format json` 拿到当前用户档案

**与现有 dingtalk-docs 小号共用模式的区别**：dws 涉及日历、待办、审批、听记、考勤、日志等**个人数据**，必须每个工作区绑定本人的钉钉账号，**禁止**复用 ***REMOVED-PUBLIC-HISTORY-5*** 那个无人小号。

**Token 寿命**：access_token 2 小时（自动 refresh），refresh_token 30 天（过期需重走完整 device flow 授权）。

如果某个工作区是机器人/自动化场景（例如 KY Agent 服务端定时发钉钉消息），改用 `dws auth login --client-id <key> --client-secret <secret>` 自定义应用模式，token 走同样的 env 注入路径写到本工作区。注意：必须在该应用「安全设置」里把 `http://127.0.0.1, https://login.dingtalk.com` 加到重定向 URL 白名单，并为应用申请 dws 所需的所有 scope（不能复用只有「发消息」权限的应用）。

## 3. 能力边界（与开沿其他 skill 的协同）

| 场景 | 用哪个 |
|---|---|
| 钉钉云文档读写、知识库遍历、AI 表格操作、日历待办审批考勤听记日志等 | **dws**（本 skill） |
| TTS 语音消息 / [VOICE] 输出格式标记 / SessionWebhook 90 分钟回复 | `dingtalk-msg`（开沿自建 FC + 火山引擎合成，dws 不覆盖） |
| 钉钉员工 / 部门 / 工时 / 项目工时 / 审批历史归档查询 | `ky-data-query`（查 azeroth 镜像数据库，比 dws 调实时 API 快、可做聚合分析） |
| 实时拉某个员工今天的日程 / 实时查某条钉钉文档 | dws（实时） |
| 跨多人多月聚合统计（如全员本月考勤异常） | `ky-data-query`（镜像 + DuckDB） |

简化判断：**实时单点操作 → dws；批量历史聚合 → ky-data-query；TTS 语音 → dingtalk-msg**。

## 4. 过渡期注意（旧 dingtalk-docs 暂未下线）

当前 skills-pool 同时存在 `dingtalk-docs`（基于 mcporter + 钉钉官方 MCP server）和 `dws`（本 skill）。两者描述会有重叠触发。优先级：

- **优先选 dws**：因为它有更完整的产品覆盖、官方维护、token 隔离方案更严
- 仅在 dws 临时不可用（网络、CLI 未装、授权未完成）时降级到 dingtalk-docs

`dingtalk-docs` 计划在 dws 稳定使用 2-4 周后下线。

## 5. 常用调用模板

```bash
# Source env（每个 bash session 一次）
source .dws/env.sh

# 探查命令 schema（推荐 agent 第一次用某产品前先看）
dws schema chat
dws schema aitable

# 实际调用都加 --format json
dws contact user search --keyword "曾磊" --format json
dws calendar event list --format json --jq '.events[] | {summary, start, end}'

# 危险操作先 dry-run 再加 --yes
dws aitable record delete --base-id xxx --table-id yyy --record-id zzz --dry-run
dws aitable record delete --base-id xxx --table-id yyy --record-id zzz --yes
```

## 6. 故障排查快表

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `keychain access denied` 或 token 写不进去 | 没注入 `DWS_DISABLE_KEYCHAIN=1` | source env.sh |
| `auth status` 显示 "not authenticated" | 当前工作区没跑过 `dws auth login` | 跑 device flow 授权（注意必须 nohup） |
| 不同工作区互相影响 token | env 注入路径写错了，token 落到 `~/.config/dws/` | 删掉 `~/.config/dws/`、重新 source env.sh、重授权 |
| `command not found: dws` | macmini 没装 dws 二进制 | 用户在宿主机跑 `npm install -g dingtalk-workspace-cli` |
| 升级到新版本 | 用户在宿主机跑 `dws upgrade` | skill 文件由 cron 同步独立处理，不依赖 `dws upgrade` |
| **用户已扫码确认但 auth status 仍未登录** | **polling 进程已被 SIGHUP 杀掉**（没用 nohup 启动） | `ps -ef \| grep "dws auth"` 看进程是否还在；不在则用 `nohup ... & disown` 重新发起，让用户重扫新 code |
| **新会话第一次接管时 token 已存在但 access_token 过期** | 正常现象，refresh_token 还有效，下次调用 dws 会自动刷新 | 直接调用即可，dws 内部会自动 `lockedRefresh` |
| **`auth status` 显示 `refresh_token_valid: false`** | refresh_token 也过期了（连续 30 天没用 dws） | 重走完整 device flow 授权一次 |
| **device flow polling 日志卡在 `[1] polling`、不见 `[2] polling`** | 进程已死，输出文件被 buffer 截断 | 用 `ps` 确认进程；死了则按"已死"路径处理 |
| **API 报 `code: 300000` 类业务错误** | 不是认证问题，是参数错误 | 用 `dws schema <product>` 查必填参数，补齐重试 |
| **`token` 拿到了但调 API 返回 `permission_denied`** | 当前账号对该资源无权限，或 dws 内置应用 scope 不够 | 换登录账号、或考虑迁到自定义应用模式 |
| **API 返回 `PAT_NO_PERMISSION` / `PAT_LOW_RISK_NO_PERMISSION` / `PAT_MEDIUM_RISK_NO_PERMISSION` / `PAT_HIGH_RISK_NO_PERMISSION`** | **预期机制**，不是 bug。钉钉对涉及个人敏感数据的 API 要求用户单独按 scope 同意一次行为 | 详见下方「PAT 行为授权机制」段；**关键：把 `authorizationUrl` 原样转给用户，提示用户在钉钉页面选「永久」选项** |
| **API 返回 `PAT_SCOPE_AUTH_REQUIRED`（附 `missingScope`）** | OAuth access_token 本身缺该 scope（不是 PAT 行为同意问题） | 跑 `dws auth login --scope <missingScope>` 重走授权加 scope，与上面 PAT_*_RISK 机制不同 |
| **API 返回 `AGENT_CODE_NOT_EXISTS`** | 服务端自动建了 CLI 应用，需 host 处理 agentCode | host application（KY Agent 平台）介入；当前 PoC 阶段如撞到，向曾磊汇报，不要自行重试 |

### Token 寿命与永久性（重要）

dws 是 **sliding window** 设计——`internal/auth/oauth_helpers.go:252,294` 每次 token exchange 都把 `RefreshExpAt` 重置为 `now + 30 天`。意味着：

- **access_token 2h**：dws 自动刷新，用户无感
- **refresh_token 30d**：但**每次自动刷新 access_token 时也会重置 refresh_token 的过期时间为 now + 30d**
- **实际效果**：只要月内调过一次 dws 命令，refresh_token 就被前推。**等于永不过期**
- **唯一掉线场景**：连续 30 天工作区完全不用 dws，refresh_token 才真过期

如果一个工作区超过 30 天没用，next call 会报 `refresh_token expired`，需要让用户重走 device flow。在 PoC 阶段不用提前担心，到了第一个 30 天临界点再说。

### 进程生命周期（debug 必读）

device flow 启动后 dws 主进程会派生两个 PID：
- Node.js 包装层（npm wrapper）
- Go 二进制 `vendor/dws auth login --device`

确认进程活着：`ps -ef | grep "dws auth" | grep -v grep`，应该看到 2 个进程。

如果只看到 0 个进程：polling 死了，已扫的 code 作废，必须用 `nohup ... & disown` 重发。

如果看到 2 个进程但日志一直在 `[N] polling ... Waiting for user authorization`：正常，等用户扫码。15 分钟 user_code 超时则进程会自然退出并报 `expired_token`。

## 7. PAT 行为授权机制（首次撞到时必读）

> 2026-05-17 13:00 首次实战触发，机制由源码 `internal/errors/pat.go` + `internal/app/pat_auth_retry.go` + `dws pat --help` 三处交叉验证。曾磊在 PAT 授权页面亲眼确认有「永久」选项。

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

**Agent 引导用户时必须明确推荐选「永久」**——否则用户体验会非常糟糕（每次拉聊天记录都要重新扫一次）。

### Agent 处理流程

收到 PAT_*_RISK_NO_PERMISSION 错误时，按以下流程：

```bash
# 1. 不要重试，不要修改命令——这不是参数错误
# 2. 从错误 JSON 提取 authorizationUrl
# 3. 原样转给用户，明确告知：
echo "钉钉对【$API 名】这类 API 要求你单独授权一次。请在你自己的手机或电脑浏览器打开："
echo "  <authorizationUrl 原文>"
echo "选择「永久」选项 → 同意 → 完成后告诉我，我重新尝试调用。"
# 4. 等用户告知完成后，重跑原命令
```

**禁止**：
- 自行重试（钉钉服务端没拿到同意，重试只会再得同样错误）
- 把 `authorizationUrl` 重组、转码、缩短（源码 `PATAuthorizationURL()` 已做了 hash 路由的特殊处理，URL 必须原样转给用户）
- 让用户在 macmini 上完成授权（同 device flow，授权页面跑在钉钉服务器，用户用自己设备打开）

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
- **`AGENT_CODE_NOT_EXISTS`**：服务端自动建了 CLI 应用，需 host application 处理 agentCode。当前 PoC 阶段如撞到，向曾磊汇报，不要自行重试

### 进阶：预先批量授权（host application 用）

`dws pat chmod <scope>...` 可以在 CLI 端预先授权某些 scope，跳过"撞墙再授权"流程。语法：

```bash
dws pat chmod chat.message:list aitable.record:read \
  --agentCode <agent-code> \
  --grant-type permanent
```

但这需要 `--agentCode`（环境变量 `DINGTALK_DWS_AGENTCODE`）参数，是给 KY Agent 这种 host application 用的，**普通用户不需要也不能跑**——当前阶段 agent 不要主动调这个命令。

## 8. 与 dws 官方文档关系

本文件**仅追加开沿专属约定**，不重复 dws 官方 SKILL.md / references/ 已经讲过的内容。任何与官方文档冲突的描述，以本文件为准（特指 env 注入、账号绑定、PAT 处理规则）。其他产品细节、命令参数、schema 用法、错误码——以 `dws schema` 实时输出和官方 references 为准。
