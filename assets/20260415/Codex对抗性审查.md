# Codex 对抗性安全审查

审查日期：2026-04-15

审查目标：多用户 AI Agent 平台（`admin` / `user` 双角色）

审查范围：
- 后端路由：`server/src/routes/`
- 认证与角色：`server/src/auth/`、`server/src/data/users/types.ts`
- WebSocket：`server/src/channels/web/`
- 子系统：skills / cron / agent / dingtalk
- 前端：`web/src/`

## 总体结论

从普通 `user` 攻击者视角看，平台存在多条可落地的越权路径，且有数个问题可以串联成高危攻击链：

- 普通用户可把自己的 Agent 头像字段改成路径穿越值，再通过公开头像端点读取服务端任意文件。
- 普通用户可通过 Agent 子系统直接读取服务端环境变量，且非 admin 运行时会向子进程注入 `GH_TOKEN`。
- WebSocket 认证信任 JWT 中的历史 `role` 声明，导致“已被降权的 admin”在 token 过期前仍保留 admin 级 WS 能力。
- `/internal/browser` 控制面未鉴权，普通用户可直接控制其他用户的浏览器实例。

按严重程度汇总如下：

| 严重程度 | 数量 | 主题 |
| --- | --- | --- |
| Critical | 3 | 任意文件读取、服务端密钥泄露 |
| High | 3 | WS 权限保留、未鉴权内部控制面、跨用户 DingTalk 会话操作 |
| Medium | 4 | group/cron 数据隔离缺陷、交互响应 fail-open、条件型 MCP 放行 |
| Low | 3 | 前端仅做 UI 隐藏、公开配置/健康信息、用户信息枚举 |

---

## 详细发现

### 1. Critical：普通用户可通过 Agent 头像字段实现任意文件读取

- 位置：
  - `server/src/routes/agents.ts:23-27`
  - `server/src/routes/agents.ts:40-41`
  - `server/src/routes/agents.ts:136-153`
  - `server/src/routes/agents.ts:182-215`
  - `server/src/data/agents/store.ts:60-81`
- 问题说明：
  - 普通用户可修改自己的 `avatar` 字段。
  - 公开头像接口仅检查 `avatar.startsWith('agent-avatars/')`，随后直接 `resolve(agentAvatarsDir, '..', profile.avatar)` 并 `sendFile()`，没有做目录边界校验。
  - `agentStore.set()` 对 `avatar` 没有二次校验。
- 攻击路径：
  1. 以普通用户登录。
  2. 发起：
     ```http
     PATCH /api/agents/<你的用户名>
     Authorization: Bearer <user-jwt>
     Content-Type: application/json

     {"avatar":"agent-avatars/../../../../data/users.json"}
     ```
  3. 再访问：
     ```http
     GET /api/agents/avatar/<你的用户名>
     ```
  4. 服务端会把目标文件作为头像文件返回。
- 影响范围：
  - 可读取 `users.json`、配置文件、日志、源码内敏感文件。
  - 若能进一步读到 JWT 密钥、第三方 API Key、GitHub token 等，可扩展为完全接管。
  - 由于头像接口是公开路由，攻击者完成一次写入后，后续任何人都可直接访问该泄露 URL。
- 修复建议：
  - 普通用户禁止直接提交字符串型 `avatar` 路径，只允许通过上传接口设置头像。
  - 头像读取时使用 `resolve()` 后做前缀校验，必须落在 `agentAvatarsDir` 内。
  - 对 `avatar` 字段建立白名单格式校验，例如仅允许 emoji 或 `agent-avatars/<filename>`。

### 2. Critical：`/api/voice/play` 可通过符号链接穿越读取工作区外文件

- 位置：
  - `server/src/routes/voice.ts:34-37`
  - `server/src/routes/voice.ts:52-60`
  - `server/src/routes/voice.ts:65`
  - `server/src/routes/voice.ts:101`
  - `server/src/routes/voice.ts:107`
  - `server/src/channels/web/channel.ts:743-779`
