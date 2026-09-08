# 后端数据一致性与 Runtime 可靠性体检

体检日期：2026-09-08。代码基线：`main` / `a6b6865e`。本文是总报告的后端专题；编号 `REL-xx` 可直接用于后续 issue、修复 PR 与回归验收。此轮只做代码检查、隔离故障注入与报告撰写，没有修复业务实现、连接生产数据库或操作真实用户数据。

## 阅读结论

当前 Runtime 已有实质性的恢复设计：RunStore 的 CAS、session 租约、终态事件 outbox、工具取消投递租约、PG 事件幂等键、NOTIFY 丢失补扫、ACS UID/resourceVersion 栅栏和后台 Shell 保护等，不宜推倒重做。最突出的问题集中在这些可靠组件之间的边界，以及仍以 JSON 文件和 SQLite 汇总表保存的业务状态。

优先处理的不是“代码太大”，而是几类具体失败：用户创建查重存在异步竞态；部分文件读取错误会被解释为空库；原始 PG 锁连接断开缺少本地失效处理，可能退出进程，也可能被全局安全网抑制后继续失锁运行；生产部署中同一 Cron 文件可能使用不同锁名；Cron 执行完成与日志/通知交付之间缺少持久化交接。另有与计费水位、启动扫描和 SQLite 有关的故障机制，均给出了触发前提和复现证据。

“已证实”表示当前代码中的机制已通过调用链或隔离 fixture 证实，**不表示已证明线上发生过同样事故**。“条件风险”表示只有列明的部署、数据或故障条件成立才触发。没有生产配置、数据库角色设置、NFS 行为或真实负载证据的地方，本文不会作线上定论。

| ID     | 问题                                                                | 优先级 | 证据等级                                                        | 建议工作量 |
| ------ | ------------------------------------------------------------------- | ------ | --------------------------------------------------------------- | ---------- |
| REL-01 | UserStore 并发创建重复用户名、跨实例旧快照覆盖新数据                | P1     | 隔离复现                                                        | 3–5 人日   |
| REL-02 | Users/Groups/Agents 的读错误或 JSON 损坏被当空库，后续覆盖原件      | P1     | 代码链路 + GroupStore 隔离复现                                  | 2–3 人日   |
| REL-03 | SQLite migration 的 DDL 与 schema_version 非原子，故障后无法重跑    | P2     | 内存 SQLite 故障注入复现                                        | 1–2 人日   |
| REL-04 | Cron/业务文件 PG 锁连接缺失效管理：异常退出或继续失锁运行           | P1     | 独立 PG + 子进程复现 exit 1；全局网络错误抑制分支经源码复核     | 2–4 人日   |
| REL-05 | Cron 已提交 terminal 后，运行日志/通知失败没有可恢复投递状态        | P1/P2  | 内存 CronService 故障注入复现                                   | 3–5 人日   |
| REL-06 | 同一共享 Cron 文件经不同部署路径访问，PG 锁键不一致                 | P1     | 部署/代码链路 + 独立 PG 验证锁可重叠；生产配置待核实            | 2–4 人日   |
| REL-07 | Billing 扫描没有使用提交顺序屏障，混合 writer 时可跳过晚提交低序号  | P1     | 独立 PG 复现；仅混合 writer 等条件下触发                        | 2–3 人日   |
| REL-08 | 启动清理/重建把不完整扫描当完整事实，可能清关联或清统计             | P1     | 代码链路 + SQLite 重建隔离复现                                  | 2–4 人日   |
| REL-09 | Cron executionLedger 无限增长，每次变更全量读写、运行中定时全量刷新 | P2     | 已证实增长机制；规模影响需压测                                  | 3–5 人日   |
| REL-10 | PG 全局事件锁与关键查询缺统一期限，单点等待可放大为调度停滞         | P2     | 已证实配置缺口；实际超时可能由 DB role/URL 补充                 | 2–4 人日   |
| REL-11 | SQLite 实时用量日表/分钟表非原子，失败后形成永久不一致              | P2     | 内存 SQLite 故障注入复现                                        | 1–2 人日   |
| REL-12 | 内置 Agent Profile 仅接受紧邻前版升级，旧 v1 跨版本恢复后停留旧配置 | P2     | 主审查者隔离真实 PG 补测 + SQL/调用链复核；仅旧库跨版本条件触发 | 1–2 人日   |

工作量包含针对性实现和回归，按熟悉仓库的工程师估算，不包含审批、发布窗口、生产数据恢复、全面存储迁移或等待观察期。REL-01/02/04/06 有共用基础设施，可以一起设计，但不建议一次性重写全部 Store。

## 检查范围与运行方式

已阅读 `CLAUDE.md`、`docs/architecture/project-architecture.md`、Runtime EventStore retention runbook 与 Runtime dependency identity 文档，并对以下路径作了定向追踪：

- 数据源：`data/users`、`groups`、`agents`、`tenants`、`db`、`usage`、`billing`、transcript/meta 与启动迁移。
- 执行：`rawRuntimeRunDispatch`、`scheduler`、RunStore 的事件写入、终态协调器、工具调用恢复与取消投递、session 租约、流中继。
- 进程：AppRuntime 装配、Worker readiness、ConfigIdentity 热更新/回滚、drain 与 systemd 拓扑。
- 定时任务：Cron store、claim、retry、恢复、watchdog、运行日志与通知发送。
- ACS：执行 lease monitor、完成/后台 Shell 恢复、重启 inventory、删除 finalizer、容量 reservation、生命周期控制器和 drain。

验证使用仓库要求的 Node `22.23.1`。文件 fixture 只写入系统临时目录；SQLite 使用 `:memory:`；PG 使用主报告建立的独立本地测试实例 `127.0.0.1:55438/agent_saas_health_test`。本专题没有启动真实应用 server，也没有发模型、钉钉、Kubernetes 或云平台请求。整个项目的全量测试结果见主报告，本专题只记录自己实际执行的故障注入。

## REL-01：UserStore 的原子换文件不能提供并发事务

**级别：P1；已证实；影响身份数据完整性。**

### 证据与触发条件

`server/src/data/users/store.ts:286` 的 `create()` 先检查 username/phone，再在 `:307` 附近执行异步 `bcrypt.hash()`，最后 `users.push()` 和 `persist()`。两个请求可以都在第一次 hash 完成前通过查重。`findByUsername()` 只返回第一个匹配项，重复创建后的身份行为不再唯一。

`server/src/data/users/store.ts:166` 的 `persist()` 把整个进程内 `this.users` 快照写到随机临时文件，再 rename 到目标文件。没有 mutation queue、跨进程锁、版本 CAS，也没有在提交前重新读取文件。随机临时文件和 rename 防的是半截 JSON，不防旧快照覆盖新快照。

