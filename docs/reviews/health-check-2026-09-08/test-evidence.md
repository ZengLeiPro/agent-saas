# 测试、构建与验证证据

> 审查基线：`a6b6865eba98cb0b4c08bf8f0359e8200aec7768`，2026-09-08。阅读入口：[总体报告](./README.md)。机器可读证据：[verification.json](./evidence/verification.json)。
>
> 本文固化已有检查的结果，没有为了整理证据再跑测试、触发 CI、访问生产或修改业务实现。失败结果、跳过、人工干预、离线检查和覆盖率分母均单独保留。

## 如何理解这份结果

本次并不是“项目全绿”，也不是“服务器有 801 个已确认生产 bug”。

本机 macOS 的 server 全套确实失败：906 个测试文件中 **114 失败、789 通过、3 跳过**；8,204 个测试中 **7,378 通过、801 失败、22 跳过、3 todo**，另有 **12 个未处理错误**。发布契约也不是全绿：725 个测试中 673 通过、40 失败、11 跳过、1 取消。

与此同时，同一审查 SHA 的 Linux APP CI 成功，server 聚合为 904 文件通过、2 跳过，8,183 测试通过、18 跳过、3 todo。它说明目标平台的这次正常验证链能够完成，不能替代本次发现的并发、故障恢复、安全边界和浏览器行为审查。

最重要的阅读规则：

- “文件数”来自 Vitest JSON 的 `testResults.length`，不是包含嵌套 describe 的 `numTotalTestSuites`。例如 server 的后者是 2,314，绝不能写成 2,314 个测试文件。
- Vitest JSON 还把三个全部跳过的文件标为 passed：原始状态是 792 passed、114 failed；结合断言状态和 console 归一化后才是 789 passed、114 failed、3 skipped。持久 JSON 同时保存原始和归一化计数，避免下次重复误读。
- assertion 失败、未处理错误、测试取消及进程清理挂起不是同一个维度，不能相互合并或掩盖。
- 这里没有把每个 lint warning、每个覆盖率空白或每个本机测试失败自动升级成业务缺陷。业务发现请读各专题的独立证据、触发条件及验收标准。

## 基线、环境和可追溯性

开始审查时工作区为 clean，主分支基线为上述完整 SHA。主要验证使用 Node **22.23.1**、pnpm **10.18.3**、Vitest **4.0.18**。本机系统为 macOS/Darwin；数据库相关验证使用临时独立 PostgreSQL **16.13**，监听 `127.0.0.1:55438`，数据库为 `agent_saas_health_test`，不连接生产数据库。整理证据时主审查者已经安全停止该实例，临时数据库文件保留，没有删除。

审查期间，其他工作提交了 #572，HEAD 变为 `c73689eab0f4a119f8efc1c5e0f8f8092493f33c`，涉及 5 个业务文件，153 行增加、4 行删除。这不是本审计实施的改动。**本报告仍绑定原审查基线；每项检查证明的是它执行时读取的代码快照，不是对最后一刻工作区、并发改动或新 HEAD 的全量复验承诺。** 后补的 management 契约检查由主审查者确认相关导航/脚本在两次 SHA 之间没有变化，所以可以归为原基线已有的检查不一致。

原始输出保存在临时目录：

```text
/private/tmp/agent-saas-health-20260908.82VCKZ
```

临时目录可能被系统清理，因此不能把它作为唯一交付物。持久 JSON 已保存测试元数据、全部 114 个失败文件及各自断言计数、lint 规则/工作区分布、库存、覆盖率分子分母、远程 job 身份和 35 份原始输出的大小/SHA-256（含后补 PG 专项及其准备失败记录）。没有复制巨大日志、测试正文、用户会话内容或凭据值；hash 只是追溯输入完整性的辅助证据，不表示日志已永久归档。

## 各工作区测试结果

### 本机 Vitest

文件结果列依次为“通过 / 失败 / 跳过”，测试结果列依次为“通过 / 失败 / 跳过 / todo”。耗时来自各自日志，多个命令存在并行，不能把这些耗时简单累加成实际墙钟时间。

| 工作区           | 测试文件总数 | 文件结果      | 测试总数 | 测试结果             | 日志耗时  |
| ---------------- | -----------: | ------------- | -------: | -------------------- | --------- |
| server           |          906 | 789 / 114 / 3 |    8,204 | 7,378 / 801 / 22 / 3 | 314.14 秒 |
| web              |          354 | 354 / 0 / 0   |    2,591 | 2,591 / 0 / 0 / 0    | 131.06 秒 |
| shared           |          133 | 133 / 0 / 0   |    1,850 | 1,850 / 0 / 0 / 0    | 6.96 秒   |
| mobile           |           90 | 90 / 0 / 0    |      458 | 458 / 0 / 0 / 0      | 8.89 秒   |
| hand-server      |            9 | 9 / 0 / 0     |       61 | 61 / 0 / 0 / 0       | 2.13 秒   |
| acs-orchestrator |           48 | 48 / 0 / 0    |      413 | 413 / 0 / 0 / 0      | 17.54 秒  |

server 的 12 个未处理错误不包含在“801 失败断言”的替代计数中。Web/shared 各自成功生成覆盖率摘要；server 虽以 coverage 模式启动，但失败后没有产出可供本报告使用的 `server-coverage/coverage-summary.json`，本地失败执行不能冒充完整 server 覆盖率基线。

本机 server 的三个全跳过文件有独立前提：

| 文件                                                       | 跳过前提                                     | 应如何理解                                                      |
| ---------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| `server/src/__tests__/agentRuntimeProfileStore.pg.test.ts` | `AGENT_PROFILE_TEST_PG_URL` 才会启用该 suite | 提供 `TEST_DATABASE_URL` 不会自动启用所有名字不同的 PG 专项开关 |
| `server/src/__tests__/aliyunRuntimeWrapper.test.ts`        | 显式要求 Linux                               | 在 Darwin 跳过是平台契约，不是断言通过                          |
| `server/src/__tests__/containerExecutionProvider.test.ts`  | `dockerReady()` 守卫                         | 不能声称本次已完成真实容器集成验证                              |