- 问题说明：
  - 该接口只拒绝请求参数里显式出现 `..`，并仅校验解析后的路径字符串位于 `userCwd` 下。
  - 之后用 `stat()` 与 `createReadStream()`，会跟随符号链接访问真实目标。
  - 非 admin 的 Bash 权限审计只检查命令中的绝对路径，对相对路径目标创建软链不会拦截。
- 攻击路径：
  1. 普通用户通过聊天让 Agent 调用 Bash：
     ```bash
     ln -s ../../../../code/Agent/data/users.json uploads/leak.wav
     ```
  2. 然后请求：
     ```http
     GET /api/voice/play?path=uploads/leak.wav
     Authorization: Bearer <user-jwt>
     ```
  3. 服务端会跟随软链，把工作区外文件内容流式返回。
- 影响范围：
  - 任意读取服务端文件，突破工作区隔离。
  - 可与其他敏感文件泄露链路组合，进一步获取密钥和账号数据。
- 修复建议：
  - 使用 `lstat()` 拒绝符号链接。
  - 在最终打开文件前对真实路径做 `realpath()` 后的目录边界校验。
  - 对用户工作区内 `uploads/` 等目录增加“禁止软链”清理策略。

### 3. Critical：普通用户可通过 Agent/Bash 直接读取服务端环境变量与 GitHub Token

- 位置：
  - `server/src/agent/options.ts:28-41`
  - `server/src/engine/dispatch.ts:360-366`
  - `server/src/engine/dispatch.ts:455-569`
  - `server/src/channels/web/channel.ts:724-740`
  - `server/src/channels/web/channel.ts:743-779`
- 问题说明：
  - Agent 运行环境会复制完整 `process.env`，再叠加 `dispatch.env`、`sharedEnv`。
  - 非 admin 运行时还会显式注入 `GH_TOKEN`，并配置 git credential helper 从该环境变量取 token。
  - 普通用户的 Bash 工具几乎是默认放行，只做了非常有限的路径审计；`env`、`printenv`、`python -c 'import os; ...'` 这类命令均可执行。
- 攻击路径：
  1. 普通用户登录 Web/WS。
  2. 发送提示词诱导 Agent 调用 Bash，例如：
     - `env | sort`
     - `printf '%s\n' "$GH_TOKEN"`
     - `python - <<'PY'\nimport os; print(os.environ)\nPY`
  3. Agent 将环境变量内容直接回显给用户。
- 影响范围：
  - 泄露模型 Key、代理配置、第三方 API Key、GitHub Token、内部服务凭证。
  - 一旦 `GH_TOKEN` 可用，普通用户可越权访问服务端绑定的 GitHub 身份。
- 修复建议：
  - 非 admin 子进程环境必须做最小化白名单注入，禁止继承完整 `process.env`。
  - `GH_TOKEN` 不应下发到普通用户会话。
  - Bash 对普通用户应改为默认拒绝，或至少建立命令白名单而不是仅做路径审计。

### 4. High：WebSocket 认证信任 JWT 中的历史角色，降权后仍可保留 admin 能力

- 位置：
  - `server/src/auth/middleware.ts:55-76`
  - `server/src/channels/web/wsServer.ts:262-279`
- 问题说明：
  - HTTP 中间件会用数据库中的真实角色覆盖 token 内的 `role`。
  - 但 WS 认证只校验 token 签名和用户是否存在/禁用，最终直接信任 `decoded.role`。
  - 默认 token 有效期是 `30d`。
- 攻击路径：
  1. 攻击者在“曾为 admin”期间获得一个合法 JWT。
  2. 账号被降权为 `user` 后，不更新 token。
  3. 继续使用旧 token 连接：
     ```http
     GET /ws?token=<old-admin-jwt>
     ```
  4. WS 连接仍被当作 admin。