实际 HTTP 调用在 `server/src/routes/auth.ts:977`，默认创建路径直接 `userStore.create()`；只有显式提供 debugMode 时才选择 tenant debug 锁，不能把该局部锁当全局用户唯一性门禁。`server/src/routes/signup.ts:515` 也是创建入口。AppRuntime 在每个进程中独立构造 UserStore，见 `server/src/app/runtimeAuthInitialization.ts:25`。

上层保障已复核：`server/src/app/runtimeGovernanceStores.ts:905` 注册的 post-persist observer 只在 users.json 已 rename 后安排 Membership/Assignment 投影，既不包住创建事务，也不能回滚已经重复或被覆盖的 JSON。Canonical Membership 的约束不是 username/phone 文件记录的唯一仲裁。自助注册另有 `signup.ts:456` 的同步验证码消费，所以不能把 Store 级 fixture 表述为“同一进程用同一个验证码即可重复注册”；已证明的可达入口是允许创建账号的管理请求及未统一串行化的 Store 写入。

### 隔离复现

同一个 UserStore 对同一用户名同时调用两次 `create()`：

```text
same_instance_duplicate:
  outcomes = [fulfilled, fulfilled]
  matchingUsers = 2
```

再创建两个 UserStore 实例，均先加载同一份文件；A 改第一个用户，B 随后改第二个用户：

```text
two_instances_lost_update:
  firstUpdateRetained = false
  secondUpdateRetained = true
```

第二个复现甚至不需要同时写磁盘：仅“两个进程持有不同步的快照”就足够。线上蓝绿重叠、API/Worker 共同保存用户状态、同实例 reload 与异步密码操作穿插，都应纳入回归。

### 影响、根因与边界

影响可能是创建成功后账号消失、偏好回退、users.json 中管理员调整的权限/禁用字段被旧快照带回、用户名或手机号出现多个记录。这里的文件字段回退不等于 Canonical Membership、AuthEpoch 等其他权威门禁必然同时失效；`server/src/auth/middleware.ts:119` 仍检查 canonical membership。本文证实了重复创建和丢更新，不据此推断某个攻击者已能获得特定权限；认证撤销与 epoch 的传播见安全专题。

根因是将共享身份数据实现为“加载一次的数组 + 全文件 publish”。单纯给 persist 排队仍不能修复跨进程旧快照；单纯在 bcrypt 后再查一次只能缓解同实例重复，不能保证跨进程唯一。

### 修复方案

1. 短期建立统一 UserStore mutation 事务：进程内排队、跨进程同一逻辑锁名、锁内重读/校验当前快照、复制候选、提交后才更新内存。锁失效处理须使用 REL-04 修复后的契约。
2. 允许把 bcrypt 等昂贵纯计算放到锁外，但用户名/手机号唯一性、最后管理员约束、目标存在性必须在锁内再次校验。不能把旧 UserRecord 引用带进锁后直接保存。
3. 加显式数据 revision；失败时保持先前已提交内存快照。迁移持久化也必须进入同一事务，替换构造函数里的 fire-and-forget 全量写回。
4. 中期将身份记录迁至 PG，并用 normalized username/phone 唯一约束作为最终仲裁。历史同名清理须先生成冲突清单，不能自动按“第一条/最后一条”删除用户。

### 回归验收

- 单实例 50 路相同用户名/手机号创建，只能一个成功，其他返回明确冲突；不同用户名创建全部保留。
- 两个独立进程交替更新不同用户及同用户不同字段，提交结果和 revision 可预测。
- 在 bcrypt 等待期间触发 reload、禁用和密码重置，旧引用不能复活旧状态。
- 写临时文件、rename、锁失效任一步失败时，API 不返回成功，内存不保留未提交身份。
- 数据迁移前后用户 ID、workspace、membership、审计引用可核对。

## REL-02：读错误被误认为空库，会把可恢复故障升级为数据丢失

**级别：P1；已证实代码机制，GroupStore 已隔离复现。**

关键位置：`server/src/data/users/store.ts:103`–`:111`、`server/src/data/groups/store.ts:65`–`:71`、`server/src/data/agents/store.ts:27`–`:33`。这些 load 路径把 JSON.parse、权限、I/O 等异常都捕获后赋空数组/对象。正常不存在与已有文件不可读没有明确区分。解析成功也没有完整持久化 schema 校验，例如缺 `users`/`groups` 会成为空集合。

GroupStore 虽已在 `:129` 以后采用锁内重读和 mutation queue，却仍调用这个“坏文件变空”的 load，再在 `:135` 把新空库快照写回。锁在这里保障了错误操作串行化，不能保障数据有效。

AgentStore 还有启动 `initDefaults()`，见 `server/src/data/agents/store.ts:112`–`:129`：坏文件先变空对象，再为当前用户创建默认 profile，并同步覆盖原文件；该路径甚至不需要用户手动编辑头像或名称。装配在 `server/src/app/runtime.ts:410`–`:416`，前提是已启用并成功装配 UserStore，且用户列表至少有一个需要补默认 profile 的账号；用户列表为空时 `changed=false`，不会单靠 initDefaults 覆盖。

隔离 fixture 给 groups 文件写入 `{broken-json` 后构造 GroupStore，调用一次 `create()`，操作成功且目标文件变成只含新分组的合法 JSON：`corrupt_group_overwritten = true`。原始损坏文件没有保留副本。UserStore 的同类行为会扩大到身份数据；安全专题交叉引用本项。

修复应明确区分三类状态：首次初始化的“不存在”、已验证的“有效空库”、不可读/不合法的“不可用”。只有第一类在经过初始化条件核实后允许创建空库；已有文件坏了应保留原字节并拒绝 mutation。若已有已验证内存快照，可用于明确标记的只读降级，但不能作为新写入的基线。增加持久化 schema/version 校验、结构化告警和可核验的备份恢复流程。AgentStore `initDefaults()` 必须复用同一原子事务，不再直接 writeFileSync 覆盖。

验收覆盖 JSON 截断、结构错误、EACCES、EIO、空文件、未知版本、恢复后 reload。测试须断言故障期间原文件字节未变、没有自动写默认 profile、API 返回可诊断不可用；不要只断言“进程没抛异常”。建议 2–3 人日，与 REL-01 共用存储事务设计。

## REL-03：SQLite 迁移失败后会留下无法自动重试的半迁移

**级别：P2；已在内存 SQLite 证实。**

`server/src/data/db/migrations.ts:182`–`:190` 逐条运行 `m.up(db)`，再写 `schema_version`，没有事务。v2 的 `ALTER TABLE ... ADD COLUMN pricing_version` 和 v4 的两张表加 tenant 列并非可无限重复 DDL。

