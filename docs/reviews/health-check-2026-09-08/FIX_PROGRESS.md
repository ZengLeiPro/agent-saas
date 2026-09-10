# 高优先级问题修复进度

> 实施分支：`fix/health-check-priority-20260910`；起点：`b4b5968740dba7a9e7dc2681c1c8a6d012d32fa5`。
> “已修复”要求代码、定向回归、工作区检查和本地端到端证据全部完成；生产配置、真实外部系统和最终签名移动包验收单独记录。

## 状态总览

| ID     | 当前状态 | 当前结论                              | 关闭证据                                             |
| ------ | -------- | ------------------------------------- | ---------------------------------------------------- |
| SEC-01 | 待复核   | 内部浏览器路由与公共反向代理边界      | 待补                                                 |
| SEC-02 | 待复核   | AuthEpoch 跨进程事务与单调性          | 待补                                                 |
| SEC-04 | 待复核   | KY App 出站完整生命周期预算           | 待补                                                 |
| REL-01 | 已修复   | UserStore 并发查重与旧快照覆盖        | 锁内重读/校验/原子提交；并发与双进程回归通过         |
| REL-02 | 已修复   | Users/Groups/Agents 读错被当空库      | 三类 store 故障注入通过，原字节未变                  |
| REL-04 | 待复核   | PG 锁连接失效后的写入栅栏             | 待补                                                 |
| REL-05 | 待复核   | Cron terminal 到日志/通知的持久交接   | 待补                                                 |
| REL-06 | 待复核   | Cron 锁名对真实路径不稳定             | 待补                                                 |
| REL-07 | 待复核   | Billing 水位与晚提交事件              | 待补                                                 |
| REL-08 | 待复核   | 不完整启动扫描触发清理/重建           | 待补                                                 |
| UX-01  | 待复核   | HTML 预览禁止联网承诺不可兑现         | 待补                                                 |
| UX-02  | 待复核   | 同身份续期误拒绝并发成功响应          | 待补                                                 |
| UX-03  | 已修复   | Mobile 文件缓存与 inflight 跨身份复用 | 身份代际 key、迟到结果 fence、SHA-256 文件键回归通过 |
| UX-04  | 待复核   | 原生下载绕过本地锁传输门禁            | 待补                                                 |
| UX-05  | 待复核   | 权威 tab storage 写失败被吞           | 待补                                                 |
| UX-06  | 待复核   | 生物能力探测异常降低本地锁策略        | 待补                                                 |
| UX-08  | 待复核   | 管理预取缓存未按身份隔离              | 待补                                                 |
| UX-13  | 待复核   | 最终移动发布验收未闭环                | 待补；最终签名包需另行环境验收                       |
| OPS-01 | 待复核   | 不可变发布证据部分写入占住 SHA        | 待补                                                 |
| DEP-01 | 待复核   | Mobile Markdown 解析链命中已知公告    | 待补                                                 |

## 执行记录

### 2026-09-10 初始化

- 已核对远端 `main` 为 `b4b5968740dba7a9e7dc2681c1c8a6d012d32fa5`，并从该提交创建隔离 worktree。
- 原工作区存在 3 份未跟踪文档，未移动、覆盖或加入本分支。
- 本机默认 Node 为 22.21.1，低于项目约定的 22.23.1；正式测试使用项目指定 Node 后记录实际版本。
- 未修改 Workflow，未推送，未部署，未访问生产数据。

### 2026-09-10 第一批关闭：REL-01、REL-02、UX-03

- REL-01：UserStore 的全部 mutation 进入串行队列和共享锁；锁内重新读取最新文件、重新执行唯一性/最后管理员等校验，再以临时文件 + rename 提交。生产 PostgreSQL 运行时复用 advisory lock，本地/测试使用 create-only 文件锁。mutation 被拒绝后保留锁内读到的最新已提交快照，不再恢复进程旧快照。
- REL-02：Users、Groups、Agents 仅把“首次且文件不存在”视为初始化空库；损坏 JSON、非法 schema、权限错误以及已加载后文件消失均抛出明确的 store unavailable 错误。失败 mutation 不写回，磁盘原字节保持不变；正常写入继续使用原子替换。
- UX-03：移动文件缓存升级为 v2，以 API origin、tenant、user、身份 generation 和生命周期 generation 共同划分 scope；身份切换和清理会使旧 inflight 结果失效。下载先进入唯一临时文件，scope 复核通过后才移动到最终路径；工作区、知识库和附件文件名改用 SHA-256，旧弱哈希缓存直接失效，不跨身份迁移。
- UX-04 仍保持“待复核”：本批在原生下载入口补了敏感传输能力检查，但尚未完成该问题要求的统一取消契约，因此不借本次联动修改提前关闭。