Hand 的 9 文件/61 测试本次独立通过，ACS 的 48 文件/413 测试也独立通过；这不改变 [OPS-07](./delivery-operations.md#ops-07hand-自有测试未进入根测试命令和-ci) 关于“Hand 自有 suite 没被日常根 test/APP CI 调度”的结论。本次人工补跑能发现盲区，却不能让后续提交自动得到同样保护。

### 后补真实 PG：5 条由 skip 转为独立验证，不改写原始全量

原始全量中的 `.pg.test.ts` 文件子集为 79 个发现、78 个包含通过断言、1 个全 skip，断言为 451 通过、0 失败、5 跳过。这是按文件名筛出的子集，不是所有名称下数据库检查的唯一总数；也证明不应把本机 server 失败笼统解释成“PostgreSQL 全部不可用”。

发现 `AGENT_PROFILE_TEST_PG_URL` 没有接入标准测试变量后，主审查者重新启动本次专属 PostgreSQL，并用正确的 55438 端口补测该单文件。结果为 **1 文件失败，5 测试中 3 通过、2 失败、0 跳过**，约 0.314 秒；随后再次安全停止数据库。来源是 `agent-profile-pg-confirmed-tests.json/log`，开始时间为 2026-09-08 00:55:42 UTC。

第一次重启未传正确端口，导致 `agent-profile-pg-tests.json/log` 中出现 ECONNREFUSED；这是检查准备错误。保留该记录的存在和 hash 是为了审计完整性，不能把它计入业务缺陷，也不能拿它代替第二次真正连通数据库后的结果。

两个真实断言失败的归因不同：

| 位置          | 实际差异                         | 归因与下一步                                                                                              |
| ------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| PG 测试 `:38` | 期待 memory_poll v2，实际 v3     | 过期测试。builtin 已发布 v3，普通契约测试也已更新；新库播种是正确的，需修正 PG 期待和统一入口             |
| PG 测试 `:68` | 恢复原始 v1 后再次 init，仍然 v1 | 期待目标 v2 也旧了，但改成 v3 仍失败；seed 只允许紧邻 v2→v3，跨中间版本/恢复旧 DB 时 v1 不升级，见 REL-12 |

后者不是 init 被缓存跳过：当前每次 init 都执行，且已有 advisory lock/seed 事务；问题是 SQL 只匹配最大历史版本。新空库及正常 v2→v3 不受影响，自定义草稿和已有会话 pinned 版本必须保留。

以上结果独立记录在 JSON `additionalTests.agentProfilePgFollowup`，**不把原全量改成“115 个失败文件”或“803 个失败断言”**。先前全量与后补专项是两次不同执行；同 SHA Linux APP CI 的通过也没有自动覆盖这个当时被专属变量守卫跳过的 suite。测试入口缺口见 ENG-03，产品的条件升级缺口见 REL-12。

### 五个 KY App 包

原始来源为 `packages-tests.log`。这是各包的 Vitest 执行结果，不能扩张为所有可选原生、浏览器 E2E 或包脚本都运行过。

| 工作区                   | 文件数 | 测试数 | 结果     |
| ------------------------ | -----: | -----: | -------- |
| packages/ky-app-contract |     11 |    144 | 全部通过 |
| packages/create-ky-app   |      1 |     15 | 全部通过 |
| packages/ky-app-browser  |      5 |     50 | 全部通过 |
| packages/ky-app-server   |     15 |    199 | 全部通过 |
| packages/ky-app-cli      |     11 |     74 | 全部通过 |
| 合计                     |     43 |    482 | 全部通过 |

`ky-app-server` 使用了临时独立 `TEST_DATABASE_URL`。其 Vitest include 范围内通过的 PG 测试，不等于对真实生产数据库做过一致性检查。

### Node 原生测试与契约

| 检查                                                    | 测试总数 | 通过 | 失败 | 跳过 | 取消 | 结果              |
| ------------------------------------------------------- | -------: | ---: | ---: | ---: | ---: | ----------------- |
| Release + Staging 契约                                  |      725 |  673 |   40 |   11 |    1 | 失败，约 75.74 秒 |
| Mobile plugins/scripts/native/RC/rehearsal/rollout 契约 |      191 |  191 |    0 |    0 |    0 | 通过，约 4.08 秒  |
| Ratchet 自有回归                                        |       36 |   36 |    0 |    0 |    0 | 通过              |
| Web OSS 构建中的 HTTP upgrade/live OSS 脚本测试         |        3 |    3 |    0 |    0 |    0 | 通过              |

Mobile 的 458 个 Vitest 测试和这 191 个 Node 契约是两个不同入口，不能遗漏后一部分，也不能把它们说成 649 个真机 E2E。本文没有把配置/静态契约通过当作 iOS/Android 原生编译、Maestro 设备执行、商店签名发布或用户旅程验证。

Release 失败和取消的文件分布如下，合计恰好 40 失败、1 取消：

| 文件                                                         | 失败断言 | 取消 |
| ------------------------------------------------------------ | -------: | ---: |
| `scripts/release/compatibility-deploy-transaction.test.mjs`  |        6 |    0 |
| `scripts/release/compatibility-release.test.mjs`             |        3 |    0 |
| `scripts/release/deploy-production-rollback.test.mjs`        |        3 |    0 |
| `scripts/release/production-lock-lease.test.mjs`             |        2 |    0 |
| `scripts/release/publish-release-record.test.mjs`            |        5 |    0 |
| `scripts/release/run-with-production-lock-guard.test.mjs`    |        2 |    1 |
| `scripts/release/seal-root-staged-payload.test.mjs`          |        5 |    0 |
| `scripts/release/verify-selected-release-artifacts.test.mjs` |       14 |    0 |

## 为什么本机失败不能一刀切归因

可以确认的环境差异有：

1. **Linux 描述符相对文件操作**：`server/src/security/trustedFile.ts` 明确依赖 Linux `/proc`。Darwin 无法满足该安全实现的运行前提，会在 transcript、上传/文件及其上层 HTTP 测试中出现级联失败。修复开发体验不应通过削弱 O_NOFOLLOW/目录描述符保护完成。
2. **缺少 flock**：日志确有 `spawn flock ENOENT` 和 shell 的 `flock: command not found`。配置事务、发布锁等依赖路径可能在进入所测业务分支之前就失败；不能把由此产生的 500/400 逐个算成独立业务问题。
3. **BSD tar 与 GNU tar 不同**：发布测试使用 `--quoting-style=literal`、`--transform` 等 GNU 参数，本机 tar 不支持。制品读取/归一化 fixture 会提前失败。
4. **Linux 特有设备/进程语义**：日志中的 `/dev/full` 权限错误，以及 /proc、进程组、PID/start-time 所有权等测试，需要按目标 Linux 环境解释。

但上述事实**不允许推出“114 个文件、801 个断言全部只是同一个系统问题”**。原始失败列表还包含等待超时、异步未收尾、shell 输出差异、HTTP 状态断言和其他配置结果差异。即使某个失败的第一条栈没有出现 /proc，也不能反过来直接认定为生产逻辑 bug；必须沿上游初始化和异步错误继续追踪。

后续处理建议分开建立三个集合：

- 已证明的运行前提不满足：在标准 Linux 容器/CI 下复验，或给本机入口做显式 prerequisite 检查和清晰跳过；保留目标平台安全机制。
- 待归因的本机差异：按文件和断言最小化，先排除并发测试污染、临时目录/路径前提、超时预算和未处理错误，再判断是否需要改业务。
- 已有独立机制证据的真实问题：以 REL/SEC/OPS/UX 专题为准，即使某条 happy-path suite 通过，仍补并发交错、崩溃点、取消和恢复回归。

这轮没有为了得到“全绿”重写测试、扩大 timeout、禁用安全分支或减少断言。完整失败清单见本文附录及持久 JSON；其中的数量是待复核入口，不是修复工单数量。

## 类型、lint、构建和静态门禁

| 检查                         | 实际结果                                    | 解释及限制                                                                                       |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 递归 TypeScript typecheck    | 11 个 workspace 全部完成                    | 证明当时类型检查通过，不证明数据竞态、运行时平台支持或最后 HEAD                                  |
| 有效 ESLint 检查             | 4,378 文件，0 error，1,898 warning，0 fatal | 没有改规则或自动修复；warning 需按调用上下文审查                                                 |
| 第一次 ESLint CLI 调用       | CLI 参数范围错误                            | `.github/scripts` 参数只匹配 ignored 内容；不是源码 lint error，也不能把第一次失败隐藏成从未发生 |
| max-lines/env ratchet        | 通过                                        | 49 个 grandfathered 文件；它防新增膨胀，不代表所有文件已经足够小                                 |
| packages build               | 5 个 KY App 包全部完成                      | 包含 contract schema 复制；不发布包                                                              |
| server build                 | 完成                                        | 主 bundle 约 9.0 MB，sourcemap 18.7 MB；7 个 admin command 加 launcher 完成构建                  |
| Web 生产链                   | 完成                                        | API 边界、Workflow lint/sanitize、OSS 构建、dist 契约及启动预算通过                              |
| Expo 依赖检查                | exit 0，但离线                              | 同时提示离线验证不可靠；不能等价于联网依赖健康或原生构建通过                                     |
| comparison layout 浏览器检查 | 布局断言通过，清理挂起需人工解除            | 不是完整的无人值守成功，见下一节                                                                 |
| management contract          | 独立 exit 1                                 | 平台配置项期望 14、实际 13，基线已有；不是外层 shell exit 0 就可忽略                             |

### ESLint 的具体分布

| 规则                                 | warning | 含义                                                |
| ------------------------------------ | ------: | --------------------------------------------------- |
| `@typescript-eslint/no-explicit-any` |   1,773 | 类型精度债务；测试 fixture 与生产逻辑分开治理       |
| `react-hooks/exhaustive-deps`        |     123 | 可能涉及闭包/副作用依赖；需看行为，不能机械添加依赖 |
| 未使用的 eslint-disable              |       2 | 无规则错误的多余关闭指令；不是 fatal error          |
| 合计                                 |   1,898 | 没有等价的“1,898 个已证实 bug”结论                  |

按测试/非测试划分：测试代码 1,529 warning（1,528 any、1 个多余 disable）；非测试代码 369 warning（245 any、123 hooks、1 个多余 disable）。可自动修复的 warning 只有 2；本次没有执行 fix。按 workspace 的全部分布在 JSON 的 `lint.byWorkspace`，重点总量为 server 1,558、mobile 137、web 97、ACS 69、Hand 31、shared 6，其余包/脚本为 0。

当前 CI 是否执行相同 lint 入口是独立问题，详见 [发布与运维专项](./delivery-operations.md) 的 OPS-06；本次人工 lint 通过不能补齐未来提交的 CI 门禁。

### 构建产物与预算

Web Vite 本次转换 3,257 个模块，构建阶段约 5.51 秒。PWA precache 为 202 个入口、5,314.91 KiB。OSS 分域产物检查通过，demo 在仓库但不在 dist。

启动预算的真实结果：

| 指标            |         数值 |
| --------------- | -----------: |
| 首屏 JS 请求    |            1 |
| 首屏 CSS 请求   |            1 |
| 首屏 JS gzip    | 357,588 字节 |
| 首屏 CSS gzip   |  35,039 字节 |
| 首屏 JS Brotli  | 285,437 字节 |
| 首屏 CSS Brotli |  27,772 字节 |

脚本提示可把旧 JS gzip 基线 359,773 下调到 357,588；本审计**没有更新 baseline**。构建仍有 Browserslist 数据约 8 个月未更新，以及主 JS chunk 过大的提示。预算通过说明未超过当前规定范围，不证明慢网、低端设备、业务渲染或交互性能达标；PWA precache 总量也不等于首屏同步下载量。

环境变量 ratchet 的静态计数为 server 64、ACS 43、Hand 17、shared/runtime 2、Web build-time 3、deployment/scripts 40、packages 19。动态变量名称另被列出、没有纳入计数。这种边界应保留在解释中，不能声称代码只能读取这些数量的环境变量。

## 浏览器、管理契约与 Expo 的特殊状态

### comparison layout：断言成功，生命周期没有自然结束

`pnpm -F web check:comparison-layout` 的 800px fixture 中，各种对照项标签得到一致列轨道，值列起点为 173、401、629，布局断言已输出。

随后该脚本的专属 Vite 进程在清理阶段挂起约 15 分钟。主审查者仅终止这次 fixture 的两个专属进程后，命令才解除等待并返回 exit 0。因此准确状态是“布局断言通过；进程清理挂起，人工干预后退出”，不是“完整端到端命令自然成功”。应在后续修复时检查启动的进程/子进程所有权、退出事件监听和 finally 清理上限。

### management contract：明确保留失败

后补独立执行的 `pnpm -F web check:management-contract` 返回 exit 1，`web/scripts/check-management-contract.mjs:62` 要求平台配置页 14 项，实际得到 13 项。主审查者确认相关导航及检查脚本没有被审查期间的 #572 改动，所以该契约不一致属于原基线已有问题。

进一步源码/历史核对已经明确：#556 的 `39707f5b910e28be6617a812921c01941e699f6f` 有意移除旧 `platform-system-deliveries` 入口，`web/src/lib/managementNavigation.contract.test.ts:26` 已要求 13 项并检查统一业务系统入口；是独立检查脚本没有同步，不是产品漏了一个页面。后续应把它接到相同权威导航契约，减少源码正则和固定数字的第二套事实源；不能为了保留旧数字反向补回已退役页面。详见 ENG-03。外层 shell 因另一条命令最后返回 0，不会改变此命令本身失败的事实。

### Expo：离线兼容检查，不是供应链或原生发布证明

本次执行 `EXPO_OFFLINE=1 pnpm -F mobile exec expo install --check`，退出码 0，输出 “Dependencies are up to date”，同时明确输出 “Dependency validation is unreliable in offline-mode”。

因此只记录为离线依赖兼容检查完成；不能声称查到了最新推荐版本、完成了所有依赖公告核验、成功进行了 iOS/Android native build，或验证了真实设备分享、通知、文件权限和升级流程。依赖风险另见 [依赖专项](./dependencies.md)。

## 覆盖率：数字、分母和盲区

### 本机成功执行的摘要

| 工作区 |             插桩文件数 | Statements               | Branches                 | Functions               | Lines                   |
| ------ | ---------------------: | ------------------------ | ------------------------ | ----------------------- | ----------------------- |
| shared |                    192 | 79.97%（8,830 / 11,041） | 74.27%（8,317 / 11,198） | 78.45%（1,551 / 1,977） | 83.12%（7,691 / 9,252） |
| web    |                     81 | 80.22%（1,688 / 2,104）  | 72.37%（1,370 / 1,893）  | 85.02%（403 / 474）     | 82.39%（1,446 / 1,755） |
| server | 未生成可用本地 summary | 不把失败执行作为完整基线 | —                        | —                       | —                       |

这是项目配置中的**逻辑层覆盖率**。尤其 Web 排除了 .tsx、components、layouts、hooks、types 等；81 个插桩文件并不包含整个 UI。354 个 Web 测试文件通过与“所有 React 组件/hooks 均纳入该百分比”是不同命题。源码库存包含脚本/配置等，不能简单用 81 除以库存 sourceFiles 作为另一种覆盖率。

Server 排除了入口、部分 scripts/migrations/type 定义等；shared 排除了纯类型、tests/mocks。覆盖率不直接证明崩溃恢复、数据库隔离、跨进程原子性或真实浏览器用户流程，亦不能因“某行执行过”就认定断言覆盖了故障不变量。

值得优先核对的局部空白（仅当对应代码仍在实际调用链中使用时）：

| 文件                                     | 行覆盖率            | 分支覆盖率         | 建议                                                                     |
| ---------------------------------------- | ------------------- | ------------------ | ------------------------------------------------------------------------ |
| `web/src/lib/messageCache.ts`            | 43.69%（52 / 119）  | 28.57%（24 / 84）  | 结合账号切换、缓存恢复/清理和失败分支补行为回归                          |
| `shared/src/hooks/useGroups.ts`          | 0%（0 / 165）       | 0%（0 / 84）       | 先核对真实消费方，仍使用则补分组加载/变更/异常测试；废弃则按使用证据整理 |
| `shared/src/schemas/workflowScenario.ts` | 69.06%（163 / 236） | 34.39%（65 / 189） | 增加 schema 条件组合、非法输入和迁移兼容断言                             |

### 同 SHA Linux 聚合结果

远程来源：[APP CI 34169355270](https://github.com/ZengLeiPro/agent-saas/actions/runs/34169355270)，`Build & Check` job 的已下载日志。主审查者此前完成远程读取，本次固化时没有再次请求网络。

| 工作区 | 文件结果                 | 测试结果                              | Statements | Branches | Functions |  Lines |
| ------ | ------------------------ | ------------------------------------- | ---------: | -------: | --------: | -----: |
| server | 904 通过、2 跳过，共 906 | 8,183 通过、18 跳过、3 todo，共 8,204 |     75.33% |   67.36% |    76.29% | 78.80% |
| web    | 354 通过                 | 2,591 通过                            |     80.22% |   72.42% |    85.02% | 82.39% |
| shared | 133 通过                 | 1,850 通过                            |     79.97% |   74.27% |    78.45% | 83.12% |

Server 远程分子/分母分别为 statements 72,535/96,281，branches 56,712/84,185，functions 12,386/16,234，lines 66,359/84,211。三工作区总计按工具一位小数输出为 statements 75.9%、branches 68.3%、functions 76.7%、lines 79.3%；完整计数也已写入 JSON。

本机 Web 与 Linux Web 的分支覆盖率相差一个分支（1,370 vs 1,371，分母均 1,893）。不应为了整齐抹平差异，也不应仅凭这一个数字宣称回归。

远程日志定位为 shared 508/509/518 行、server 9,434/9,435/9,444 行、web 12,419/12,420/12,429 行；前两行是 files/tests，第三行是 All files coverage。日志临时文件名为 `github-build-check.log`，不能依赖它永久存在，故核心数值已在本文固化。

## 远程 CI 与发布结果的证据边界

APP CI 元数据 `github-app-ci.json` 明确绑定审查 SHA、push 事件和 success。创建时间为 2026-09-07 23:14:24 UTC，更新时间为 23:25:14 UTC（北京时间为 9 月 8 日早晨）。本次 run 的 4 个 server、2 个 web、1 个 shared 分片 job 齐全且 success；另有静态检查、PostgreSQL 契约、Web 生产构建、Mobile/原生发布契约、Mobile 路由导出以及最终 Build & Check 成功。JSON 保存了所有 job 的名称、数字 ID、起止时间和直达链接。

这里需要分开两个判断：

- **本次 run 的实际证据完整**：测试文件/断言聚合与预期规模相符，7 个分片均记录成功。
- **以后所有 run 的 coverage 完整性有硬保证**：不是；OPS-05 记录了 artifact 下载/合并与缺片完整性门禁的设计缺口。不能拿当前成功样本反证未来故障窗口，也不能把潜在缺口写成当前 run 已缺片。

该 APP CI 中历史“部署到 ECS / 规划生产部署 / 将 Web 部署到 OSS”三个 job 是 skipped；它们不是本次 CI 失败，也不能把这三个 skipped 写成已执行生产部署。主审查者已另外核对下列独立 run 成功，无需重复联网：

| 流程      | Run                                                                              | 状态    | 能证明什么            |
| --------- | -------------------------------------------------------------------------------- | ------- | --------------------- |
| ACS CI    | [34169355282](https://github.com/ZengLeiPro/agent-saas/actions/runs/34169355282) | success | 对应 ACS 验证链完成   |
| Staging   | [34169361409](https://github.com/ZengLeiPro/agent-saas/actions/runs/34169361409) | success | 对应 Staging 流程完成 |
| Promotion | [34171082432](https://github.com/ZengLeiPro/agent-saas/actions/runs/34171082432) | success | 对应晋级流程完成      |

这些都是那次 run 的事实，不是“当前全部生产流量和业务功能健康”的现场证明；本审计没有登录生产、查看真实数据库或补发部署。

## 仓库库存

以下为最初捕获的 tracked-file 库存：总共 5,647 个受 Git 跟踪文件；按该脚本的工作区源码/测试分类，源码 2,708 文件、554,092 行，测试 1,642 文件、338,983 行。剩余文档、配置、资源等并不因此是“漏数”。文件内容变化后需重新生成库存，不能把当前 HEAD 的新文件叠进旧快照分母。

| 工作区                   | 源码文件 |  源码行 | 测试文件 |  测试行 |
| ------------------------ | -------: | ------: | -------: | ------: |
| acs-orchestrator         |       57 |  14,352 |       48 |  11,103 |
| hand-server              |        7 |   2,149 |        9 |   1,512 |
| mobile                   |      388 |  50,425 |      109 |  10,798 |
| packages/create-ky-app   |       25 |   1,857 |        3 |     413 |
| packages/ky-app-browser  |       14 |   1,751 |        6 |   1,335 |
| packages/ky-app-cli      |       37 |   5,654 |       11 |   1,105 |
| packages/ky-app-contract |       23 |   2,554 |       11 |   1,487 |
| packages/ky-app-server   |       35 |   4,864 |       18 |   3,876 |
| server                   |    1,268 | 300,723 |      935 | 234,046 |
| shared                   |      225 |  50,725 |      133 |  21,748 |
| web                      |      629 | 119,038 |      359 |  51,560 |
| 合计                     |    2,708 | 554,092 |    1,642 | 338,983 |

静态识别到的 testFiles 不等于本次 Vitest 执行文件数，例如 Mobile 还有 Node 脚本/native 契约，Server include 模式也不等于“所有路径上看起来像 test 的文件”。不要借这种分母差异判断自动漏跑，必须比较具体测试入口。

非测试源码超过 1,000 行的有 32 个；最长文件包括 WebChannel 4,227 行、rawAgentLoop 3,893 行、sessions 路由 3,306 行、runtime 装配 2,989 行、rawRuntimeRunDispatch 2,985 行、Web useChatAppState 2,707 行。完整 largest 列表在 JSON。32 个 >1,000 行源码与 max-lines ratchet 的 49 个 grandfathered 文件不是同一统计规则，不矛盾。

行数高只是维护成本信号，不是独立功能缺陷。适合按权限边界、事务边界、事件转换和资源生命周期拆分，并保留协议回归；不宜在没有行为保障时仅为降行数机械抽函数。

## 凭据形状扫描的真实范围

扫描仅限当时 Git 跟踪内容，5,578 个文本文件；69 个二进制或超过 2,000,000 字节的文件跳过。规则覆盖 AWS/阿里云 access-key 形状、私钥标记、LLM key 和 GitHub token 形状，共 16 个位置，均为示例或测试。敏感文件名形状仅命中 `.env.ecs.example`。输出只保留路径、行号和种类，没有输出匹配值；没有已证实的真实凭据泄漏。

它不是一次完整密钥审计，也没有证明历史上从未泄漏：

- 没有扫描完整 Git 历史、忽略的真实配置或用户工作区。
- 没有扫描镜像层、云端制品、CI artifact 或生产日志。
- 没有向供应商接口验证 key 是否有效。
- 形状规则会存在误报和漏报；示例占位符通过人工判断后不应成为每次都报红的噪声，但不得泛化忽略真实代码中的相似形状。

具体安全建议见 [安全专项](./security.md)。依赖漏洞公告和锁文件路径在 [依赖专项](./dependencies.md)，不与这次源码凭据形状扫描混算。

## 命令与后续复验方式

完整 shell 历史没有全部保留，不能伪造一次逐字相同的命令记录。下表明确区分主审查者可确认的原命令/日志中的脚本入口，以及依据结果和仓库脚本整理的等价复验方式。未来执行前先建新的临时证据目录，使用独立测试数据库，并确保当前要验的 SHA；不要重用生产连接字符串。

| 检查                  | 已知命令或入口                                                                                                                                                                                                                        | 证据性质                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 类型检查              | `pnpm -r typecheck`                                                                                                                                                                                                                   | 主审查者确认的原命令                            |
| Web 生产链            | `bash scripts/pr-preflight-task.sh web`                                                                                                                                                                                               | 主审查者确认的原命令                            |
| Release/Staging       | `node --test --test-concurrency=2 scripts/release/*.test.mjs scripts/staging/*.test.mjs`                                                                                                                                              | 主审查者确认的原命令                            |
| Agent Profile PG 后补 | 显式设置 `AGENT_PROFILE_TEST_PG_URL` 后，`pnpm -F server exec vitest run src/__tests__/agentRuntimeProfileStore.pg.test.ts --reporter=default --reporter=json --outputFile.json=<EVIDENCE_DIR>/agent-profile-pg-confirmed-tests.json` | 原命令仅将输出目录折为占位符；3 通过、2 失败    |
| Expo                  | `EXPO_OFFLINE=1 pnpm -F mobile exec expo install --check`                                                                                                                                                                             | 主审查者确认的原命令                            |
| Ratchets              | `pnpm check:ratchets`                                                                                                                                                                                                                 | 日志明确记录的入口                              |
| Server build          | `pnpm -F server build`                                                                                                                                                                                                                | 日志明确记录的入口                              |
| Browser layout        | `pnpm -F web check:comparison-layout`                                                                                                                                                                                                 | 已执行，人工解除清理挂起                        |
| Management contract   | `pnpm -F web check:management-contract`                                                                                                                                                                                               | 已独立执行，exit 1                              |
| ESLint                | `pnpm exec eslint server shared web mobile acs-orchestrator hand-server packages scripts --format json`                                                                                                                               | 等价复验命令，不声称完整还原历史 flags          |
| KY App 包构建         | `pnpm --filter './packages/*' run build`                                                                                                                                                                                              | 等价复验命令                                    |
| 各 workspace Vitest   | workspace 内 `vitest run`，加 JSON reporter；server/web/shared 开启 coverage、输出到独立目录                                                                                                                                          | 等价复验模板；server 的 `--maxWorkers=2` 已确认 |
| Mobile Node 契约      | 执行 `mobile/package.json` 的 `test` 中 `node --test` 部分                                                                                                                                                                            | 等价复验入口，避免与 Vitest 重复统计            |

在这台 Mac 的非交互 shell 中，需显式选择项目 Node 版本。建议复验模板如下；它们仅供未来使用，本次整理证据没有执行：

```sh
export PATH=/Users/admin/.nvm/versions/node/v22.23.1/bin:$PATH

# <NEW_EVIDENCE_DIR> 为新建的专属目录；模板占位符需先替换。
pnpm -C server exec vitest run --coverage --maxWorkers=2 \
  --reporter=default --reporter=json \
  --outputFile.json=<NEW_EVIDENCE_DIR>/server-tests.json \
  --coverage.reportsDirectory=<NEW_EVIDENCE_DIR>/server-coverage
```

Server 的真实可执行验收应同时满足 Linux /proc、flock/GNU 工具和测试数据库前提；仅把以上命令原样搬回当前 Darwin shell，不会自动消除已有平台差异。各工作区的等价命令已记录在 JSON `suites.<workspace>.command`；所有原 flags 未知时，不以模板冒充历史原命令。

Mobile release/native 等步骤有自己的更高成本与设备/凭据前提。未来复验要分别记录测试、构建、设备执行、制品签名和发布，不能把某一层成功扩展到下一层。本次没有在报告阶段自动执行这些后续动作。

## 后续验收建议

首轮优先建立一个固定 Linux 验证入口，把 Node/包管理器、GNU 工具、Docker/PG 可用性和明确跳过项写进 preflight。应保存 workspace/file/assertion 数量与 skip 原因，不只保存一行 exit 0。

第二轮处理两项明确“检查本身没有正常完成”的结果：management 13/14 契约不一致，以及 browser layout 清理挂起。判断标准分别是权威导航设计一致、脚本无需人工杀进程即可稳定退出，不是只让外层 shell 变绿。

第三轮针对专题问题补故障点回归，尤其跨进程状态修改、异常 JSON、事务中断、计费 watermark、cron 完成后旁路失败、出站响应体取消与大小边界。覆盖率数字可追踪进度，但关键不变量应直接断言。

发布前将真正实施的修复绑定新 SHA，运行目标平台 suite 与必要浏览器/设备验收，再走已有 RC/Promotion 流程。本报告没有修改任何业务实现，所以这里的建议不是“修复已验证完成”的交付声明。

## 附录：本机 server 全部失败文件

以下 114 文件仅保存相对路径、失败断言数和该文件断言总数，不复制原始正文或错误日志。失败数之和为 801。它们是后续最小化复验的索引；同一根因可能跨多个文件，同一文件也可能有多个不同根因。

| 文件                                                                   | 失败断言 | 文件断言总数 |
| ---------------------------------------------------------------------- | -------: | -----------: |
| `server/src/__tests__/adminConfigMutationService.test.ts`              |       13 |           14 |
| `server/src/__tests__/agentRuntimeProfiles.test.ts`                    |        4 |           13 |
| `server/src/__tests__/appRuntimeCoverage.test.ts`                      |        1 |            8 |
| `server/src/__tests__/artifactRoutes.test.ts`                          |       14 |           14 |
| `server/src/__tests__/artifactShare.test.ts`                           |       10 |           10 |
| `server/src/__tests__/artifactStore.test.ts`                           |        4 |           12 |
| `server/src/__tests__/audioTranscribeAdmin.test.ts`                    |       11 |           18 |
| `server/src/__tests__/audioTranscribeToolProvider.test.ts`             |        8 |           10 |
| `server/src/__tests__/backgroundProfileRecovery.test.ts`               |        1 |            1 |
| `server/src/__tests__/builtinTools.test.ts`                            |        3 |           14 |
| `server/src/__tests__/capabilityEnableTransaction.test.ts`             |        7 |           13 |
| `server/src/__tests__/chatSubmissionV1.test.ts`                        |        2 |            3 |
| `server/src/__tests__/clientDaemonRunner.test.ts`                      |        1 |            9 |
| `server/src/__tests__/codexSubscriptionAdmin.test.ts`                  |        3 |            4 |
| `server/src/__tests__/emfileRegression.test.ts`                        |        2 |            9 |
| `server/src/__tests__/feedbackRoutes.test.ts`                          |        4 |            5 |
| `server/src/__tests__/fileRoutes.test.ts`                              |       13 |           15 |
| `server/src/__tests__/fileRoutesReadListDelete.test.ts`                |       19 |           32 |
| `server/src/__tests__/groupsCoverage.test.ts`                          |        4 |           11 |
| `server/src/__tests__/groupsRoutes.test.ts`                            |        1 |            1 |
| `server/src/__tests__/guardrailService.test.ts`                        |        1 |           12 |
| `server/src/__tests__/imageAttachments.test.ts`                        |       10 |           13 |
| `server/src/__tests__/imageGenPricingAdmin.test.ts`                    |        4 |            6 |
| `server/src/__tests__/imageGenToolProvider.test.ts`                    |       16 |           26 |
| `server/src/__tests__/kbFileRoutes.test.ts`                            |        9 |           10 |
| `server/src/__tests__/kbPreviewGenerator.test.ts`                      |        4 |            4 |
| `server/src/__tests__/mcpConfigStore.test.ts`                          |        1 |           19 |
| `server/src/__tests__/memoryConsolidation.test.ts`                     |        5 |           17 |
| `server/src/__tests__/memoryConsolidationEngine.test.ts`               |        3 |           21 |
| `server/src/__tests__/memoryContextReplay.test.ts`                     |        1 |            1 |
| `server/src/__tests__/memoryPollingAdmin.test.ts`                      |        3 |            4 |
| `server/src/__tests__/modelsAdmin.test.ts`                             |       30 |           31 |
| `server/src/__tests__/modelsAdminGuardrailDisable.test.ts`             |        1 |            1 |
| `server/src/__tests__/modelsAdminQuotaSource.test.ts`                  |        2 |            2 |
| `server/src/__tests__/parseTokenUsage.test.ts`                         |       11 |           11 |
| `server/src/__tests__/previewRoutes.test.ts`                           |        3 |            3 |
| `server/src/__tests__/rawAgentLoop.automationGate.test.ts`             |        5 |            5 |
| `server/src/__tests__/rawAgentLoop.compact.test.ts`                    |       11 |           12 |
| `server/src/__tests__/rawAgentLoop.test.ts`                            |       71 |           72 |
| `server/src/__tests__/rawAgentLoopClaimRecovery.test.ts`               |        4 |            4 |
| `server/src/__tests__/rawAgentLoopHandFailureCoverage.test.ts`         |        7 |            7 |
| `server/src/__tests__/rawAgentLoopInterjectionBoundary.test.ts`        |       10 |           10 |
| `server/src/__tests__/rawAgentLoopPolicyFailure.test.ts`               |        3 |            3 |
| `server/src/__tests__/rawAgentLoopResumeInterjectionBoundary.test.ts`  |        2 |            2 |
| `server/src/__tests__/rawAgentLoopTaskboardRetry.test.ts`              |        9 |            9 |
| `server/src/__tests__/rawAgentLoopToolInput.test.ts`                   |        1 |            1 |
| `server/src/__tests__/readImageTool.test.ts`                           |        2 |            2 |
| `server/src/__tests__/runtimeAuditQuery.test.ts`                       |        6 |            8 |
| `server/src/__tests__/runtimeAuditRoutes.test.ts`                      |       14 |           14 |
| `server/src/__tests__/runtimeReplay.test.ts`                           |        2 |            2 |
| `server/src/__tests__/runtimeSessionProjection.test.ts`                |        6 |            6 |
| `server/src/__tests__/runtimeStage2.test.ts`                           |        6 |           21 |
| `server/src/__tests__/runtimeStoresPureSlices.test.ts`                 |        2 |           39 |
| `server/src/__tests__/runtimeToolControlsRefresh.test.ts`              |        1 |            2 |
| `server/src/__tests__/runtimeTranscriptFdBoundaries.test.ts`           |        2 |            4 |
| `server/src/__tests__/sessionCatalog.test.ts`                          |       13 |           18 |
| `server/src/__tests__/sessionContext.test.ts`                          |        6 |            7 |
| `server/src/__tests__/sessionsForkDeleteCoverage.test.ts`              |       15 |           17 |
| `server/src/__tests__/sessionSharesRoutes.test.ts`                     |       12 |           13 |
| `server/src/__tests__/sessionsInteractionsPendingAccess.test.ts`       |        7 |            8 |
| `server/src/__tests__/sessionsRoutesLifecycleCoverage.test.ts`         |       20 |           24 |
| `server/src/__tests__/sessionsRoutesMetaOnly.test.ts`                  |       16 |           17 |
| `server/src/__tests__/sessionsRoutesMetaOnlyList.test.ts`              |        6 |            8 |
| `server/src/__tests__/sessionsTaskboardReadAccess.test.ts`             |        4 |            4 |
| `server/src/__tests__/sessionWarmupRoutes.test.ts`                     |        3 |            3 |
| `server/src/__tests__/shellTimeout.test.ts`                            |        1 |            1 |
| `server/src/__tests__/subagent.automationFence.test.ts`                |        2 |            2 |
| `server/src/__tests__/subagent.test.ts`                                |       25 |           29 |
| `server/src/__tests__/subagentLiveSwitch.test.ts`                      |        7 |            7 |
| `server/src/__tests__/systemPromptsAdmin.test.ts`                      |        2 |            2 |
| `server/src/__tests__/taskboardAttachmentResponse.test.ts`             |        7 |            7 |
| `server/src/__tests__/taskboardRoutes.test.ts`                         |        1 |           17 |
| `server/src/__tests__/taskboardSessionTitle.test.ts`                   |        2 |            6 |
| `server/src/__tests__/tenantRemoteHandsAdmin.test.ts`                  |        4 |            6 |
| `server/src/__tests__/titleGenerator.test.ts`                          |        8 |           27 |
| `server/src/__tests__/tokenUsageRebuild.test.ts`                       |        4 |           17 |
| `server/src/__tests__/toolConcurrencyRuntime.test.ts`                  |       10 |           10 |
| `server/src/__tests__/toolControlsAdmin.credentials.test.ts`           |        8 |           16 |
| `server/src/__tests__/toolControlsAdmin.test.ts`                       |       18 |           21 |
| `server/src/__tests__/toolControlsConfigBaseline.test.ts`              |        1 |            5 |
| `server/src/__tests__/toolFailurePresentation.test.ts`                 |        4 |            4 |
| `server/src/__tests__/toolPresentationPersistence.test.ts`             |       10 |           10 |
| `server/src/__tests__/toolRuntime.test.ts`                             |        2 |           49 |
| `server/src/__tests__/toolRuntimeWorkspaceIo.test.ts`                  |        2 |            3 |
| `server/src/__tests__/transcriptAttachments.test.ts`                   |        6 |            6 |
| `server/src/__tests__/transcriptDetailMemoryBounds.test.ts`            |        3 |            4 |
| `server/src/__tests__/transcriptFinalOutput.test.ts`                   |        1 |            3 |
| `server/src/__tests__/transcriptsDataCoverage.test.ts`                 |        8 |           15 |
| `server/src/__tests__/transcriptSessionIdIndex.test.ts`                |        2 |            4 |
| `server/src/__tests__/transcriptWindow.test.ts`                        |       15 |           15 |
| `server/src/__tests__/trustedFile.test.ts`                             |       14 |           16 |
| `server/src/__tests__/trustedTranscriptBoundaries.test.ts`             |        2 |            3 |
| `server/src/__tests__/trustedWorkspaceAgentFiles.test.ts`              |        4 |            6 |
| `server/src/__tests__/uploadAudioRange.test.ts`                        |        1 |            1 |
| `server/src/__tests__/uploadHardening.test.ts`                         |       21 |           26 |
| `server/src/__tests__/webChannelAgentTargetBinding.test.ts`            |        3 |            3 |
| `server/src/__tests__/webChannelAutoNaming.test.ts`                    |        3 |            3 |
| `server/src/__tests__/webChannelCoverage.test.ts`                      |       12 |           58 |
| `server/src/__tests__/webChannelExecutionQueueProjection.test.ts`      |        4 |            7 |
| `server/src/__tests__/webChannelExecutionTarget.test.ts`               |        6 |           17 |
| `server/src/__tests__/webChannelGuardrail.test.ts`                     |       15 |           20 |
| `server/src/__tests__/webChannelInteractionStagedLifecycle.test.ts`    |        9 |           10 |
| `server/src/__tests__/webChannelPersistedQuestionResume.test.ts`       |        3 |            4 |
| `server/src/__tests__/webChannelPersistentInteractionRecovery.test.ts` |        7 |           11 |
| `server/src/__tests__/webChannelSandboxProfile.test.ts`                |        2 |            2 |
| `server/src/__tests__/webChannelSessionMetaOrdering.test.ts`           |        1 |            1 |
| `server/src/__tests__/webChannelWsAuthorization.test.ts`               |        6 |           18 |
| `server/src/agent/containerEditHelper.test.ts`                         |       10 |           10 |
| `server/src/agent/localShellExecution.test.ts`                         |        1 |            4 |
| `server/src/agent/shellOutputAccumulator.test.ts`                      |        4 |            9 |
| `server/src/app/configRuntimeRecovery.integration.test.ts`             |        1 |            2 |
| `server/src/taskboard/safeServerGitRunner.test.ts`                     |        3 |           26 |
| `server/src/taskboard/taskboardTrustedWorkspaceResolver.test.ts`       |        1 |            2 |
| `server/src/taskboard/workspaceCommitMaterializer.test.ts`             |       20 |           20 |