故障注入在 v2 DDL 已执行、版本写入前抛错，得到：

```text
initial: injected failure after version 2 DDL
schema_version: token_usage = 1
pricing_column_exists: true
retry: duplicate column name: pricing_version
```

这不是只有测试代理能触发的逻辑：进程退出、断电、磁盘写满或并发进程执行迁移都可能切在该边界。当前 AppRuntime 在 `server/src/app/runtime.ts:2138`–`:2150` 捕获 migration 错误后继续运行，日志写 `token usage disabled`。因此用户可能只看到统计能力失效，服务仍“活着”。这不等同于 PG billing ledger 被清空，两种账本必须分开判断。

修复步骤：按模块/迁移使用 `BEGIN IMMEDIATE`，在拿到写权限后重新读取 schema_version，在同一事务执行 DDL 和版本写入；异常 rollback。提供只读诊断现有列、索引和版本的修复脚本，验证半迁移结构后再完成缺失步骤，禁止盲目把版本号改为最新。为统计存储补可见的 initialization/degraded 状态。

验收：每个 DDL 和版本提交点故障注入后，重启要么看到完整旧版本、要么完整新版本；两个进程同时初始化不能重复加列。已有半迁移 fixture 必须能通过专用修复路径恢复，且历史行数/汇总不变。建议 1–2 人日。

## REL-04：独立 PG 锁连接掉线时，缺少事件处理与失效栅栏

**级别：P1；独立 PG + 子进程已复现非白名单错误导致异常退出；普通网络错误被全局抑制后的失锁继续执行为源码证实的条件风险。**

`server/src/cron/bootstrap.ts:17`–`:30` 的 `withPgAdvisoryLock()` 与 `:33`–`:61` 的 `tryAcquirePgRunLease()` 都创建原始 `pg.Client`，拿 session advisory lock 后保留连接，但没有注册 `error`/`end` 生命周期回调。

Node 的 pg.Client 在没有执行 query 的间隙也可能发出 `error` 事件。一个异步函数外围的 try/finally 不能捕获 EventEmitter 的未处理 error。运行中的 Cron job 可持这个连接很久；同一 helper 还被 TenantStore/GroupStore 的持久化锁复用，分别见 `server/src/app/runtimeAuthInitialization.ts:35` 和 `server/src/app/runtime.ts:2125`。

隔离验证启动子进程调用实际 `withPgAdvisoryLock()`，在 callback 等待期间仅终止该 fixture 的 PG backend（按唯一 application_name 选中），得到：

```text
lockAcquired = true
exit = { code: 1, signal: null }
Unhandled 'error' event
error: terminating connection due to administrator command
```

必须区分 helper 的缺口与完整应用的异常策略。`server/src/index.ts:347` 的 `uncaughtException` handler 会调用 `isTransientNetworkError()`；`server/src/utils/transientNetworkError.ts:1`–`:23` 明确抑制 ECONNRESET、EPIPE 及 `Connection terminated` / `Connection terminated unexpectedly` 等错误。因此不能把所有数据库重启、连接回收或网络断开都归结为“杀整个进程”。实际分为两类：

- fixture 的 `terminating connection due to administrator command` 不在上述白名单，完整入口也会走 `index.ts:361` 的 `process.exit(1)`。systemd 可重启、durable run 可恢复，但同一 API/Worker 的其他会话会一起被打断。子进程 fixture 证实的是这类错误，不是所有网络错误。
- 被全局白名单抑制的传输错误不必退出进程，但 helper 没有记录 lock lost，已经进入的 operation callback 也没有失效信号。在 callback 等待文件 I/O 或外部任务时掉线，后续操作可能继续；PG session 锁此时已释放，其他 owner 可能已经进入。全局安全网维护了进程存活，不能替代本地所有权管理。此分支本轮仅追踪源码，没有另行网络故障注入。

修复不能只是加 `client.on('error', () => {})`：连接丢失意味着 advisory lock 已不再是本进程的写入依据；如果吞错后 callback 继续 rename 共享文件，另一个进程可能已拿锁写入。

建议将 helper 改成管理完整生命周期的 lock handle，公开 `AbortSignal`/lost 状态，在 connect 前绑定监听，error/end 后立刻撤销所有权并中止可取消步骤。文件 publish 必须在已确认的所有权/版本 fence 下进行。要注意 PG 锁与文件 rename 并非同一个事务：仅“publish 前 SELECT 1”仍有检查后掉线窗口。可靠的长期收敛是将共享权威状态放入同一个 PG 事务，或使用能在文件系统提交点仲裁的统一锁协议。Cron 运行 lease 则需要明确 lost 回调，禁止失联 owner继续宣布成功。

验收：连接在“等待拿锁、锁后空闲、读取文件、临时文件写入、publish 前、run 执行中”六个阶段断开，不能有未捕获 error；旧 owner 不能覆盖新 owner；正常 release、重复 release 和错误后清理都应有界。测试分别覆盖管理终止错误与全局白名单中的普通网络错误，并加载真实入口异常策略，不能仅用“子进程退出/未退出”推断互斥成立。保留 systemd 恢复能力，不用进程常驻吞错伪装健康。建议 2–4 人日。

## REL-05：Cron 完成、运行日志和通知缺少持久化交接

**级别：结果交付为核心业务时 P1，否则 P2；已隔离复现。**

`server/src/cron/service.ts:839` 开始的 mutation 先清 running 状态、把 executionLedger 置为 terminal、更新下一次调度。在该提交完成后，`:911` 才 appendRunLog，`:915` 才通知。日志写入抛错会直接跳过通知与 finished 事件。通知内部也只是捕获/打印失败，没有 durable retry，见 `server/src/cron/notifier.ts:77`。`run-log.ts:27` 是直接 JSONL append。

测试注入 appendRunLog 失败后，以相同 requestId 重试 runNow：

```text
first.ran = true
second.ran = true, second.deduplicated = true
ledger.status = terminal
executeCalls = 1
logCalls = 1
notifyCalls = 0
running = undefined
```

幂等执行成功避免重跑，这个保障应保留；但这也说明重试无法修复日志/通知缺口，启动 orphan 恢复只观察 active claim，不会重新投递这条 terminal 结果。对一次性任务，用户可能永远收不到本次结果；通知失败与执行失败目前也没有独立状态供 UI/运维判断。

建议把 terminal summary、日志投递状态、每个通知目标的待投递记录一起写入同一 claim completion 事务。独立恢复 worker 根据 runId/target 的稳定幂等键投递，成功后 CAS ack；网络不确定结果需按下游幂等能力选择策略，不能承诺无法保证的 exactly-once 外部消息。未送达超过阈值进入可见 dead letter，并提供“仅重发通知”操作，避免用户通过重跑有副作用的 Agent 来取结果。现有 Runtime `runTerminalCoordinator` 的 outbox 可作参考，但不要把所有通道状态塞进一段无版本 JSON。

