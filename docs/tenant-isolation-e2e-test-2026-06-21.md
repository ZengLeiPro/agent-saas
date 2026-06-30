# agent-saas 多组织改造 PR 1-7 端到端测试报告

> 测试时间：2026-06-21 20:46~22:25（三轮）
> 测试人：麦迪文（曾磊授权直接运行 + 浏览器实测）
> 测试环境：本机 launchd 3200，PR 1-7 全部 push 后**首次真实运行**
> 测试方法：launchd 重启 + 浏览器多账号登录 + 创建第二组织 + curl API 越久矩阵 + 跨组织 shell 实测 + abort/resume
> 测试结论：**第一轮 P0 + P3 修了 push（fb04e619）；第二轮发现 P1 跨组织 shell + file/artifact 泄漏；第三轮 PR 9 多层修复（11c6c2de + 1eab4eff）端到端 100% 验证；77/711 测试零回归。SaaS 上架前阻塞全清零**

> **2026-06-23 update**：基于本报告衍生的"5 个测试覆盖盲区"调研（`assets/20260622/e2e测试覆盖盲区调研.md`）后续 4 commit 全部落地：A+C container 端到端（`verify:tenant-container-smoke`）+ wake tenantId fail-safe + 跨进程 approval-resume scenario（`verify:multiprocess:approval-resume`）+ P4 raw runtime/container envBuilder 防御纵深 + P5 sandbox guard 路径变形 bypass。重审后疑点 4 不是泄漏路径（gate fail-closed 挡死），降级为防御纵深；疑点 2 只对平台 admin 生效。详 `docs/managed-agents-roadmap.md` §14.6"P4/P5 防御纵深 + 端到端覆盖（2026-06-23 落地）"。SaaS 上架阻塞清零状态：v2 → v3。

---

> 2026-06-21 后续更新：本文前文记录的是三轮端到端测试的历史过程。最新代码语义已把 `run_shell` 从“platform-admin-only 止血 gate”升级为 **A+C execution routing**：`run_shell` 是 agent 操作自己 sandbox/hand 的基础能力；平台 admin 默认 `server-local`；非平台用户（组织 admin / 普通 user）默认 `server-container`（本机 Docker 隔离 fallback），session 内唯一 ready tenant-remote hand 仍会被工具层优先自动路由；非平台用户误落 `server-local` 仍 fail-closed，用来防止本文记录的 wain_admin 跨组织 cat 事故复发。


> 2026-06-21 后续更新 2：在 A+C 默认隔离之后，raw runtime 又补了 **server-local portable sandbox guard baseline**（commit `7644d5f`）：`rawRuntimeRunDispatch` / approval resume / interaction resume 会把 `dispatch.sandbox.denyRead` 模板展开成 `sandboxPolicy` 传入 `WorkspaceRef`；`ServerLocalExecutionProvider` 对 `read_file` / `write_file` / `list_files` 的解析后路径，以及 `run_shell` 命令里直接出现的 denied absolute path 做 fail-closed。这个补丁不是完整 `sandbox-exec` 迁移，不能替代 `server-container` / tenant hand 的主隔离层，但能覆盖误落 `server-local` 时最直接的跨组织/敏感路径读取回归。

## 0. TL;DR

| 维度 | 结论 |
|---|---|
| 启动期迁移（TenantStore / UserStore / Transcript / PG ALTER）| ✅ 全部成功，**650 个旧 transcript 正确迁移到 tenant-aware projectKey** |
| 登录身份层（JWT 带 tenantId）| ✅ 通过 |
| 旧会话 UI 渲染（PR 7 BUG 6 修复）| ✅ 230 个旧会话完整加载 + 旧会话点开 transcript 正常 |
| 端到端 dispatch（首跑 + 工具调用 + approval）| ⚠️ **触发 P0 BUG #2**：手动 mv 旧 workspace 后通过 |
| 第二组织创建（admin CRUD）| ✅ 通过 |
| 跨组织隔离（5 个 403 + 1 个有意 200）| ✅ 全部 PASS |
| /api/auth/me response 完整性 | ⚠️ **缺 tenantId 字段** |

**SaaS 上架仍有 1 个 P0 阻塞**。原"阻塞清零"判断不成立——PR 4 与 PR 8 之间存在兼容缝隙未被复核发现。

---

## 1. 启动期迁移验证（Task 1-2）✅

`pnpm service:restart` → 老 PID 76293 死，launchd KeepAlive 拉起新 PID 6553。

启动日志关键 4 项全部成功：