- 影响范围：
  - 继续使用 admin 级 WS 操作能力。
  - 可绕过普通用户的权限提示逻辑、继续查看/恢复其他用户会话、执行更高权限的 agent 操作。
- 修复建议：
  - WS 认证必须像 HTTP 一样，从 `userStore` 重新加载角色并覆盖 token claim。
  - 用户角色变更时，应主动断开该用户所有现有 WS 连接。
  - 降低 token 有效期，并在敏感变更后强制使旧 token 失效。

### 5. High：`/internal/browser` 控制面未鉴权，普通用户可控制其他用户浏览器

- 位置：
  - `server/src/index.ts:50-58`
  - `server/src/routes/browser.ts:60-127`
  - `server/src/routes/browser.ts:130-168`
  - `server/src/index.ts:117`
- 问题说明：
  - `/internal/browser` 在 `/api` 鉴权中间件之前挂载，完全未认证。
  - 服务监听在 `0.0.0.0`，不是仅本地回环。
  - 接口允许任意指定 `username` 启动或停止对应浏览器 profile。
- 攻击路径：
  1. 普通用户先通过 `GET /api/agents` 获取平台用户名列表。
  2. 直接请求：
     ```http
     POST /internal/browser/ensure
     Content-Type: application/json

     {"username":"victim","headed":true}
     ```
     或
     ```http
     POST /internal/browser/stop
     Content-Type: application/json

     {"username":"victim"}
     ```
- 影响范围：
  - 可启动/停止其他用户的浏览器实例，造成 DoS。
  - 若浏览器 profile 中保存了登录态，存在会话劫持/旁路访问风险。
- 修复建议：
  - 该控制面必须至少限制为 `127.0.0.1` 本地访问，且应叠加服务端鉴权。
  - 如果确实仅给 agent 使用，应采用随机高熵本地令牌，而非裸露 HTTP 端点。
  - `username` 需要与当前认证用户绑定，不允许任意指定他人。

### 6. High：DingTalk 会话管理接口未做 admin/归属校验

- 位置：
  - `server/src/channels/dingtalk/protocol/sessionRouter.ts:62-78`
  - `server/src/channels/dingtalk/protocol/sessionRouter.ts:84-115`
- 问题说明：
  - 任意已登录用户都可列出全局 DingTalk 会话摘要。
  - 任意已登录用户都可向任意会话 webhook 发送测试消息。
- 攻击路径：
  1. 以普通用户请求：
     ```http
     GET /api/dingtalk/sessions
     Authorization: Bearer <user-jwt>
     ```
  2. 选取返回中的 `conversationId`，再发送：
     ```http
     POST /api/dingtalk/sessions/<conversationId>/test
     Authorization: Bearer <user-jwt>
     Content-Type: application/json

     {"message":"伪造通知","msgType":"markdown"}
     ```
- 影响范围：
  - 泄露跨用户/跨群会话元数据。
  - 普通用户可向不属于自己的 DingTalk 会话主动发消息。
- 修复建议：
  - 会话枚举和测试发送都应改为 `requireAdmin`。
  - 如果要支持普通用户，只能访问与自己绑定的会话，且必须基于 `req.user` 做归属过滤。

### 8. Medium：`PATCH /api/groups/:id` 缺失 `sessionIds` 归属校验，可把外部会话挂入自己的 group

- 位置：
  - `server/src/routes/groups.ts:252-268`
  - `server/src/data/groups/store.ts:107-116`
  - `server/src/routes/groups.ts:437-490`
  - 对比正确校验位置：`server/src/routes/groups.ts:69-85`、`327-350`
- 问题说明：
  - `POST /groups/:id/sessions` 会校验会话归属。
  - 但 `PATCH /groups/:id` 允许直接替换 `sessionIds`，没有任何归属校验。
  - `GET /groups/:id/sessions` 随后会读取这些 transcript 并返回标题、预览、owner 等信息。