验收包括 terminal 落库后立即 kill、日志写失败、通知 429/5xx/超时、通知成功但 ack 丢失、两个恢复 worker 同时 claim。执行次数始终为一次，日志可补齐，通知状态可追踪，重复风险可解释。建议 3–5 人日。

## REL-06：Cron 文件锁的身份依赖进程路径，与部署共享挂载不一致

**级别：P1；条件风险。代码、部署模板和 PG 锁重叠机制已证实，实际生产 cron.store 值待核实。**

`server/src/cron/bootstrap.ts:124` 先按 processCwd 把 cron.store 解析为绝对路径，`:136` 又把这个路径放进 PG lock name。默认值和 `config.example.json:145` 都是 `./data/cron/jobs.json`。

生产部署模板定义：

| 进程              | WorkingDirectory                       | data 实际挂载                 |
| ----------------- | -------------------------------------- | ----------------------------- |
| API blue/green    | `/opt/agent-saas-app/color/%i/server`  | `/mnt/agent-saas/server-data` |
| Worker blue/green | `/opt/agent-saas-app/worker/%i/server` | `/mnt/agent-saas/server-data` |

证据：`daemon-packaging/systemd/agent-saas-server@.service.template:31`、`daemon-packaging/systemd/agent-saas-runtime-worker@.service.template:17`。这些模板别名对应同一共享数据；**当进程实际解析出的 cronStorePath 不同时**，代码才会生成不同 lock key。隔离 PG 同时持有 API 路径的锁和 Worker 路径的锁，结果 `bEnteredWhileAHeld = true`；该实验直接证实的是锁名分裂机制，不是生产进程实际 cwd。

二轮复核补充：`server/src/app/runtime.ts:285` 使用 `process.cwd()`，不是直接读取 systemd 模板的 WorkingDirectory 字符串。系统可能把 symlink 工作目录解析为真实 release 目录；`scripts/release/deploy-production-release.sh:1820`–`:1821` 又把候选 API/Worker 指向同一个 target，所以不能仅凭 `/color/` 与 `/worker/` 两种字面路径认定稳定同版本必然异锁。不同 release 在蓝绿/Worker 排空期间重叠，或不同 mount namespace 实际路径不同，才是应重点核验的窗口。须记录真实 cwd、最终 cronStorePath、PG namespace 和底层挂载身份四者。

满足上述异路径条件时，API 改任务、Worker claim 或 completion 都可各自在自己的“锁”内读同一旧 jobs.json，再覆盖对方。`server/src/cron/store.ts:259` 的 PG withLock 分支直接执行操作，不会再取得本地文件锁；不存在下层文件锁自动弥补的保障。Cron leadership 只控制谁主动定时调度；它不禁止另一个进程响应用户 CRUD，HTTP 仍在 `server/src/app/routes.ts:495` 装配 Cron router。每个 job 的 run lock 也只能保护同一任务执行，不能保护 jobs.json 中不同任务的全量快照。

若所有生产进程实际配置的是**同一个规范绝对路径**，这项风险不触发；本文未读生产配置，必须先核验，不能直接宣布线上已丢任务。仅 realpath 也不能作为通用修复：不同 mount namespace 的 bind mount 路径可能仍然不同。

建议使用与部署色、工作目录无关的明确逻辑存储 ID，例如已区分环境/数据域的 namespace + `cron-store-v2`。上线需要过渡：旧 writer 仍拿旧锁时，新 writer 单独换锁名依然不互斥。可以在冻结窗口排空所有旧文件 writer，再统一切换；或实施有证明的兼容双锁协议，且所有旧路径必须被覆盖。切换前保留文件备份与任务/ledger 数量核对。

验收用两个不同 cwd、两个挂载别名、相同底层 jobs 文件、独立进程，强制在 read 与 publish 之间交错创建/更新/claim，所有任务和 claim 都保留。CI 不能只用同一个 storePath 创建 A/B 两个实例。建议 2–4 人日。

## REL-07：Billing 消费水位没有复用 EventStore 的提交顺序保护

**级别：P1；条件风险，独立 PG 已复现混合 writer 下的漏读。**

`server/src/data/billing/pgBillingStore.ts:1225` 的 `listUnprojectedRuntimeEvents()` 直接 SELECT `global_sequence > state`，按序号排序；`:1266` 以后将最大序号单调写入 projection state。`server/src/data/billing/service.ts:65`–`:113` 按这个批次投影并推进水位。

PG sequence 的取号顺序不是事务提交顺序。当前在线 PgEventStore 和 RunStore 新 writer 已在写入时取全局事务锁，见 `server/src/runtime/pgEventStoreProtocol.ts:9`、`pgEventStore.ts:165`、`runStore.ts:1237`，因此**所有 writer 都是这套实现时，本项不会由正常并发自动触发**。

但 EventStore 自己已经显式防范滚动发布旧 writer 没拿该锁：`server/src/runtime/pgEventStore.ts:100`、`:637` 使用 events table SHARE lock 后才读取全局水位，以免跳过未提交的低序号。Billing 另写的一条 SELECT 没有这个保护。旧版本混跑、独立回填/维修写入等不遵守新协议时，两个消费者对“已消费到哪里”的安全语义不一致。

其他上层保障不能消除这个特定条件：`BillingService.projectRuntimeEvents()` 在 `service.ts:58` 合并同一实例的在途投影，防止本实例重复启动扫描；usage 与 ledger 分别在 `pgBillingStore.ts:207`、`:253` 有 `idempotency_key UNIQUE`，usage INSERT 在 `:841` 使用冲突去重。它们保障已读取事件不重复入账，不能主动找回已经落到全局水位下方、从未读取的事件。这里不新增“两个当前 projector 正常并发就漏账”的结论，也没有证明生产仍存在旧 writer 或直接 INSERT 权限。

隔离 PG 步骤和结果：

1. 模拟旧 writer 插入 `fixture-low` 获得 sequence 1，保持事务未提交。
2. 通过实际当前 PgEventStore 插入 `fixture-high` 获得 sequence 2 并提交。
3. Billing 扫描只返回 high，并把水位更新到 2。
4. 提交 low；Billing 下一次扫描为空，但 EventStore 能读到 low。

```text
firstSeen = [fixture-high]
watermark = 2
afterLowCommit = []
lowDurable = fixture-low
```