```
[Auth] Migrated 1 legacy user record(s) to tenant 'kaiyan'    ← UserStore 回填
[Server] Tenant store loaded: 1 tenant(s), default='kaiyan'   ← TenantStore.ensureDefault
[Data] [startup] BUG6: Migrated 650 transcript file(s) to tenant-aware projectKey  ← PR 7 P1-6
[Server] Runtime EventStore initialized: backend=pg            ← PG 三表 ALTER（IF NOT EXISTS）
[Server] RuntimeScheduler started: autoWake=true               ← PR 8 enqueue-only 路径就绪
```

文件层校验：
- `server/data/tenants.json` 新建并含 kaiyan 默认组织 ✓
- `server/data/users.json` admin 用户加上 `tenantId: "kaiyan"` ✓
- `~/.claude/projects/-Users-admin-workspace-openai-runtime-kaiyan-admin/` 新 transcript 目录已建 ✓

---

## 2. 浏览器 admin 登录 + UI 验证（Task 3-4）✅

- `POST /api/auth/login` 通过，JWT payload 解出 `"tenantId":"kaiyan"` ← PR 2 通过
- `/api/tenants` 返回 kaiyan 默认组织 ← PR 1 + requirePlatformAdmin 通过
- `/api/auth/users` 返回 admin 用户带 `tenantId` 字段 ← PR 2 通过
- 浏览器登录主界面：**230 个旧会话全部加载**（PR 7 BUG 6 在 UI 完全验证）
- 点开旧会话 `bc085a6a-...`：transcript 完整渲染，message + 工具调用 + agent 回复全部正常 ← PR 7 P1-6 修复**真实生效**

---

## 3. 端到端 dispatch 测试（Task 5）⚠️ **P0 BUG #2 暴露**

### 测试动作
新建会话 `55c846cb-...`，发消息 "请用 run_shell 跑 `pwd && whoami`"，触发 PR 10 durable approval，点 Allow。

### 失败现象
工具返回：`tool error: spawn /bin/sh ENOENT（请勿重试，请告知用户）`

### 根因调查
1. `/Users/admin/workspace-openai-runtime/kaiyan/` **目录不存在**
2. `/Users/admin/workspace-openai-runtime/admin/` **仍在旧扁平位置未被搬走**
3. 新会话 meta 文件 `cwd = "/Users/admin/workspace-openai-runtime/kaiyan/admin"`
4. hand-server 拿这个 cwd 去 spawn `/bin/sh`，Node 因为 cwd 不存在直接返回 ENOENT

### 真正根因
**PR 8 enqueue-only + scheduler wake 路径绕过了 `engine/dispatch.ts:309` 的 `ensureUserWorkspace` 调用。**

代码路径：
```
Web chat → WebChannel.handleChat (PR 8 enqueue-only)
        → RuntimeScheduler.enqueue (run=pending)
        → RuntimeScheduler 扫描 → acquireLease
        → wakeRuntimeSession()          ← 在 rawRuntimeRunDispatch.ts:1517
        → createRawRuntimeRunDispatch(config)
        → raw dispatch 直接跑           ← 没有 ensureUserWorkspace 步骤
        → 工具 spawn cwd=新路径 → ENOENT
```

`engine/dispatch.ts:309` 的 ensureUserWorkspace（含 PR 4 扁平→tenant 迁移逻辑）**只在老的 direct dispatch 路径里**。PR 8 已经把 Web 默认改成 enqueue-only，那段代码已经不再被首跑消息触发。

### 影响范围
**所有**走 PR 8 enqueue-only + scheduler wake 路径的首跑：
- admin 自己（已暴露，临时 mv 绕过）
- **任何新建组织的任何用户首次发消息**——包括 SaaS 上架第一个真实客户
- file backend 不受影响（仍走 direct dispatch），但 PG runtime 都中招

### 临时绕过（已执行）
```bash
mkdir -p /Users/admin/workspace-openai-runtime/kaiyan
mv /Users/admin/workspace-openai-runtime/admin /Users/admin/workspace-openai-runtime/kaiyan/admin
```
绕过后开新会话 `pwd` 返回 `/Users/admin/workspace-openai-runtime/kaiyan/admin` ✓ 工具链路正常。

### 推荐修复
两种方案：

**方案 A（推荐）：wake 路径补 ensureUserWorkspace**

在 `wakeRuntimeSession` 调用 dispatch 之前，根据 `session.userId + session.username` 从 UserStore 找回 WorkspaceUser，调用 ensureUserWorkspace。需要把 `globalAgentCwd` / `sharedDir` / `skillConfigStore` 注入到 `RawRuntimeRunDispatchConfig`。

修改点：
- `server/src/runtime/rawRuntimeRunDispatch.ts:1517-1730`（wakeRuntimeSession）
- `RawRuntimeRunDispatchConfig` 接口扩展三字段
- `server/src/app/runtime.ts` 装配时注入

预估 30-60 分钟（含测试）。