- 攻击路径：
  1. 普通用户创建一个属于自己的 group。
  2. 发起：
     ```http
     PATCH /api/groups/<group-id>
     Authorization: Bearer <user-jwt>
     Content-Type: application/json

     {"sessionIds":["<foreign-or-legacy-session-id>"]}
     ```
  3. 再访问：
     ```http
     GET /api/groups/<group-id>/sessions
     Authorization: Bearer <user-jwt>
     ```
- 影响范围：
  - 如果攻击者已掌握某个外部/历史 sessionId，可泄露该会话的标题、预览和 owner。
  - 对 legacy root transcript 的兼容逻辑会放大该问题。
- 修复建议：
  - `PATCH /groups/:id` 中只允许改名；如果涉及 `sessionIds`，必须复用 `validateSessionOwnership()`。
  - `GET /groups/:id/sessions` 返回前再次校验 `meta.userId === group.userId`。

### 9. Medium：legacy 无 owner 的 cron 任务对所有用户可见，run details 还会泄露完整 transcript

- 位置：
  - `server/src/routes/cron.ts:27-32`
  - `server/src/routes/cron.ts:95-100`
  - `server/src/routes/cron.ts:296-350`
- 问题说明：
  - `canView()` 对 `job.owner === undefined` 的旧任务返回 `true`。
  - 普通用户不仅能看 job 和 runs，还能进一步看 run details，后者会解析 transcript 并返回完整 `blocks`。
- 攻击路径：
  1. 普通用户请求：
     ```http
     GET /api/cron/jobs
     Authorization: Bearer <user-jwt>
     ```
  2. 找到 `owner` 缺失的旧任务。
  3. 继续请求：
     ```http
     GET /api/cron/jobs/<jobId>/runs
     GET /api/cron/jobs/<jobId>/runs/<runId>/details
     ```
- 影响范围：
  - 泄露旧 cron 任务的提示词、输出内容、运行 transcript。
  - 若历史任务处理过敏感业务数据，影响面较大。
- 修复建议：
  - 对 legacy 无 owner 任务执行一次迁移回填；迁移前默认仅 admin 可见。
  - `run details` 端点应比 `jobs` 列表更严格，不应对 owner 缺失任务开放给普通用户。

### 10. Medium：WS `respond` 归属校验 fail-open，interactionId 泄露时可跨用户响应

- 位置：
  - `server/src/channels/web/channel.ts:290-304`
  - `server/src/data/transcripts/meta.ts:33-39`
- 问题说明：
  - 普通用户响应交互时，代码会在“当前用户自己的 cwd”下读 session meta。
  - 若读不到 meta，会直接 `resolveInteraction()`，而不是拒绝。
  - `readSessionMeta()` 对任何读取失败都会返回 `null`。
- 攻击路径：
  1. 攻击者获得他人 `interactionId`。
  2. 通过自己的 WS 发送 `respond` 消息。
  3. 因当前 cwd 下读不到该 session 的 meta，代码走 fail-open 分支并直接完成响应。
- 影响范围：
  - 可越权确认/拒绝他人的 `permission_request` 或 `ask_user` 交互。
- 修复建议：
  - 对非 admin，meta 缺失必须 fail-close。
  - 交互存储层应直接记录 `userId` 并在 resolve 时校验，而不是依赖文件系统侧查。

### 11. Medium（条件型）：普通用户对所有 `mcp__*` 工具自动放行，外部 MCP/插件配置下可形成越权

- 位置：
  - `server/src/channels/web/channel.ts:724-740`
  - `server/src/agent/options.ts:229-252`
- 问题说明：
  - 非 admin 的权限回调把所有 `mcp__*` 工具都视为“安全工具”自动放行。
  - SDK 又允许从 `.claude` 资源加载扩展配置。
  - 当前代码自带 MCP 主要是 `memory-search` / `cron`，但一旦部署中接入更高权限的 MCP/插件，普通用户就能直接调用。
- 攻击路径：
  - 普通用户通过聊天诱导 Agent 调用任意 `mcp__*` 工具；平台会自动批准，不再弹权限确认。