若 low 是满足投影条件的 usage 事件，可能永久漏投影；是否漏扣费还取决于该事件 billable 和租户计费策略。该 billing watermark 又参与 EventStore retention 删除门禁，因而不能仅把它当后台统计短暂延迟。具体地，`server/src/runtime/runtimeEventRetention.ts:582` 的 `model-request-finished` 清理类可在 TTL、法务水位、执行权限等门禁均满足后删除旧事件，而 Billing 在 `service.ts:87` 可能从这类事件提取失败模型用量；不能由此扩大为“所有 assistant usage 事实都会被当前 retention 删除”。此次没有执行 retention DELETE，也没有证明线上存在此类缺口。

修复优先复用同一个有提交屏障的全局页读取接口，使 Billing/记忆整合/事件订阅的水位含义一致；若明确结束旧 writer 兼容，也要以可审计的能力/数据库角色门禁保证不存在绕写，再讨论降低表锁代价。对历史数据先只读对账 usage event 与 usage projection 幂等键的缺口，不要直接回退全局水位重扣；补投影必须复用既有 usage/debit 幂等边界。

验收：晚提交低序号、事务 rollback 空洞、两个 projector 并发、投影成功但水位 ack 失败、混合 writer 与 retention 水位协作。结果必须“等待或最终读到全部已提交事件”，不能越过尚未证明安全的序号。建议 2–3 人日。

## REL-08：启动阶段把不完整扫描当作清理/重建的完整依据

**级别：P1；已证实代码链路，用量重建已隔离复现。**

这里有同一根因的两个落点。

### 会话分组关联清理

`server/src/data/transcripts/store.ts:72` 的递归扫描，在目录打开/readdir 出错时返回 `[]`。`listExistingTranscriptSessionIds()`（`:132`）只返回一个 Set，没有 `complete` 或 error 列表。AppRuntime 启动在 `server/src/app/runtime.ts:2501` 以这个 Set 调用 `groupStore.pruneOrphanedSessionIds()`；后者在 `server/src/data/groups/store.ts:426` 后删除不在快照中的关联。该启动分支受 `runtime.ts:2496` 的 `enableSingletonWorkers` 限制，实际角色为 `all` 或 `runtime-worker`（`:289`），不由每次 ws-only API 启动执行；这也不是获得 Cron leadership 后才允许执行的清理。

根目录失败会被解释为“所有 transcript 都不存在”；子目录失败会被解释为“该部分会话不存在”。权限错误、NAS 暂时不可读、资源耗尽等都不应作为删除证据。扫描也只包含 .jsonl，刚创建但仅有 .meta.json/PG durable run、尚未产出 legacy projection 的会话可能不在快照中；仓库另有 `findTranscriptOrMetaPathBySessionId()` 专门承认这个阶段，但 startup prune 没利用这个事实。

影响是分组 sessionIds 被持久清除，不等于 transcript 本体被删。用户仍可能找到会话本体，但分组组织关系丢失。GroupStore 的 mutation queue、锁内重读仍然生效，且只过滤先前候选 `dead` 集合；不会无差别删除检查期间新增的每一个 ID。但锁内重读不会重新判断候选 transcript 的可读性/存在性，不能使不完整扫描自动变成可靠删除依据。

### SQLite 用量重建

`server/src/data/usage/rebuildFromJsonl.ts:146` 的目录扫描同样 catch-all 返回空数组；`:267` 后在事务内 clearAll、写入扫描结果、设置 rebuild 完成标志。事务保证“整批清空/重建”原子，却无法判断输入快照是否完整。适用边界是 **rebuild_state 尚不存在、被管理操作重置，或 force=true**（`:204`）；不是已有完成标记的每次正常重启都会清表。自动装配在 `server/src/app/runtime.ts:2153`，同样只面向 all/runtime-worker；`runtime.ts:2975` 还暴露 force=true 的显式重建入口。

fixture 给已有 100 input tokens 的内存 DB 指定一个实际为普通文件的 projectsRoot，目录读取触发 ENOTDIR；结果：

```text
performed = true
filesScanned = 0
dailyRows = 0
rebuildRecorded = true
```

之后正常启动会因为 rebuild_state 存在而跳过重建。该例用于确定性制造扫描错误；实际触发也可来自权限/I/O 错误。正常空目录首次初始化应继续允许，不应一刀切拒绝零行。

### 修复与验收

扫描接口返回 `{ entries, complete, errors, rootIdentity, startedAt, finishedAt }`；用于展示可以允许部分结果，用于清理/全量替换必须要求完整且根挂载已确认。候选删除集合应复核 meta、durable session/run 与冷存储状态，保留新建投影宽限期。最好先记录隔离候选/墓碑，后续完整扫描再次确认才解除关联。

重建使用 staging 表或明确的 source snapshot/watermark，完整验证后切换；扫描失败不清主表、不写完成标记。重建还需与实时用量并发协调：`runtime.ts:2154` 用 void 异步启动扫描，不阻塞服务后续启动；扫描发生在事务外，同实例后续实时写入或另一共享 DB 进程的写入，若未进入扫描快照，可能被最终 clearAll 覆盖。只有在重建期间确有写入时才触发这一并发子风险。建议从持久事件事实源做增量投影，减少依赖“扫描全部 transcript 后清表”的恢复方式。

验收覆盖根不存在但数据库已有历史、EACCES/EIO/ENOTDIR、一个子目录失败、meta-only pending 会话、扫描中新增会话、扫描中实时用量到达。错误发生时相关文件/DB 原值必须逐字节或逐行保持。建议 2–4 人日。

## REL-09：Cron executionLedger 无限累积，放大全量 JSON 存储成本

**级别：P2；增长机制已证实，容量临界值待真实规模压测。**

`server/src/cron/executionClaim.ts:176` 为每个执行建立 ledger，`:226` 始终 push。完成时只设 terminal，见 `server/src/cron/service.ts:870`，没有归档或压缩。全仓 `executionLedger` 路径只发现未执行 claim 的撤销移除，没有已完成记录 retention。

这些记录是幂等和 retry lineage 的事实，不能简单 slice 掉。问题在于记录全部嵌入 jobs.json：每次 claim、running、completion、编辑等都走全文件解析、序列化与 rename；store mutate 还会在“业务 changed=false”的读取型 mutator 后提交文件，见 `server/src/cron/store.ts:252`。运行中的 CronService 每 1.5 秒 refresh 全部 jobs，见 `service.ts:30`、`:941`。

量级示例只是容量模型，不是生产观测：一个每分钟运行的任务一年有 525,600 条历史记录；若一条 JSON 平均 0.5–1 KB，单个任务 ledger 就约 260–526 MB，格式化缩进还会增加体积。多个任务共用一个文件，其他低频任务的编辑也支付这个成本。实际每条大小、执行时长与任务数量必须测量后再定阈值。