**方案 B：WebChannel.handleChat enqueue 之前先 ensure**

在 Web 入站层 `enqueueRuntime.scheduler.enqueue()` 之前调一次 `ensureUserWorkspace`。简单但散布——cron / approval resume / interaction resume 也都要补。

**方案 A 干净，建议直接做。**

### 这个 bug 为什么 PR 5 复核没抓到
PR 5 由 Workflow + 8 个 sonnet Explore agent 跑了 768k token / 10 min 复核，报告 7 P0 + 10 P1，PR 5/6/7 共修了其中 7+8 项。但这些复核**全部是静态读代码**，没真实运行——而 PR 8 enqueue-only 路径绕过 ensureUserWorkspace 这个事实，必须**真跑一次 fresh tenant 首跑**才能暴露。

这正是"端到端真实运行"的不可替代价值。

---

## 4. 第二组织 + admin CRUD（Task 6）✅

通过 admin token：
- `POST /api/tenants {id:"wain-test", name:"唯恩电气（测试组织）"}` → 201
- `POST /api/auth/users {username:"wain_admin", tenantId:"wain-test", role:"admin"}` → 201
- `POST /api/auth/users {username:"wain_user", tenantId:"wain-test", role:"user"}` → 201
- `GET /api/tenants` 返回 2 个组织 ✓

`createdBy` 字段记录为 admin uuid，符合 PR 1 设计。

---

## 5. 跨组织隔离矩阵（Task 7-8）✅

用 wain_admin token 测 6 类越权：

| # | 攻击场景 | 期望 | 实际 | 验 PR |
|---|---|---|---|---|
| T1 | `GET /api/sessions?viewAs=__all__` | 403 | ✅ 403 "跨组织视图仅限平台 admin" | PR 5 P0-3 |
| T2 | `GET /api/sessions?viewAs=__others__` | 403 | ✅ 403 同上 | PR 5 P0-3 |
| T3 | `GET /api/sessions?viewAs=admin` | 403 | ✅ 403 "跨组织访问被拒绝" | PR 5 P0-3 |
| T4 | `GET /api/file/list?root=true` | 403 | ✅ 403 "path traversal not allowed" | PR 5 P0-2 |
| T5 | `GET /api/file/read?owner=admin&path=MEMORY.md` | 403 | ✅ 403 "cross-tenant access denied" | PR 5 + PR 7 P1-7 |
| T6 | `PATCH /api/auth/users/<admin-id> password` | 403 | ✅ 403 "跨组织访问被拒绝" | PR 5 P0-1 |
| T7 | `GET /api/sessions/<kaiyan-sid>` | 403 | ✅ 403 "Access denied" | PR 7 canAccessSession |
| T8 | `GET /api/sessions/<kaiyan-sid>/stream-status` | 200 + active:false | ✅ 200（**有意设计**：避免 200/403 区分泄漏 sessionId 存在性，注释明确） | PR 7 |
| T9 | `PATCH /api/sessions/<kaiyan-sid> {title}` | 403 | ✅ 403 "Access denied" | PR 7 canAccessSession |
| T10 | `GET /api/tenants`（非 platform admin） | 403 | ✅ 403 "Platform admin access required" | PR 2 requirePlatformAdmin |
| T11 | `GET /api/auth/users`（wain_admin 视角） | 只 wain | ✅ 只返回 wain_admin + wain_user | PR 5 P0-1 |

**11/11 全部符合预期**。

---

## 6. 其他 bug：BUG #1（P3）/api/auth/me 缺 tenantId

`UserInfo` type 定义 `tenantId: string`（必选），但 `routes/auth.ts:284-295` 的 `/me` handler 漏返回该字段：

```ts
// 当前实现（漏 tenantId）
res.json({
  id: req.user.sub,
  username: req.user.username,
  role: req.user.role,
  avatar: ...,
  realName: ...,
  // ... 没有 tenantId
});
```

**影响**：低。前端如果想从 `/api/auth/me` 拿 tenantId 显示"当前组织"标签会拿不到。可以从 JWT 解出来，但不该让前端做这事。

**修复**：`auth.ts:284` 加一行 `tenantId: req.user.tenantId,` 即可。1 分钟。

---

## 7. 推荐修复优先级（第一轮）

| 优先级 | 项 | 工作量 | 阻塞 | 状态 |
|---|---|---|---|---|
| **P0** | BUG #2 修 wake 路径补 ensureUserWorkspace | 30-60 min | ✅ **阻塞 SaaS 上架** | ✅ **已修 commit `fb04e619`** |
| P3 | BUG #1 /api/auth/me 加 tenantId 返回 | 1 min | ❌ | ✅ **已修 同上 commit** |

