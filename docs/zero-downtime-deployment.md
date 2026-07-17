# 零停机部署（蓝绿）

> 2026-07-15 上线。本文是生产蓝绿部署的机制说明与运维手册，一切细节以
> `.github/workflows/ci.yml` deploy-ecs job、`server/src/index.ts`、
> `server/src/app/runtime.ts`、`server/src/runtime/cronLeadership.ts`、
> `daemon-packaging/systemd/agent-saas-server@.service.template` 为准。
> 单实例时代的基础信息（NAS 布局、PAT 注入等）见 [ECS 直部署](ecs-direct-deployment.md)。

## 1. 背景与目标

旧流程是 Recreate 式：`systemctl restart agent-saas-server`，新旧进程不重叠，
每次发版必然停机，且有三个放大因素：

- **启动全量 skills sync 阻塞 listen**：旧实现启动时无条件对全部用户做全量
  `syncSkills`，16 用户实测约 165s（`server/src/app/runtime.ts` 注释），期间进程
  不 listen，`healthz` 全红；
- **部署要等 idle 窗口**：为了不打断活跃 WS 流/运行中的 run，旧部署脚本要等实例
  空闲（最长约 360s 的等待窗口）才敢 restart，发版时机受在线业务钳制；
- **失败回滚双倍停机**：restart 起不来时要再 restart 回旧版本，停机时间翻倍。

蓝绿改造后的目标与现状：

- 部署期间公网 `healthz`、只读业务 API 与 WebSocket 建连持续探测全绿，任何一次
  失败都会触发 CI 硬门禁（见 §9.4）；
- 新版本所有校验（ready / warmup / 冒烟）在**切流前**完成，任何失败只回收
  idle 色，老色全程在服务，用户零影响；
- 旧实例用 SIGUSR2 精确 drain：拒新流量、结清 cron、交出 leadership、
  等活跃流清空后自退，不打断在途会话；
- 回滚一条命令（`bash /opt/agent-saas-app/rollback.sh`），快路径只翻 nginx。

## 2. 架构总览

前端主链路已剥离到 OSS，API/WS 走独立域名，蓝绿只发生在 API 侧；ECS
保留由 Web 发布链独立维护的静态冷灾备，不进入 Server release：

```
                        用户浏览器 / 客户端
                    ┌──────────┴───────────┐
          静态资源 (HTTPS)          API / WS (HTTPS / WSS)
                    │                      │
           agent.kaiyan.net        api.agent.kaiyan.net
           (CNAME → OSS)                   │
                    │                      ▼
        ┌───────────────────┐   ECS nginx（/etc/nginx/conf.d/agent-api-kaiyan.conf）
        │ OSS bucket        │              │ proxy_pass
        │ agent-saas-web    │              ▼
        │ (ci.yml           │   upstream agent_saas_backend      ←── 蓝绿切流点
        │  deploy-web-oss)  │   (/etc/nginx/conf.d/agent-saas-upstream.conf，
        └─────────┬─────────┘    部署脚本重写：新色 primary、旧色 backup)
                  │ 同一份分域构建               │
                  ▼                              │
      ECS recovery-web（冷灾备）                 │
      /opt/agent-saas-web-recovery/current       │
      shared-root 跨版本保留 hash/Workbox 资源    │
      nginx 直接静态读取，不经过 Server           │
                                  │ primary              │ backup
                                  ▼                      ▼
                     agent-saas-server@blue   agent-saas-server@green
                     127.0.0.1:3200           127.0.0.1:3201
                     代码: color/blue → …     代码: color/green → …
                                  │                      │
                                  └─────────┬────────────┘
                                            ▼
                    共享层（双色同读写，蓝绿并存期的正确性边界所在）
                    ├─ PG：runtime events / runs(lease) / cron leader 锁
                    └─ NAS /mnt/agent-saas：server-data（server/data 软链）、
                       workspaces/<tenantId>/<userId>
```

关键约定（`agent-saas-server@.service.template` 头注释）：