### 2026-09-10 PR #614 复核整改

- 复核重新打开 REL-02：AgentStore 原实现只有进程内队列，两个进程仍可能在 `reload` 与 `rename` 之间互相覆盖。现已与 UserStore/GroupStore 对齐为 `lock → reload → mutate → atomic publish`；所有进程对共享 `agents.json` 使用同路径 create-only 文件锁，启动默认 Agent 初始化也在该锁内同步完成。
- 新增两个独立 Node 进程的同步竞争回归：复用两个常驻进程连续制造 20 次不同 Agent 的并发更新，20/20 最终文件均同时保留两条记录。
- CI 将 UserStore 判入生产迁移依赖闭包后严格阻断。该文件不执行 SQL 或结构迁移，因此没有伪造 expand；新增摘要绑定的 `no-schema-change` 审核、审核说明和测试证据，使源码或证据变化时门禁自动失效并要求重新审核。
- 未修改 Workflow；权威 CI 需在整改提交推送后重新执行并读回。

## 本地端到端证据

### Server 数据路径

- macOS / Node 22.21.1：`vitest` 定向运行 UserStore、三类 JSON store 故障注入、多进程 fixture，共 23 项通过；既有 auth router 30 项回归通过。
- 真实并发边界：50 个同进程并发创建只有 1 个规范化用户名成功；两个独立 Node 进程同时创建同名用户只有 1 个成功；两个预加载旧快照的进程创建不同用户后均保留。
- 真实文件边界：对 Users、Groups、Agents 分别写入损坏 JSON 和非法 schema 后执行 mutation，均拒绝且逐字节读回原件；Groups 的不可读权限用例在非 Windows 平台通过。
- 扩大回归共 13 个文件、164 项：159 项通过；`groupsCoverage` / `groupsRoutes` 的 5 项在 macOS 因既有 Linux `/proc/self/fd` fixture 不可用而失败，发生在本批修改路径执行前。尝试在本地 Docker Linux 复跑，但离线缓存缺少 Linux Rollup/ESBuild 可选二进制，未把该环境失败计为产品失败或通过。
- `server typecheck`、`server build`、仓库 `check:ratchets` 通过。

### Mobile 文件路径

- `fileCacheService.test.ts` 4 项通过：退出/切换账号时旧下载迟到、已知 DJB2 碰撞、跨租户同 KB 文档、身份切换后的附件迟到结果。
- Mobile Vitest 全量 96 个文件、495 项通过；原生/release contract 直接运行 191 项通过。
- `mobile typecheck`、`expo install --check`、iOS/Android Router export 与导出结构校验通过。
- `pnpm --filter mobile test` 的 Vitest 阶段全部通过，但随后嵌套 `pnpm exec expo ... --json` 在本机 Node 22.21.1 下把 engine warning 写进 JSON stdout，导致既有 release-manifest 聚合脚本 2 项解析失败；相同 191 项 Node contracts 直接运行全部通过。项目要求 Node 22.23.1，本机无该精确版本。

### 验收边界

- 本批完成了本地真实文件 I/O、独立进程并发、原生文件适配器故障/迟到注入和 iOS/Android bundle export；未使用真实用户数据。
- 本机没有可用的 Xcode `simctl` 或 Maestro，故没有伪造真机缓存证据。最终签名 iOS/Android 包上的账号切换、退出和落盘读回仍属于 UX-13 的设备验收，不改变 UX-03 代码缺陷已经关闭的结论。
- Docker 本地镜像为 Node 22.23.2，无法联网拉取项目锁定的 22.23.1；最终 CI 仍应在锁定工具链上复跑。