**第一轮修复已 push 到 main 并重启 3200 验证生效**：wain_admin 新组织首跑 run_shell 返回 `/Users/admin/workspace-openai-runtime/wain-test/wain_admin admin WAIN_TENANT_VERIFY` ✓，77/705 测试零回归（+2 新测试覆盖 provisioner fail / cancel skip）。

---

## 8. 测试中产生的数据（决策点）

| 项 | 当前状态 | 建议 |
|---|---|---|
| `admin` workspace 物理 mv 到 `kaiyan/admin/` | 已迁，admin 工作正常 | **保留**（PR 4 本该自动做） |
| `wain-test` tenant | 已创建 | **建议保留**作为 PR 8 修复后的第二客户组织测试用 |
| `wain_admin` / `wain_user` 用户 | 已创建 | **同上** |

如果想清理：
```bash
AT=$(cat /tmp/admin_token.txt)
# 删用户（DELETE /api/auth/users/:id）
curl -X DELETE -H "Authorization: Bearer $AT" http://127.0.0.1:3200/api/auth/users/339b5e8f-41b4-4694-9c79-aefae6f625e6
curl -X DELETE -H "Authorization: Bearer $AT" http://127.0.0.1:3200/api/auth/users/14c95cfb-316d-4d0a-a0dd-dad260a3b905
# Disable tenant（slug 建后不可改，只能 disable）
curl -X PATCH -H "Authorization: Bearer $AT" -H "Content-Type: application/json" \
     -d '{"status":"disabled"}' http://127.0.0.1:3200/api/tenants/wain-test
```

---

## 9. 一句话总结

PR 1-7 多组织改造的**纸面工作 95% 正确**——TenantStore / JWT / PG 列 / 路径 / 权限矩阵 / 跨组织校验全部按设计工作。但 **PR 8 enqueue-only 落地时无人考虑跟 PR 4 ensureUserWorkspace 的兼容**，导致**所有新组织的所有用户首跑必然 ENOENT 失败**——SaaS 上架前必须先修这个 P0。修完一次，PR 1-7 才能算真正"阻塞清零"。

---

# 第二轮测试（21:40~21:55）

第一轮把"启动迁移 + 登录 + 旧会话 + 端到端 dispatch + 6 个 API 越权矩阵"打通了。第二轮补 5 个深度场景：组织内 admin 边界、普通 user 角色边界、sandbox 跨组织文件访问、长任务 abort、旧会话 resume。

## 10. 第二轮测试结果

### 10.1 组织内 admin 同组织 CRUD（Task 13）✅ 5/5

用 wain_admin token 测同组织管理能力：

| # | 场景 | 期望 | 实际 |
|---|---|---|---|
| T13.1 | wain_admin 改 wain_user 密码 | 200 | ✅ 200 |
| T13.2 | wain_user 用新密码登录验证 | 200 + JWT(tenantId=wain-test) | ✅ 全对 |
| T13.3 | wain_admin 改 wain_user realName | 200 | ✅ 200 |
| T13.4 | wain_admin 试图改 wain_user 到 kaiyan 组织 | 拒绝或忽略 | ✅ 200 但 **tenantId 字段被静默忽略**（建后不可改设计） |
| T13.5 | 列表确认 wain_user 仍在 wain-test | 是 | ✅ 是 |

### 10.2 普通 user 角色边界（Task 14）✅ 7/7

用 wain_user（role='user'）token 测：

| # | 场景 | 期望 | 实际 |
|---|---|---|---|
| T14.1 | `GET /api/auth/users` | 403 | ✅ 403 "Admin access required" |
| T14.2 | `POST /api/auth/users` 试创建用户 | 403 | ✅ 403 |
| T14.3 | `GET /api/tenants` | 403 | ✅ 403 "Platform admin access required" |
| T14.4 | `POST /api/tenants` 试创建 tenant | 403 | ✅ 403 |
| T14.5 | `PATCH /api/auth/password` 改自己 | 200 | ✅ 200 |
| T14.6 | `PATCH /api/auth/users/<wain_admin>` 改别人 | 403 | ✅ 403 |
| T14.7 | `/api/auth/me` 返回自己 + tenantId | ✓ | ✅ 含 `tenantId: "wain-test"`（BUG #1 修复对 user 角色也生效）|

### 10.3 sandbox 跨组织文件访问（Task 15）⚠️ **发现 P1 BUG #3**

#### 测试设计
PR 4 `{{OTHER_TENANT_WORKSPACES}}` token 宣称"跨组织 workspace 隔离（兄弟 tenant 根目录全部 deny）"。验证是否真生效。