- 影响范围：
  - 取决于部署所挂载的 MCP：
    - 若是 GitHub/Gmail/Google Drive 等全局连接器，则会直接越权访问外部系统。
    - 若仅有当前仓库内置的 `memory-search` / `cron`，风险相对较低。
- 修复建议：
  - 不允许按 `mcp__` 前缀整体白名单放行，应逐个 MCP server / tool 建立权限模型。
  - MCP 必须区分“平台级连接器”和“用户级连接器”，并与用户身份绑定。

### 12. Low：前端 admin“路由守卫”主要依赖导航隐藏，不是有效访问控制

- 位置：
  - `web/src/App.tsx:108-122`
  - `web/src/components/DesktopSessionSidebar.tsx:541-543`
  - `web/src/components/MobileSessionList.tsx:247-249`
  - `web/src/layouts/DesktopLayout.tsx:88-98`
  - `web/src/layouts/DesktopLayout.tsx:281-307`
- 问题说明：
  - 前端通过 `baseNavItems.filter((!item.adminOnly || isAdmin))` 隐藏 admin 入口。
  - 但 `DesktopLayout`/`MobileLayout` 对 `activeTab` 本身没有强校验，相关 admin 面板仍可被挂载。
  - 因后端大多仍有服务端鉴权，这更像是“探测面扩大”而非单独的越权漏洞。
- 攻击路径：
  - 普通用户可在浏览器 DevTools 中篡改前端状态，把 `activeTab` 切到 `users` / `skills` 等。
- 影响范围：
  - 暴露更多前端管理组件和 API 调用入口，方便进行接口探测。
- 修复建议：
  - 前端仍应在路由层和组件层双重校验 `isAdmin`。
  - 但根本控制仍必须依赖后端鉴权。

### 13. Low：公开健康检查与配置接口存在信息泄露

- 位置：
  - `server/src/auth/middleware.ts:8-17`
  - `server/src/routes/health.ts:23-38`
  - `server/src/routes/health.ts:50-55`
  - `server/src/routes/cron.ts:87-93`
- 问题说明：
  - `/api/health`、`/api/healthz`、`/api/config` 被明确列入公开路由。
  - `/api/health` 会返回 uptime、内存占用、activeStreams、dispatch 指标、`ttsAvailable` 等运行态信息。
  - `/api/config` 暴露 `permissionMode`、`maxTurns`。
  - `/api/cron/status` 对所有已登录用户可见，暴露调度器全局状态。
- 攻击路径：
  - 直接请求：
    ```http
    GET /api/health
    GET /api/config
    GET /api/cron/status
    ```
- 影响范围：
  - 便于攻击者做版本指纹、负载侦察和能力枚举。
- 修复建议：
  - `healthz` 保留最小探针语义，详细健康状态改为 admin-only。
  - `config` 只返回前端确实需要的最低信息，且建议要求认证。

### 14. Low：普通用户可枚举全站用户名与真实姓名

- 位置：
  - `server/src/routes/agents.ts:91-129`
- 问题说明：
  - 注释写明“普通用户仅返回公开字段”，但实际仍返回所有用户的 `username` 和 `realName`。
- 攻击路径：
  ```http
  GET /api/agents
  Authorization: Bearer <user-jwt>
  ```
- 影响范围：
  - 暴露平台账号列表与姓名映射。
  - 可作为其它攻击的用户名枚举前置步骤。
- 修复建议：
  - 普通用户只返回最小公开资料，默认不返回 `realName`。
  - 若业务不需要，也不应返回全量用户名列表。

---

## 按攻击面结论

### 1. API 路由权限缺失

确认存在问题的端点：

- `/internal/browser/ensure`、`/internal/browser/stop`：应受保护，但当前完全未鉴权。
- `/api/dingtalk/sessions`、`/api/dingtalk/sessions/:conversationId/test`：缺少 admin/归属校验。
- `PATCH /api/groups/:id`：未校验 `sessionIds` 的归属。
- `GET /api/cron/jobs*` / `runs*`：对 legacy 无 owner 任务存在越权读取。