- systemd 模板实例 `agent-saas-server@blue`（3200）/ `@green`（3201）；每色
  端口与 pidfile 由 `/etc/agent-saas/server-<色>.env` 提供（`PORT`、
  `AGENT_SAAS_PIDFILE=/run/agent-saas-server-<色>.pid`），手工创建一次，不随部署改写；
- 每色代码走固定 symlink `/opt/agent-saas-app/color/<色>` → `releases/<sha>`。
  部署只改 idle 色的 symlink，active 色的 symlink 永不动，保证 active 色
  crash-restart 时仍加载自己的代码版本；
- 活动色标记 `/etc/agent-saas/active-color`（内容 `blue`|`green`），部署脚本在
  切流成功后改写；
- `Restart=on-failure`：drain 完成后进程自行 `exit(0)` 不会被拉起，崩溃
  （非零退出/信号）仍自动重启；
- PG 角色 `agent_runtime_app` 的连接上限为 20。共享查询 Pool 默认 `poolMax=6`
  （可由 `runtimeEventStore.poolMax` 调整），加上每实例各 1 条 LISTEN 与 cron
  leadership 专用连接，蓝绿并存时最多占 16 条，保留 4 条运维余量；
- `/etc/nginx/conf.d/agent-kaiyan.conf` 是 `agent.kaiyan.net` 冷灾备静态站点，
  直接读取 `/opt/agent-saas-web-recovery/current`，不再引用 `agent_saas_backend`；
  正常生产 DNS 指向 OSS，只有 OSS 故障回切 DNS 后才承载用户流量。
- recovery vhost 使用 `/etc/nginx/ssl/agent-kaiyan-recovery` 中与 OSS 同步的 CAS
  证书；每次 OSS 续证必须同步 ECS，并以 `curl --resolve` 直连门禁确认。

## 3. 部署流程

触发方式（ci.yml 头注释）：`push main` 只构建 + 测试 + 打包，**不部署生产**；
发版走 `workflow_dispatch`（Actions 页面手动触发或 `gh workflow run ci.yml`）。
`deploy-ecs` 与 `deploy-web-oss` 同为 dispatch-only；后端成功后才发布 OSS 和
独立 recovery-web，保证版本一致且 Server release 不含前端文件。

整条手动发布 workflow 使用固定 concurrency group，`cancel-in-progress=false`：同一时间
只允许一个批次从 build 走到 Web OSS 发布结束；普通 push CI 使用独立 `run_id`，不受
生产发布队列影响。远端脚本还会非阻塞获取
`/run/lock/agent-saas-deploy.lock` 的 `flock`，覆盖手工 SSH 等绕过 GitHub Actions 的入口。
两层任一冲突都不会等待或打断在途发布，后发远端批次直接失败并删除自己的独立上传包。

deploy-ecs 远端脚本（ci.yml「Deploy and restart」step 内嵌，编号与脚本注释一致）：