#### 关键发现
1. **sandbox 只对非 admin 用户启用**：`dispatch.ts:335` `const isAdmin = context.user.role === 'admin'; if (!isAdmin) { sandbox-exec ... }`
2. **历史状态：`run_shell` 当时只对 admin role 开放**：非 admin 调 `run_shell` 直接 tool 层 403："`run_shell is only enabled for admin in the OpenAI Agents PoC`"（最新状态见文首更新：已升级为 A+C execution routing）
3. **`read_file` 内置工具有 workspace 边界校验**：wain_admin 调 `Read /Users/admin/workspace-openai-runtime/kaiyan/admin/MEMORY.md` → `tool error: Access denied: path outside workspace`（✅ 这层防御正确）
4. **但 `run_shell` 没有 workspace 边界校验，admin 又不走 sandbox**——下面 BUG #3

#### 🚨 BUG #3（P1 跨组织文件泄漏）

**复现步骤**：
1. wain_admin 登录浏览器，新建会话
2. 发消息："请用 run_shell 跑 `cat /Users/admin/workspace-openai-runtime/kaiyan/admin/MEMORY.md | head -10`"
3. 点 Allow

**实际结果**：
```
[stdout] # 长期记忆
> 此记忆由 Agent 自动维护，每次对话开始时自动加载到上下文中。
> 这是你精心整理的记忆、提炼后的精华，不是原始记录。
> 保持精炼，不超过 200 行。
## 用户与组织
...
EXIT=0
```

`cat` 成功执行（EXIT=0）拿到了 kaiyan admin 的 MEMORY.md 真实内容。`head -10` 截到了第 10 行，第 13 行起就是"开沿科技（中国福建泉州）..."等开沿真实业务数据。**只要 wain_admin 改 `head -50` 或 `cat 整个文件`，就能完全读到曾磊的所有 MEMORY**。

延伸到任意文件：
- `~/.claude/projects/-Users-admin-workspace-openai-runtime-kaiyan-admin/*.jsonl` 所有 admin transcript（业务对话）
- skill 配置 / venv 内容
- 理论上写也同样不受限（admin 没 sandbox）—— 本次未实测（agent prompt 层拒绝写，绕开 prompt 需要更深的注入）

#### 根因

```ts
// server/src/engine/dispatch.ts:335
const isAdmin = context.user.role === 'admin';
// ...
if (!isAdmin) {
  // 只有非 admin 才走 sandbox-exec OS 层
  // 包括 {{OTHER_TENANT_WORKSPACES}} 模板展开 deny
}
```

`isAdmin` 把**组织 admin** 和**平台 admin** 一视同仁。组织 admin（任何客户的 admin user）也满足 `role === 'admin'`，所以**所有组织 admin 完全没有 sandbox-exec 限制**。

PR 4 的 `OTHER_TENANT_WORKSPACES` 模板**只对非 admin（普通 user）生效**——但普通 user 又没 `run_shell` 工具。结果就是 sandbox 跨组织 deny **在实际场景下覆盖范围为零**。

#### 影响

**严重**。任何客户组织的 admin 都能：
- 读其他组织（包括开沿自己 kaiyan）的所有 workspace 文件
- 读所有 transcript（业务对话历史）
- 读其他组织的 MEMORY / Skills / 配置
- 理论上还能写（破坏 / 注入），未实测

如果对接真实客户，**第一个客户的 admin = 整个平台跨组织读权限**。

#### 推荐修复

```ts
// 把这一行：
const isAdmin = context.user.role === 'admin';
// 改成：
const isPlatformAdmin = (context.user.role === 'admin') &&
                         (context.user.tenantId === DEFAULT_TENANT_ID);
// 然后 if (!isAdmin) { sandbox-exec ... } → if (!isPlatformAdmin) { sandbox-exec ... }
```

**评估副作用**：
- 组织 admin 跟普通 user 一样走 sandbox-exec
- 可能影响：组织 admin 装 skill / MCP / 创建文件等动作需要符合 sandbox 白名单（`/tmp`、`~/Library/Caches/ms-playwright`、`{{USER_CWD}}` 内可写、`additionalDirectories` 可写）
- 不影响：在自己 workspace 内的常规读写（cwd 内默认允许）
- 影响范围：上线第一个真实客户组织**之前**必须做

**工作量**：核心改动 1 处（dispatch.ts:335），加 sandbox 测试 + 真实跑一遍 wain_admin run_shell 跨组织应被 deny 的回归测试。预估 1-2 小时。

#### 这个 bug 为什么 PR 5 复核也没抓到

PR 5 复核 8 sonnet Explore agent 扫了 sandbox.ts 看 OTHER_TENANT_WORKSPACES 模板的展开逻辑——逻辑本身**正确**。但没有人问"sandbox 实际对谁生效"。`if (!isAdmin)` 这个早就存在的 gate 在多组织改造前是合理的（"admin = 信任的平台运维"），多组织改造后这条假设崩了——但代码里 `isAdmin` 这一行没动过，复核者也没标记。