建议将 execution ledger 拆为 PG 独立表，唯一键包含环境/任务/幂等键，按 jobId、状态、时间、retry lineage 索引；jobs 只保存当前运行引用和必要调度状态。历史记录归档先确定重放/手动 requestId 的承诺窗口，保留 tombstone 或压缩幂等索引，禁止通过删除 ledger 让旧 requestId 重新执行。短期增加文件字节数、ledger 条数、parse/serialize/fsync/锁等待时长监控；无变更事务不写回，并降低无变化 refresh 的 I/O。

验收按 1 万、10 万、50 万条历史记录测试 list/claim/edit/recovery 延迟、峰值堆内存和写入字节。归档前后相同旧 requestId 不得执行两次，active/retry lineage 不能丢。建议 3–5 人日。

## REL-10：PG 全局事件锁需要统一的期限与阻塞可观测性

**级别：P2；条件风险。当前未核验生产 DB role、connectionString options 是否已配置 timeout。**

`server/src/runtime/pgEventStore.ts:89` 的 Pool 只配置连接串和 max；代码没有统一 `connectionTimeoutMillis`、statement/lock deadline。写入 `:165` 经 `pgEventStoreProtocol.ts:13` 获取整张事件表共用的事务 advisory lock；订阅/全局分页在 `:109` 获取 SHARE 表锁。为正确提交顺序而串行化是现有有意设计，不能直接删锁来“优化”。

风险在于锁持有者或排队查询异常慢时，等待会跨 session/tenant 放大。多条 append 可占满默认 6 个 pool slot；后续状态查询、租约续期等共用连接池操作也受影响。Scheduler `server/src/runtime/scheduler.ts:275` 在 stop 时等待当前 tick 结束，tick 内又串行 await 恢复/查询，若下层 promise 无期限，优雅停机只能最终由外层进程强制超时收场。Worker readiness 当前主要证明 PID、ConfigIdentity、内存/retention 准入，不能单独证明 scheduler 最近一次成功推进，见 `runtimeWorkerReadiness.ts:108`。

已有局部防护不应忽略：`pgSessionLock.ts:96` 为 schema init 设置了 statement/lock timeout；Cron 连接建立有 10 秒期限；事件 Pool 有 idle error listener；memory pressure guard 可关闭准入。但这些不是覆盖全部在线 PG 操作的统一期限。

修复先取证：读取生产 DB/user 的 statement_timeout、lock_timeout、idle_in_transaction_session_timeout，统计总连接预算和每进程/角色 pool 数，分析 pg_stat_activity 的长事务/等待。代码层为短查询、事务、长维护分别配置期限；BEGIN 后的超时必须 rollback，并保证 client 可安全归还或销毁。上层 Promise.race 本身不会取消服务端 SQL，不能作为唯一措施。

增加 pool waitingCount、global lock wait、event append P95/P99、scheduler last successful tick、lease renewal latency/expiry 的指标；准入应在明确持续不前进时降级，而不是所有瞬时慢查询都触发全站离线。优化全局锁要有提交水位证明，并覆盖 REL-07 的旧 writer 兼容。

验收用独立 PG 人为持锁、长事务、连接耗尽和断网验证：请求有界失败/重试、连接释放、租约失效不双执行、取消不被永久饿死、scheduler恢复后能继续推进。建议 2–4 人日，不含性能架构重做。

## REL-11：实时用量日表和分钟表缺少原子提交

**级别：P2；内存 SQLite 故障注入已复现。**

`server/src/data/usage/store.ts:481` 的 `recordResult()` 对每个模型先 `upsertStmt.run()` 日表，再 `upsertMinuteStmt.run()` 分钟表，整个操作没有事务。两种时间范围从不同表查询，见 `:382`。分钟写入失败后，日表已提交；调用方通常只记录 warn 并继续业务，例如 `server/src/channels/web/channel.ts:3404`。

fixture 在分钟表写入处注入异常，结果：

```text
usage_failure = injected minute write error
dailyTokens = 100
minuteTokens = null
```

因此同一天选“按日”和“自定义分钟范围”可能看到不同 token/cost 总量。多模型记录在中途失败也会只完成部分模型。`RecordResultParams` 没有 event/run 幂等键，直接重试会重复累加已经成功的部分；“Result 只来一次”的注释不能保证遇到落库故障后的重试安全。此项是 SQLite 展示统计，不直接等同于 PG 积分重复扣费。

短期把同一个 result 的全部模型、日表与分钟表放在一个事务或可嵌套 savepoint 内，避免与回填外层事务冲突。中期给事实写入加稳定 sourceEventId，先持久记录事实，再幂等投影两张聚合表；不要把不稳定的消费时刻当幂等键。修复历史差异应基于完整事实重新计算，先解决 REL-08 的重建安全问题。

验收：日表成功/分钟表失败、第二模型失败、busy/磁盘错误、重复提交同一 sourceEventId，均不能留下部分汇总；同一完整自然日的日表总量应与分钟表 SUM 一致。建议 1–2 人日。

## REL-12：内置 Profile 升级只匹配紧邻前版，跨版本旧库停留在 v1

**级别：P2；条件风险；已用独立真实 PG 证实旧记录不前进，未核查生产是否还有适用记录。**

### 两个失败必须分开解释

主审查者显式设置 `AGENT_PROFILE_TEST_PG_URL` 后，在本次临时 PostgreSQL 16.13 / 55438 上单独执行 `server/src/__tests__/agentRuntimeProfileStore.pg.test.ts`：5 个测试中 3 通过、2 失败。来源为 `agent-profile-pg-confirmed-tests.json/log`，详见 [验证证据](./test-evidence.md)。这次补测不改写先前全量执行的跳过/失败计数；第一次数据库端口未正确配置造成的 ECONNREFUSED 属于检查准备错误，不是产品问题。

第一个失败在测试 `:38`：它要求 memory_poll 和 subagent_explore 都是 v2，但 `server/src/data/agentProfiles/builtins.ts:178` 已把 memory_poll 升为 v3，普通非 PG 测试 `server/src/__tests__/agentRuntimeProfiles.test.ts:167` 也已明确 memory=3、explore=2。新数据库正确创建 v3，被旧测试错判。这部分是**测试期待陈旧**，不是“数据库播种错了版本”。

第二个失败在 PG 测试 `:68`：fixture 先初始化独立表，再把 memory_poll 的 latest_version_id、draft_config、draft_digest 恢复为已知 v1，保持系统、published 状态，随后再次 `init()`。它期待升级，但实际仍读到 `arpv_builtin_memory_poll_v1`。期待目标写成 v2 同样陈旧，正确新目标应是 v3；然而仅把预期改为 v3 仍会失败，因为实际是 v1。这一部分揭示独立的产品升级边界。

### 根因、现有保护与真实触发前提