| 步 | 动作 | 失败时 |
| --- | --- | --- |
| 0 | 获取 ECS `flock`，安装/刷新超龄部署包清理 timer，并立即执行一次清理 | 上传包自动回收；活动色不动 |
| 1 | 前置校验：`/etc/agent-saas/active-color` 存在且为 `blue|green`，`agent-saas-server@<active>` 必须 active，否则要求先完成一次性手工迁移。据此解析 idle 色/端口 | 直接退出，什么都没动 |
| 2 | 安装前清理旧 release：保留最近 4 个现有版本 + current/previous + 两个 color symlink 的 target；同 SHA 的未完成目录直接回收，活动版本则幂等 no-op；随后校验至少 8 GiB 可用空间与 25 万可用 inode | 切流前失败，老色照常服务；上传包自动回收 |
| 3 | 解包 release 到 `releases/<sha>`，`server/data` 软链到 NAS，以 `node-linker=isolated` 安装 server/shared 依赖；安装阶段失败自动删除当次 release 与上传包 | 同上 |
| 4 | idle 色残留处理：上次部署的旧色可能还在 drain，最多等 600s，超时 `systemctl stop` 强停 | 同上 |
| 5 | 更新 symlink：只动 `color/<idle>` → 新 release；`current`/`previous` 仅作 bookkeeping | 同上 |
| 6 | `systemctl start agent-saas-server@<idle>` + **ready 硬门禁**：等 `/api/healthz/ready` 200，最长 180s | `rollback_idle_and_exit`：stop idle 色 + 还原 current/previous/idle 色 symlink + 删除当次 release/上传包，nginx/active-color 全程未动 |
| 7 | **warmup 软门禁**：等 ready 载荷 `warmup.state=done`，最长 420s；`failed`/超时降级为警告继续（dispatch 时增量同步兜底，见 §7） | 不失败，仅告警 |
| 8 | 冒烟：idle 端口 `/api/healthz` 200 且 `/api/healthz/drain` 返回合法 JSON | `rollback_idle_and_exit` |
| 9 | 切流：重写 `/etc/nginx/conf.d/agent-saas-upstream.conf`（新色 primary、旧色 backup）→ `nginx -t` → `systemctl reload nginx` → 经 `https://127.0.0.1`（Host: api.agent.kaiyan.net）验证，最多重试 10 次 | `nginx -t` 失败还原 conf；reload 后验证失败把 nginx 翻回旧色再 `rollback_idle_and_exit` |
| 10 | 更新 `/etc/agent-saas/active-color` 为新色 | — |
| 11 | 重新生成 `/opt/agent-saas-app/rollback.sh`（蓝绿语义，幂等覆盖，见 §9.1） | — |
| 12 | drain 旧色：`kill -USR2 $(cat /run/agent-saas-server-<旧色>.pid)` 精确送 node 主进程；pidfile 缺失/kill 失败则降级 `systemctl stop`（SIGTERM，可能打断活跃流）。观察 60s，未退不算失败（后台继续排空，下次部署最多等 600s） | — |
| 13 | 收尾：`pnpm store prune` + 删除上传包 | — |

核心设计：**门禁前移**。步骤 6-8 的所有校验都发生在切流（步骤 9）之前，此时
公网流量 100% 在老色上；所以「部署失败」对用户是不可见事件，只是这次发版没发出去。

> 为什么 drain 不能用 `systemctl kill`：默认按 cgroup 广播信号，SIGUSR2 对无
> handler 的 SDK 子进程默认动作是终止，会误杀执行中的 agent 子进程。必须
> `kill -USR2 $(cat pidfile)` 只打 node 主进程（pidfile 由 `writePidFile()`
> 在启动时按 `AGENT_SAAS_PIDFILE` 写入，`server/src/index.ts`）。

CI 侧还有两个配套 step（不在远端脚本内）：

- **Start zero-downtime probe**：远端部署开始前，runner 起后台循环，每轮同时打
  `GET /api/healthz`、只读 `GET /api/signup/status`，并对 `/ws?probe=1` 完成真实
  WebSocket upgrade、校验固定 pong 后关闭；逐行记录四项结果；
- **Assert zero downtime**：部署结束后（`if: always()`）统计探测日志，见 §9.4。

## 4. 探针语义表

路由定义在 `server/src/routes/health.ts`，生产挂载于 `/api` 前缀下：

| 端点 | 谁用 | 返回 | 何时 503 |
| --- | --- | --- | --- |
| `/api/healthz` | nginx/LB 轻量探针；CI 零停机公网探测；远端脚本冒烟 | 纯文本 `ok` / `draining` | draining 时 |
| `/api/healthz/live` | liveness：systemd/监控判「要不要拉起/告警」 | 200 `ok` | 永不——进程在即 200，不反映可服务状态 |
| `/api/healthz/ready` | readiness：部署门禁在新色端口上等它 200 才切流 | JSON `{status, draining, warmup}`；`warmup` 含 `state/totalUsers/processedUsers/syncedUsers/...` | draining 时。注意 warmup **不** gate ready（未完成时 dispatch 侧版本化同步兜底正确性），是否等 `warmup.state=done` 由部署脚本自行决定 |
| `/api/healthz/drain` | 发布脚本判断实例是否排空/可切 release | JSON `{status, draining, activeStreams, activeRuns{pending,running,waitingApproval,waitingUser,waitingHand,blocking,total}, idle}`；`idle = !draining && activeStreams==0 && activeRuns.blocking==0` | draining 时；或 activeRuns 查询失败（此时 `status:"error"`） |