### 10.4 长任务 abort + cancel（Task 16）✅ PR 11 runId-first 完美

**测试**：wain_admin 发 `for i in 1..10; do echo tick=$i; sleep 3; done`，跑 8 秒后点 UI 停止。

**主机进程观察**：
- 点停止**前**：`ps aux` 显示 `/bin/sh -c for i in 1 2 3 4 5 6 7 8 9 10; do echo "tick=$i"; sleep 3; done` (PID 23164) + `sleep 3` (PID 23168)
- 点停止**后 3 秒**：`ps aux | grep -E "tick=|sleep 3"` 空——**进程树完全清理**

**UI 状态**：输入框立即激活、"停止生成"按钮变回"语音输入"。

**结论**：PR 11 runId-first abort + hand-server `DELETE /invocations/:id` 子进程 SIGTERM→SIGKILL 进程组级清理**端到端验证**正常工作。

### 10.5 旧会话 resume（Task 17）✅

**测试**：admin 直跳 17 天前旧会话 URL `/chat/bc085a6a-7677-4437-8ed7-29c82d35dac2`（6/4 22:48 创建），续发 run_shell 命令。

**结果**：
- 历史消息完整渲染（用户 06/04 22:48 + agent write_file 工具调用 + "写入被拒绝"回复）
- 续发新消息 → approval → Allow → run_shell 返回 `/Users/admin/workspace-openai-runtime/kaiyan/admin RESUME_OK_215317`
- **cwd 路径正确**：`kaiyan/admin` 是 PR 4 tenant 层路径，说明 SessionCatalog 已经被 PR 7 BUG 6 transcript 迁移修正
- 模型默认（豆包 2.0 Pro）/ executionTarget=server-local 都从 SessionCatalog 正确恢复

---

## 11. 第二轮发现总结

| 优先级 | 项 | 工作量 | 阻塞 SaaS | 状态 |
|---|---|---|---|---|
| **P1** | BUG #3 dispatch.ts:335 isAdmin → isPlatformAdmin | 1-2 小时 | ⚠️ **上线第一个真实客户组织前必须修** | 🔴 **待修，需你决策修法** |

第一轮的 P0/P3 已修。第二轮 P1 是**架构假设崩溃**：sandbox 多组织层面的"admin = 平台 admin"假设在 PR 1-7 多组织改造后失效，但 dispatch.ts 那行 `isAdmin` 从来没动过——组织 admin 现在变成"半神"角色（有完整 admin 权限但本应受 tenant 边界约束）。

### 第二轮的方法学沉淀

1. **prompt 层防御 ≠ 系统级防御**：本次测试中 agent 几次主动拒绝跨组织操作（PERSONA / instruction 引导），看起来"安全"。但 prompt 防御只能挡老实模型——绕过 prompt 注入就失效。真正的安全必须在工具层 / sandbox 层强制。
2. **多重防御都要测**：测试时要主动"打穿"prompt 层去验证下面那层。本次 `read_file` 有 workspace 校验（中），但 `run_shell` 没有（导致 P1 BUG）。
3. **架构假设迁移**：从单组织到多组织、从单进程到多 brain、从同步 dispatch 到 scheduler wake——每次重大架构改造都会让旧 invariant 失效。`isAdmin` 这条假设在多组织后必须升级为 `isPlatformAdmin`。

---

## 12. 当前决策点

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| A | P1 BUG #3 修法 | (a) 改 `isAdmin → isPlatformAdmin` 让组织 admin 走 sandbox；(b) 给 run_shell 加 per-tenant workspace path 校验（不依赖 sandbox）；(c) 暂不修，等上架第一个真实客户前再修 | **(a)** 最一致 + 复用 PR 4 已有 `{{OTHER_TENANT_WORKSPACES}}` 模板，1-2 小时 |
| B | 是否需要做 prompt-injection adversarial 测试 | (a) 写一个专门绕 PERSONA prompt 的攻击 prompt 验证 run_shell 写是否也泄漏；(b) 默认按 read 已泄漏推断 write 也泄漏，直接修代码 | **(b)** 按代码逻辑足够推断，不必再测 |
| C | wain-test / wain_admin / wain_user 测试数据 | 第一轮已决定保留作第二客户灰度，继续保留 | 保留 |

---

## 13. 测试覆盖矩阵更新