`server/src/data/agentProfiles/store.ts:176` 的 `init()` 每次都会执行数据库初始化和 seed，没有“初始化过一次便不做”的实例缓存；`:180` 有 PG advisory lock。`:506` 的 `seedBuiltins()` 在事务内进行播种/更新，不能把此问题归为 init 并发不互斥。

实际缺口位于 `:535`：从 `previousVersions` 中只取最大的版本号。当前 memory_poll 有 v1、v2 两个历史版本，最大值是 2；`:550`、`:551` 的 UPDATE 又要求“当前 latest 必须等于该 v2 ID，且 draft digest 必须等于 v2 原始摘要”。因此无自定义的 v1 记录不匹配，整次初始化成功提交，但该 profile 一直停留在 v1。重复 init 仍然执行相同的 v2→v3 单步条件，不会逐步把 v1 送到 v2。

需要存在以下条件：旧数据库跳过含 v2 的中间发布直接升级到当前含 v3 的代码，或恢复了仍保留原始 v1 profile 状态的旧备份。**新建数据库直接播种 v3、原始 v2 升到 v3、其他只有一个历史前版的 Profile，不属于这个失败场景。** 本次没有读取线上 Profile 分布，不能声称当前生产记忆轮询都在使用 v1。

故障影响是未自定义旧系统 Profile 没有获得新预设。`builtins.ts:180` 的 v1 无 Shell、使用旧工具 allowlist，maxTurns 默认为 30；当前 `:188` 的 v3 使用 Shell-first/隔离目标配置且 maxTurns 为 1,000。`store.ts:467` 的 `resolveBinding()` 直接按 profile.latest_version_id 连接版本表，新解析的 binding 仍可取到旧配置。最终实际工具可用性仍受运行时交集约束，不能将这里概括为“旧工具全部可以执行”或越过其他安全门禁。

保持历史已发布版本不可变、保留管理员自定义草稿，以及已有会话的 pinned version 都是正确保障。**旧会话刻意继续使用 pinned v1 不是本问题，也不应被修复强制换版。** 当前 seed 的 digest guard 正是在保护管理员修改，不能为了升级覆盖所有 is_system 记录。

### 修复设计、对账与回滚

1. 把升级起点定义为“任意已知且允许升级的历史内置版本”，不是只取 previousVersions 最大值。可以按已排序的版本迁移边逐步前进，或者从匹配的历史版本直接升到当前版本；需要显式决定是否允许跨版，不能把未经声明的历史版本静默纳入。
2. 保持事务和跨进程初始化锁。行级条件必须同时绑定 profile/system/published、当前历史 version ID、对应历史 draft digest，并结合 expected revision 或行锁排除管理员并发编辑。无法证明未自定义时保留原样并输出待人工处理记录。
3. 只更新当前 Profile 的 latest/draft/revision 和审计，不改写或删除任何已发布版本，不改变现有 session 的 pinned version/digest，不覆写管理员新发布的版本、自定义草稿或归档状态。
4. 修正 PG 测试对当前版本的期待，优先从权威 builtin 定义推导当前编号，但同时保留明确的历史迁移 fixture，避免“产品怎么返回，测试就跟着怎么期待”的自证循环。把该 suite 接入统一 PG 环境变量和必执行清单，见 ENG-03。
5. 上线前只读盘点各系统 profile 的 current version、draft digest、revision、状态和修改来源。将记录分成当前版、可证明原始历史版、自定义/未知三类。仅对第二类执行受控升级，对账记录前后 ID、digest 和 revision，已有自定义保持不动；不要对全库直接批量 SET latest=current。
6. 回滚不得覆盖历史版本内容或把所有 Profile 指回 v1。保留变更前权威字段与审计；若升级后需要恢复旧配置，优先通过正式 draft/publish 生成一个新版本，实现可审计回滚。已 pinned 的新旧会话分别保持其既有绑定，修复程序重复运行不应继续增长 revision。

### 验收与成本

- 新空库播种 v3，历史版本仍为 `[3,2,1]`；多实例并发 init 和重复 init 不改变有效版本/digest，不产生额外 revision。
- 原始 v1→v3、原始 v2→v3 两类都成功；只发布过 v1 的旧库和已插入历史 versions 但 current 仍为 v1 的恢复快照都覆盖。
- v1/v2 上管理员修改了 draft、管理员另发了新版本、归档 profile、未知版本或摘要不一致时均不覆盖，并给出可审查原因。
- 管理员编辑与启动升级并发时，只有满足同一已锁定/CAS 快照的一方提交；失败后重试不丢管理员修改。
- 旧会话 pinned v1 继续读取不可变 v1；新 binding 读取升级后的 current；已发布表上的 UPDATE/DELETE 防护仍然有效。
- 标准 PG profile 实际运行这 5 条及新增迁移回归，不能因 URL 名称不一致再次全 skip；期望版本陈旧与真实升级失败作为两个修复点验收。

建议 1–2 人日完成迁移条件、PG 契约与入口修正，另预留生产只读盘点和发布观察窗口。只有盘点确认存在适用旧状态时，才安排历史数据处理；不为关闭报告直接操作生产记录。

## 已有保障与本次排除的误报

### Runtime 事件与会话恢复

- PgEventStore 同租户 event_id 有唯一幂等边界，appendBatch 对单会话在事务中提交，通知失败不会回滚已经 durable 的事实；通知发送复用已提交 client，避免持有事务连接再等待第二连接的 pool deadlock，见 `pgEventStore.ts:185`、`:214`。
- NOTIFY 是低延迟提醒，订阅仍按持久 global_sequence 补拉，callback 成功后才推进水位，并有重连/轮询兜底；不能把“用了 LISTEN/NOTIFY”简单报告为断线丢事件。
- `runTerminalCoordinator.ts:356` 后有 terminal CAS + durable outbox；事件有稳定 terminal delivery ID，失败可以恢复。REL-05 指的是另一条 Cron 日志/通知交接，不是否定 Runtime 已有 outbox。
- `runtimeRunCancellation.ts:47` 以后把取消与 durable event 收敛到权威 RunStore；`toolInvocationCancelDelivery.ts` 有独立投递 claim、超时、退避、dead letter，`toolInvocationRecovery.ts` 有终态与取消时间比较，避免晚到恢复误取消已完成调用。
- `pgSessionLock.ts` 有 dual/lease 滚动迁移、tenant/session 租约、续期/失去所有权通知；不要把它当纯进程内 mutex。实际生产是否已切 lease、pool 预算是否满足 dual 过渡仍需环境核验。
- `runtimeOutboundStreamRelay.ts:31` 将正文/思考增量批量落地，最终 assistant_message/thinking 是完整事实；增量中继失败日志不自动意味着最终内容永久丢失。回归应同时检查流式体验和最终恢复。