另有面向人的 `/api/health`：未认证仅回 `{status}`，认证用户附带 uptime、内存、
activeStreams、dispatch 指标，始终 200，不作机器门禁用。

## 5. drain 生命周期

入口在 `server/src/index.ts` 的 `process.on('SIGUSR2', ...)`：

```
kill -USR2 <node 主进程>
  │
  ├─ isDraining = true；channelManager.draining = true
  │    → 新 WS 流被拒；/api/healthz、/healthz/ready、/healthz/drain 转 503
  │    → nginx upstream 里该色已是 backup，本来就没有新流量
  ├─ httpServer.close()：停止接受新 HTTP 连接（已建立的 WS/流不受影响）
  ├─ 停 dwsAuthKeepalive、kbPreviewScheduler
  │
  ├─ beginRuntimeDrain()（runtime 侧按序 quiesce，顺序敏感）:
  │    1. 停 memory-poll reconcile 定时器
  │    2. 停 cron 触发（不打断执行中的 cron job）
  │    3. 等 in-flight cron job 结清（quiesce deadline 10min）——旧实例执行完的
  │       saveJobs（lastRun 等）必须先落盘，否则新 leader 读到回退状态会重复触发
  │    4. 释放 cron leadership（PG advisory lock）→ 新实例 ≤15s 接管
  │    5. 停 runtime scheduler：不再 claim 新 run，并等 in-flight run 结清
  │
  ├─ 每 2s 轮询：activeStreams == 0 且 runtimeQuiesced？
  │    ├─ 是 → finishDrain：shutdownCleanup()（关 store/MCP/子进程、删 pidfile）
  │    │        → process.exit(0)
  │    └─ 否 → 继续等，直到 drain deadline
  │
  └─ drain deadline（默认 15min，AGENT_SAAS_DRAIN_DEADLINE_MS 可调）:
       到点仍未清空 → 放弃等待，强制走 finishDrain → exit(0)
       （被打断的 run 由新实例经 lease 过期恢复续跑，见 §10）
```

**退出码约定**：所有 drain 出口都是 `exit(0)`——包括 deadline 强制退出、
清理超时（30s force timer）——因为 unit 配置 `Restart=on-failure`，exit 0
不会被 systemd 拉起，已排空的旧色绝不能复活；崩溃（非零退出/信号）仍自动重启。
drain 进行中收到 SIGTERM（例如部署脚本降级路径的 `systemctl stop` 兜底），
`gracefulShutdown` 跳过继续等待直接清理退出，其强杀 timer 的退出码也按
`isDraining ? 0 : 1` 处理，同一原则。

蓝绿模式下旧色在后台排空、不阻塞部署主流程（脚本只观察 60s），因此 deadline
可以放到 15min，给长 run 充足余量；下一次部署若发现 idle 色还在 drain，最多再
等 600s（§3 步骤 4）。

## 6. cron 单例 leadership

机制（`server/src/runtime/cronLeadership.ts` 头注释）：

- **为什么需要**：CronService 是「进程内 setTimeout + 共享 jobs.json」的调度器，
  没有跨进程互斥；蓝绿并存期两实例同时跑 cron 会导致同一任务双触发
  （双 LLM run / 双扣费 / 双通知）；
- **选主**：基于 PG session 级 advisory lock，
  `pg_try_advisory_lock(hashtext(lockName))`；锁名为
  `<tablePrefix>:cron-leader`（tablePrefix 参与锁名，共库多环境不互相抢锁）。
  持锁者才 `cronService.start()`；
- **接管**：落选实例按 retryMs（默认 15s）轮询重试。旧实例 drain 退出/崩溃时
  PG session 断开自动释放锁，新实例在一个重试周期内（≤15s）接管；