| 维度 | 第一轮 | 第二轮 |
|---|---|---|
| API 越权矩阵 | 11/11 | + 12（同组织 CRUD 5 + 普通 user 角色 7）|
| 端到端 dispatch | ✓（admin）| + ✓（wain_admin 新组织首跑）|
| 跨组织 file API | ✓ 4/4 | + ✓ read_file 工具层校验 |
| 跨组织 shell | 未测 | 🔴 **P1 泄漏** |
| Abort/cancel | 未测 | ✅ PR 11 runId-first 端到端 |
| 旧会话 resume | 部分（看 transcript）| ✅ 续发完整工具调用闭环 |
| 全 user/admin 权限矩阵 | 部分 | ✅ 覆盖完整（user / 组织 admin / 平台 admin 三类）|

---

## 14. 二轮一句话总结

第一轮把 SaaS 上架前的"基础设施级 P0"挖出来并修了；第二轮把"业务边界级 P1"挖出来——**组织 admin 角色完全没 sandbox，能 cat 其他组织任意文件**。这是 SaaS 上架第一个真实客户**之前**必须修的事，不然第一个客户的 admin 就能看光开沿和后续所有客户的数据。修法简单（dispatch.ts 一行），副作用可控（组织 admin 跟普通 user 一样走 sandbox），需要你拍板"现在修还是等上架前修"。

---

# 第三轮：修 P1 BUG #3 + 浏览器复测（21:55~22:25）

曾磊选"现在就修（推荐）"。下面是修复过程 + 端到端复测。

## 15. 修复轨迹：两次提交，第一次没生效

### 15.1 PR 9（commit `11c6c2de`）第一次尝试

按第二轮判断"修法只是改 dispatch.ts 一行"，把 `engine/dispatch.ts:335` `isAdmin = role === 'admin'` 改成 `isPlatformAdmin = role === 'admin' && tenantId === DEFAULT_TENANT_ID`，并扩展到所有相关文件：

| 文件 | 改动 |
|---|---|
| `engine/dispatch.ts` | sandbox / sharedDirs (skills-pool) / extraDirs / allowGhCli 4 处 |
| `routes/file.ts` | /file/read / /file/download / /file/list / /file/delete 4 个路由 |
| `routes/voice.ts` | owner 参数 + workspace 边界 |
| `runtime/artifactService.ts` | assertCanAccessSession session ACL 跳过 |
| `app/routes.ts` | broadcastToAdmin / 启动期 clearLogs admin loop 2 处 |

新增测试 +4（isPlatformAdmin 真值表 3 + sandbox 模板 1）。typecheck 干净，77/709 测试零回归。push 重启。

**复测 API 层：✅ 通过**——`GET /api/file/read?path=/Users/admin/workspace-openai-runtime/kaiyan/admin/MEMORY.md` 之前 HTTP 200 泄漏 → 现在 **HTTP 403 "Access denied: path outside authorized directories"**。

**复测 run_shell 层：🚨 失败！** wain_admin 还是能 cat 跨组织 MEMORY 内容（EXIT=0）。

### 15.2 深挖根因：raw runtime 完全没有 sandbox 配置

```bash
grep -rnE "sandbox|expandSandboxPaths|OTHER_TENANT_WORKSPACES" src/runtime/*.ts src/agent/*.ts
# 结果：只有 httpTransport.ts 一行注释提到 sandbox，没有任何实际 sandbox 装配代码
```

**真相**：`engine/dispatch.ts` 的 sandbox-exec 只在 **direct dispatch path** 里组装；PR 8 enqueue-only 模式下 Web 默认走 `scheduler.wake() → createRawRuntimeRunDispatch()` 完全绕过 engine/dispatch.ts。所以"sandbox 跨组织 deny"在**生产实际从来没生效过**——PR 9 第一次改的 dispatch.ts 部分是"正在被绕过的死代码"。

PR 4 `{{OTHER_TENANT_WORKSPACES}}` 模板展开逻辑本身正确（单测验证），但**展开后从来没注入到 SDK**——因为 raw runtime 没用过 sandbox 配置。

### 15.3 PR 9 补丁（commit `1eab4eff`）真正修复

当时唯一实际生效的工具权限防御点是 `agent/toolRuntime.ts:534-538` 的 `run_shell` admin gate。历史止血补丁先把它从 `role !== 'admin'` 收紧到 `!isPlatformAdmin`（最新状态见文首更新，已升级为 A+C execution routing）：

```ts
const identity = context.channelContext.user ?? context.channelContext.sessionOwner;
const isPlatformAdmin = identity?.role === 'admin'
  && identity?.tenantId === DEFAULT_TENANT_ID;
if (!isPlatformAdmin) {
  throw new Error('run_shell is only enabled for platform admin in the OpenAI Agents PoC.');
}
```