### ConfigIdentity 与 Worker

当前 `server/src/app/modelsHotUpdate.ts:107` 的 rollback 恢复已生效运行态快照，避免重新严格解析旧错误配置；启动与候选热更新共用模型引用门禁。`runtime.ts:2432` 以后区分 memory polling 配置更新和运行态同步。此前历史诊断提到的同类问题在本基线已修复，不列为本次未解决缺陷。

Worker readyfile 要求 admission、ConfigIdentity consistent 和私有快照当前；身份刷新超过 1 秒会撤销 readyfile，见 `server/src/index.ts:108`。retention 的权威持久化不可用也关闭准入。当前代码比“活着就 ready”更严格；REL-10 仅指出 scheduler 进展/PG 阻塞维度仍需核验。

### Cron

Cron 已有锁内最新快照 mutation、runId/leaseId fence、scheduled occurrence/manual requestId 幂等、恢复复用原 Runtime Run、编辑后的 schedule fence、watchdog 不覆盖迟到结果等。已读测试覆盖跨实例同路径写入和同 occurrence 不双跑。REL-06 专门补的是不同部署别名，不应重复写“Cron 完全没有跨进程锁”。

### ACS

本次检查的 ACS 路径没有得到足够证据认定新的 P1 代码缺陷。已有的重要保障包括：

- `invocationLeaseMonitor.ts:21` 启动即验证 lease 剩余时间，续期失败/过期会触发 runner 中止；finish 等待在途续期或失败信号，避免无界等待一个已过期 lease。
- `executor.ts:104` 用 invocation + 随机 leaseKey 区分不同实例，避免旧实例 finally 清新实例的 lease。
- `invocationCompletionRecovery.ts:21` 为完成 CAS 预留足够 mutation 窗口，`invocationRestartRecovery.ts:22` 在清理 residue 前先消费持久 snapshot，区分 completion_pending、background_pending 和 malformed lease。
- `sandboxDeletion.ts:71` 后的 UID/resourceVersion precondition、network-cleanup finalizer 与清理后确认，防止按名称删除网络资源时伤害新 incarnation。
- `sandboxCapacityAdmission.ts` / `capacityReservations.ts` 把未落地 reservation 计入容量，剔除忙/持 invocation lease/后台 Shell 保护的 sandbox；单实例容量仲裁已有明确实现。
- `index.ts:945` 有 SIGUSR2 drain 与 effectiveInflightRequests，部署不必依赖 SIGTERM 的 5 秒快速停机。

以上是阅读与本地主报告测试可以支持的设计确认，不替代真实 ACS、Kubernetes、SNAT 和 NAS 故障演练。

## 后续环境体检：尚未验证，不能当作已知故障

| 验证项                                   | 为什么需要                                                        | 建议证据 / 验收                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 生产 cron.store 与 API/Worker 解析后路径 | 决定 REL-06 是否在线触发                                          | 脱敏读出配置值、cwd、mount identity 与锁名；不要输出其他配置/secret                                        |
| JSON 文件完整性、备份和冲突              | 决定 REL-01/02 是否已有历史损伤                                   | schema/version、normalized username/phone 冲突清单、备份校验；先只读                                       |
| PG 超时、连接预算和角色门禁              | 决定 REL-07/10 风险暴露面                                         | DB/role timeout、各进程 application_name/pool、旧 writer 能力与直接 INSERT 权限                            |
| Billing 事实与 projection/ledger 对账    | 漏消费不能只看最大水位发现                                        | 从事件幂等键对账，区分不计费/免计费/已撤销，抽样到 run，不重扣                                             |
| SQLite/NAS 的部署适配                    | business.sqlite 在共享 server-data 上，WAL/锁语义须按实际挂载验证 | 实际文件系统、单/多宿主、SQLite 读写进程、故障恢复；本地 SQLite 测试不足以证明 NAS 正确性                  |
| 备份恢复与 RPO/RTO                       | “有备份”不同于“恢复后可继续运行”                                  | 在独立环境恢复 PG + JSON + transcript + workspace，核对 tenant/session/run、审批、账单与附件引用           |
| 真实 ACS 控制面故障                      | 单元测试无法证明云资源时序                                        | API 429/超时、CAS response 丢失、orchestrator 重启、旧/新 UID同名、SNAT 清理中断、后台 worker 启动结果不明 |
| 负载与恢复容量                           | 全局事件锁、JSON 全量读写、恢复扫描可能互相影响                   | 活跃会话、事件/秒、工具结果大小、恢复 backlog、堆内存、PG锁/连接、P95/P99，区分正常和恢复负载              |
| Worker ready 与工作进展                  | alive/readiness 不能独立证明任务继续完成                          | 最后 tick/claim/事件落盘时间、队列年龄、lease stale数量，与 readyfile 联合观察                             |
| 用户看得见的投递状态                     | Cron notify 错误现在主要留日志                                    | 成功/待重试/永久失败/外部结果未知，提供 runId 与仅重发入口                                                 |

FileEventStore 还存在每次 append 为幂等检查读完整文件、listPage 先读全量再 slice 的增长成本，见 `server/src/runtime/fileEventStore.ts:80`、`:138`。这是 file backend 的规模边界；生产 PG 主路径不因此被判故障。如果未来承诺 file backend 长期承载大量会话，应增加 append 索引、真正分页与独立跨进程约束，或明确单进程开发使用限制。

## 建议逐项解决顺序

1. 先做只读证据确认和备份演练；确认生产 Cron 路径、身份文件是否有冲突、Billing 是否有旧 writer。不要为了核实报告去清理真实数据或停止运行。
2. 第一批修复 REL-01/02/04/06：统一共享权威数据的读、写、锁和失败语义。每个 PR 都有独立 fixture 和滚动兼容说明。
3. 第二批 REL-05/07/08：补结果交付、消费水位和安全扫描的闭环。修复逻辑先上线，再决定是否补历史数据。
4. 第三批 REL-03/11：SQLite migration/汇总原子性和可见降级。若规划把统计迁至 PG，可先做小范围事务修复，避免等待大迁移期间持续暴露。
5. 第四批 REL-09/10：按实际负载建立容量预算、期限、指标与演练，再决定是否更换存储/拆分锁域。
6. REL-12 可与 PG 测试入口/过期契约修复同批进行；先明确跨版升级契约并只读盘点，保留自定义草稿及 pinned session，不通过全量重置 Profile 来升级。

每项关闭前建议保留：问题触发 fixture、修复前失败/修复后通过结果、生产配置适用性、回滚兼容策略、观察指标与历史数据是否需处理。仅增加成功路径测试、重启服务或看到 CI 通过，不足以关闭本文列出的故障边界。