- **意外失联**：leader 的 PG 连接意外断开 → 立即回调 `onLost` 停掉本地 cron
  （锁已随 session 释放，其他实例可能已接管），随后重连重新竞选；
- **自愿退出**：drain/关停走 `stop()`，不触发 `onLost`，由 `beginRuntimeDrain`
  按顺序自行 quiesce（先结清 in-flight cron 再释放锁，见 §5）；
- **单实例开发环境**：runtimeEventStore 非 pg backend、没有连接串 → 直接视为
  leader，行为与历史版本一致。

已知边界（照头注释，接受并记录）：

- 网络分区且 TCP 未 RST 时，旧 leader 感知断连有延迟，存在**秒级双跑窗口**，
  最坏后果是单个到期任务重复执行一次；
- leadership 切换间隙（≤retryMs）到期的任务会延迟到新 leader 接管后按
  catch-up 逻辑补跑。

## 7. skills 同步机制

旧的「启动无条件全量 syncSkills」（16 用户实测约 165s，阻塞 listen）已拆掉，
替代方案是**内容指纹 → configVersion → 版本化同步**
（`server/src/data/skills/contentFingerprint.ts`、`server/src/app/runtime.ts`）：

1. **启动同步段（快，配置级）**：`syncWithPool` 补全配置 +
   `computeSkillsContentFingerprint` 比对指纹。指纹变化（通常随新 release 携带
   skill 内容变更）→ `setPoolContentHashSync` 落盘新指纹并 bump
   `configVersion`。指纹基于文件内容而非 mtime，所以 no-op 部署/重启不触发
   全用户复制风暴。两类来源不同取证策略：
   - pool（随 release 打包，tar 后 mtime 必变）：相对路径 + 文件内容 sha256，
     同内容跨 release 稳定；pool 都是小文件且在本地盘，全量读代价可忽略；
   - 租户自有 skill 目录（共享数据盘，不随 release 重建，可能含大参考文件）：
     相对路径 + size + mtimeMs，避免每次启动在 NAS 上全量读大文件。
2. **物化：三条版本化同步路径**，都以「用户 workspace 的 `.skills-version` <
   `configVersion`」为触发条件：
   - **启动后台 warmup**（listen 后经 `runDeferredStartupTasks` 执行的
     `skills-warmup` 任务）：逐用户版本检查物化 + prune 幽灵条目 + 写版本标记，
     逐用户 yield 事件循环避免饿死在线请求；进度经 `/api/healthz/ready` 的
     `warmup` 字段暴露，部署门禁软等 `done`；
   - **dispatch 时 `refreshUserWorkspace`**（`server/src/engine/dispatch.ts`）：
     用户发起会话时版本检查兜底——正确性不依赖 warmup 完成，这就是 warmup
     只是软门禁的原因；
   - **cron 执行时 `refreshUserWorkspace`**（`server/src/cron/executor.ts`）：
     定时任务触发前同样做版本检查。

跨实例窄竞态：`skills-config.json` 与用户 workspace 都在共享盘上，但
`SkillConfigStore` 的 mutation 串行化只在**进程内**（`store.ts` 的
mutationChain）。蓝绿并存期两实例各持一份内存态，可能并发读写同一份
skills-config.json / 并发对同一用户 `syncSkills`，存在短暂的版本感知不一致。
窗口只在部署重叠的几分钟内，且任何一次后续 dispatch 的版本检查都会收敛，接受。

## 8. 数据库迁移纪律（红线）

**蓝绿 = N 与 N+1 两个代码版本并存、同时服务同一个 PG。** 切流后旧色还要
drain 最长 15min（下次部署前甚至更久），期间旧代码继续读写库。任何让旧代码
跑不下去的 schema 变更都会把「零停机部署」变成「部署即事故」。

规则：