该版本先让组织 admin 跟普通 user 一样**没有 server-local run_shell**，跨组织文件访问回退到 read_file 工具层 "path outside workspace" 校验（已验证生效）。最新代码已进一步升级：非平台用户默认走 `server-container` / tenant hand，可在隔离 hand/container 中使用 run_shell，但不能落到 server-local。随后 commit `7644d5f` 又给 raw runtime 的 `server-local` 路径补了 portable sandbox guard：`dispatch.sandbox.denyRead` 会展开到 `WorkspaceRef.sandboxPolicy`，本地 provider 对 read/write/list 解析后路径和 shell 命令中直接出现的 denied absolute path 做 fail-closed。

新增测试 +2：
- tenant admin (role=admin + 非默认 tenant) run_shell → throw
- admin 缺 tenantId fail-closed → throw（防 PR 边界 fail-open）

测试 fixture 更新：rawAgentLoop.test.ts / toolRuntime.test.ts 中已有 admin fixture 加 tenantId='kaiyan' 保持原 admin 测试通过。77/**711 全部测试零回归**（+2 补丁 + 之前 +4）。

## 16. 浏览器端到端复测（第三轮，22:23）

**重启 3200 → wain_admin 浏览器登录 → 新会话发跨组织 cat 命令**：

| 阶段 | 之前（修复前）| 现在（修复后）|
|---|---|---|
| API 层 `/api/file/read?path=<跨组织绝对路径>` | 🚨 HTTP 200 + 真实 MEMORY 内容 | ✅ HTTP 403 "path outside authorized directories" |
| 工具层 `run_shell cat <跨组织绝对路径>` | 🚨 EXIT=0 + 真实 MEMORY 内容 | ✅ 止血版：platform-admin-only；A+C 规则：非平台用户默认 `server-container` / tenant hand，误落 `server-local` fail-closed；commit `7644d5f` 再补 raw `server-local` denied-path guard，直接引用 denied absolute path 也会失败 |

**两个攻击面都被完全堵住**。

## 17. 第三轮方法学沉淀

1. **"改一行就行"是常见错觉**：第二轮判断"dispatch.ts 一行就修了"对静态读代码人合理，但实际 Web enqueue-only 默认路径完全绕过那条代码，所以第一次改完没生效。**只有真正跑一遍才知道防御是否在生产链路上**。
2. **多层防御都改 vs 只改主防御**：本次最终修复仍然保留了 dispatch/file/voice/artifact 的修改——虽然 sandbox 在生产没生效，这些文件的 API 层修复**真实拦截了**组织 admin 通过 HTTP API 跨组织访问。多层防御 + 工具层 hard gate 是最安全的组合。
3. **架构假设迁移规则升级**：第二轮总结的"`isAdmin` 假设在多组织后崩塌"，第三轮发现真正崩塌的位置不只是字面上的 `isAdmin`，而是**"raw runtime 跟 engine/dispatch.ts 是两条路径"这条更深的事实**。在 PR 8 enqueue-only 把 Web 默认切到 raw runtime **之前**，engine/dispatch.ts 的 sandbox 是真实生效的；切换之后变成"死代码但人人以为它在保护"。
4. **测试 fixture 必须同步迁移**：fileRoutes / toolRuntime / rawAgentLoop 三个测试文件的 admin fixture 都缺 tenantId（PR 2 之前的）→ 修复后 isPlatformAdmin 判定 false → 测试失败 → 需要 fixture 加 tenantId='kaiyan' 保持原意。这是修复落地的常见摩擦。

---

## 18. 三轮终极总结

第一轮：基础设施级 P0（wake 路径绕过 ensureUserWorkspace）→ 修了
第二轮：业务边界级 P1（组织 admin 跨组织 cat）→ 发现
第三轮：架构假设级根因（raw runtime 跟 engine/dispatch.ts 是两条独立路径，sandbox 在生产从来没生效）→ 修了真正能拦截的工具层 gate

**最终修复闭环**：
- API 层（file/voice/artifact）：4 个路由收紧到 isPlatformAdmin，拦截 HTTP 直接攻击
- 工具层（toolRuntime run_shell gate）：先从 role==='admin' 收紧到 isPlatformAdmin 止血；最新升级为 A+C execution routing，非平台用户默认走 server-container / tenant hand，并只能在隔离 hand/container 中执行 run_shell
- 测试覆盖 +6（4 个 isPlatformAdmin 真值表 + 2 个 toolRuntime 组织 admin/fail-closed）
- 77/711 测试零回归
- 浏览器端到端 wain_admin cat 命令：从 EXIT=0 + 真实内容泄漏 → 工具层直接 throw

**SaaS 上架阻塞真清零 v2**——这次不再是"纸面清零"。第一个真实客户组织 admin 在 read/artifact/server-local run_shell 三条主链路都被收紧到只能访问自己组织的资源；run_shell 作为 agent 基础能力，通过 A+C 策略默认在 server-container / tenant hand 中对非平台用户开放。