已检查且未见明显缺失：

- `server/src/routes/auth.ts` 的用户管理接口均已使用 `requireAdmin`。
- `server/src/routes/skills.ts` 的 pool/custom/force sync 等管理接口均已使用 `requireAdmin`。
- `photos/videos` 的统计接口仅 admin 可访问；普通同步接口按当前用户工作区写入。

### 2. 前端路由守卫绕过

- 前端 admin 控制主要是“隐藏入口”，不是强制访问控制。
- `activeTab` 被篡改后，管理面板仍可能挂载并发起 API 探测。
- 这不是主漏洞面，真正的安全边界仍在后端。

### 3. WebSocket 越权

确认存在问题：

- WS 登录信任 token 内旧角色，降权后仍可保持 admin。
- `respond` 的归属校验 fail-open。

未见明显问题：

- `resume` / `abort` 对普通用户做了 `userId` 级别校验。
- 用户级事件广播总体按 `userId` 隔离。

### 4. 文件路径穿越

确认存在问题：

- `voice.ts` 可通过软链绕过工作区边界。
- `agents.ts` 头像读取存在路径穿越。

已检查且未见明显问题：

- `file.ts`：多数路径都做了边界校验，且使用 `lstat()` 拒绝符号链接。
- `upload.ts`：上传目录按用户工作区解析，文件名会清洗。
- `photos.ts` / `videos.ts`：主要写入当前用户目录，未见直接路径穿越。
- `preview.ts`：预览 token 方案相对稳健，读取前有授权路径解析与 `lstat()`。

### 5. JWT token 篡改/角色逻辑

- 未发现 `alg=none`、无签名 token 接受、或“纯信任客户端 role”的 HTTP 漏洞。
- 主要问题在于 WS 侧没有像 HTTP 一样刷新 DB 中的真实角色。

### 6. 间接权限提升（skill / cron / agent）

确认存在问题：

- Agent 子进程环境变量暴露过宽，可直接读取服务端密钥。
- `mcp__*` 工具自动放行是明显的权限设计缺陷。
- DingTalk 会话测试接口可被普通用户滥用，属于外部系统越权发送。

未见明显直通问题：

- Skills 管理 REST 路由边界基本正确。

### 7. 数据隔离

确认存在问题：

- legacy 无 owner 的 cron 数据对所有用户可见。
- group patch 可绑定外部 sessionId，导致 session 摘要泄露。
- `GET /api/agents` 会向普通用户暴露全站用户名/真实姓名。

已检查且未见明显问题：

- `agents/:username/persona` 与 `agents/:username/memory` 都要求“本人或 admin”。
- `sessions` 主路径大多有 `meta.userId` 归属校验。

### 8. 配置暴露

- `/api/health`、`/api/config`、`/api/cron/status` 均有不同程度的信息暴露。
- 这些更偏“侦察面扩大”，但对攻击前置情报收集很有帮助。

---

## 优先修复建议

建议按以下顺序落地：

1. 立刻修复两个任意文件读取点：`agents avatar`、`voice symlink`。
2. 立即收紧普通用户 Agent 权限：最小化环境变量注入，移除 `GH_TOKEN`，默认拒绝 Bash。
3. 修复 WS 角色刷新逻辑，并在角色变更后强制断开现有 WS。
4. 给 `/internal/browser`、DingTalk session 管理补上鉴权和归属校验。
5. 修补 `groups.patch` 与 legacy cron ownerless 可见性问题，消除历史兼容路径造成的隔离绕过。

---

## 备注

- 本报告基于代码静态审计得出，未做在线利用验证。
- 目标路径 `/Users/admin/workspace/admin/assets/20260415/` 在当前沙箱中不可写，因此本报告已写入仓库内镜像路径：`assets/20260415/Codex对抗性审查.md`。