- **允许（可随代码同版发布）——加法式变更**：
  - `CREATE TABLE IF NOT EXISTS ...`
  - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`，且新列**可空或带默认值**
  - `CREATE INDEX IF NOT EXISTS ...`（大表用 `CONCURRENTLY`，避免锁表拖垮旧色在途请求）
  - 新增旧代码不感知的表/列，旧代码 `SELECT` 明确列名不受影响。
- **禁止直接发布——破坏性变更必须 expand → confirm → contract 拆两次发布**：
  - `DROP TABLE` / `DROP COLUMN`
  - `RENAME` 表/列
  - 改列类型（含收窄长度/精度）
  - 加无默认值的 `NOT NULL` 约束
  - 流程：**expand**（发布 1：加新表/新列，代码双写或兼容读新旧两处）→
    **confirm**（观察至少一个完整发布周期，确认没有旧色实例仍依赖旧结构，
    必要时回填数据）→ **contract**（发布 2：删旧结构）。两次发布之间必须
    间隔至少一次完整的蓝绿轮转。

禁止事项清单：

- 禁止在迁移里 `DROP`/`RENAME`/改类型「顺手带上」——哪怕这列「看起来没人用」；
- 禁止无默认值的 `NOT NULL` 新列（旧代码 INSERT 不带该列会直接报错）；
- 禁止依赖「部署完成后旧实例立刻消失」的假设写一次性数据订正——旧色 drain
  期间还在写库；
- 禁止在启动路径跑长事务 DDL（锁表会让 ready 门禁超时，还会卡住老色在途请求）。

Review checklist（PR 涉及 schema/DDL 时逐条过）：

1. 这条 DDL 在**旧版本代码**还在跑的前提下执行，旧代码的所有读写还成立吗？
2. 新列是否可空或有默认？新表是否 `IF NOT EXISTS`、可被旧代码完全无视？
3. 有没有 DROP/RENAME/改类型/加 NOT NULL？有 → 是否已拆成 expand→confirm→contract 两个 PR，且 contract 前置条件写清楚了？
4. 大表索引是否 `CONCURRENTLY`？启动路径有没有可能长时间持锁？
5. 回滚（nginx 翻回旧色）后，旧代码对着新 schema 还能正常服务吗？

## 9. 运维手册

### 9.1 手动回滚

```bash
ssh <ecs> 'bash /opt/agent-saas-app/rollback.sh'
```

`rollback.sh` 由每次部署重新生成（手工修改会被下次部署覆盖），两条路径：

- **快路径**：上一色 unit 还 active（还在 drain、进程仍跑旧代码）→ 只重写
  upstream conf 把 nginx 翻回去 + 改回 active-color，秒级完成；
- **慢路径**：上一色已退出 → `color/<上一色>` symlink 指向 `previous`
  release → `systemctl start` → 等 ready（最长 180s）→ 翻 nginx + 改 active-color。

注意回滚**不会** drain「被回滚掉的色」，它以 backup 身份留在 upstream 里；
后续处置（重新发版或手动 drain）自行决定。

### 9.2 看 drain 进度

```bash
# 日志：每 2s 一行 "Drain: N active stream(s) remaining, runtimeQuiesced=..."
journalctl -u agent-saas-server@<色> -f

# 数字：activeStreams / activeRuns / idle（draining 时本端点返回 503 属正常）
curl -s http://127.0.0.1:<3200|3201>/api/healthz/drain | python3 -m json.tool
```

### 9.3 强停 draining 实例

确认可以牺牲残留流（或已确认 `activeRuns.blocking=0`）时：

```bash
systemctl stop agent-saas-server@<色>
```

SIGTERM → `gracefulShutdown`（drain 中收到会跳过等待直接清理），≤30s 内自行
退出；`TimeoutStopSec=35` SIGKILL 兜底。drain 语义下退出码为 0，不会被
`Restart=on-failure` 拉起。被打断的 run 走 lease 恢复（§10）。

### 9.4 零停机门禁在 CI 的位置

`deploy-ecs` job 的 `Start zero-downtime probe` / `Assert zero downtime` 两个
step 持续覆盖三条用户路径：轻量 `healthz`、经过 Express 路由与动态配置读取的
注册状态业务 API、经过 nginx 和 Node upgrade handler 的 WebSocket 建连。断言规则是
**所有样本必须全部成功，不容忍单次失败**。deploy step 失败时 Assert 只打印报告
不守门（旧色未动，探测本应全绿）。

首次发布 `/ws?probe=1` 时，旧版本仍会按未鉴权请求返回 401，因此 CI 自动进入一次性
bootstrap 模式：切流前只允许 `legacy-auth`，且切流后必须至少观察到一次固定 pong；
生产已有该端点后，后续发布自动进入 strict 模式，401 同样计为失败。发版后看
`probe summary: mode=... total=... health_failures=... api_failures=... ws_failures=...`
即为本次发布的实测连续性结果。

### 9.5 发布互斥与超龄上传包清理

GitHub Actions concurrency 覆盖整条 dispatch；ECS 锁覆盖远端脚本本身：

```bash
# 锁文件长期存在是正常的；锁状态取决于 fd，不靠删除文件释放
flock -n /run/lock/agent-saas-deploy.lock true

# timer 应为 enabled + active，服务每小时执行一次
systemctl is-enabled agent-saas-deploy-maintenance.timer
systemctl is-active agent-saas-deploy-maintenance.timer
systemctl list-timers agent-saas-deploy-maintenance.timer --no-pager

# 查看最近一次清理结果；被删路径会逐条写入 journal
journalctl -u agent-saas-deploy-maintenance.service -n 50 --no-pager
```

每次上传包名包含 `GITHUB_RUN_ID` 与 SHA，避免同 SHA 的异常并发互相覆盖。正常成功、
可捕获失败仍即时删除；systemd timer 只删除 `/tmp` 顶层、精确匹配
`agent-saas-*.tgz` 且修改时间超过 24 小时的普通文件。timer 每小时运行并带 5 分钟
随机抖动，服务器关机错过的周期在开机后补跑。

### 9.6 根盘告警

根盘同时有两层观测：应用内 `SystemMetricsCollector` 每 10 分钟采样 `/`，平台
attention 在使用率 80%/90% 分别标 high/critical；基础设施层使用阿里云云监控
主机插件和独立阈值规则，经「云账号报警联系人」发送短信/邮件。基础设施告警不依赖
Agent SaaS 进程存活。生产规则 `agent-saas-root-disk-utilization` 只绑定实例根盘设备
`/dev/vda3`：平均使用率连续 3 个 60s 周期达到 80% 发 warning，单个周期达到 90%
发 critical，静默重发间隔 4 小时，全天生效；生产验收结果记录在当日运维日志。

## 10. 已知限制

1. **cron CRUD 与旧实例末次 saveJobs 的窄竞态**：drain 步骤会等旧实例
   in-flight cron job 结清并落盘 `saveJobs`（写整个 jobs 数组）后才释放
   leadership；若恰在此窗口内用户经新实例做了 cron CRUD，旧实例的末次全量
   写盘可能覆盖它。窗口 = 旧实例最后一个 cron job 的收尾时刻，秒级，接受。
2. **网络分区秒级双跑**：PG advisory lock 依赖 session 断连释放；TCP 未 RST
   的分区下旧 leader 感知有延迟，单个到期任务最坏重复执行一次（§6）。
3. **跨实例 skills sync 竞态**：蓝绿并存期两实例内存态各自为政，可能并发写
   skills-config.json / 并发同步同一用户 workspace；后续任一 dispatch 的版本
   检查会收敛（§7）。
4. **drain deadline 打断长 run 的 lease 恢复语义**：超过 15min 的 run 被强制
   退出打断后，其 PG run 记录的 lease 到期，新实例 scheduler 的恢复扫描
   （`server/src/runtime/runStore.ts` `listRecoverable` 捡起 `lease_expires_at`
   过期的 running run → `acquireLease` 抢占 → autoWake 续跑）接管执行；
   WS 客户端自动重连后按 eventId cursor 从 PG 事件流回放，不丢消息。代价是
   run 有一段「无人执行」的间隙（≈ lease 剩余时长 + 恢复扫描周期），以及
   续跑从上一个持久化状态继续而非精确断点。
