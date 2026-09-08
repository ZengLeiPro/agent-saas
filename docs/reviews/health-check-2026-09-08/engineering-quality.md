# 工程质量、验证可复现性与测试口径体检

基线：`a6b6865eba98cb0b4c08bf8f0359e8200aec7768`；检查日期：2026-09-08。本文只形成诊断和修复计划，没有修改业务代码、配置、门禁或测试。工作区在体检期间有其他任务推进；本章引用的配置、脚本和管理导航文件经 `git diff a6b6865e HEAD -- <本章所审文件>` 核对无差异，不把并发业务变更纳入本次结论。

本文消费主检查已生成的证据，不重新执行全量测试。原始证据目录为 `/private/tmp/agent-saas-health-20260908.82VCKZ/`，主要包括 `inventory.json`、`server-tests.json`、`server-failure-groups.txt`、`release-tests.log`、`ratchets.log`、`web-tests.json`、`web-coverage/coverage-summary.json`、`shared-coverage/coverage-summary.json`、`github-app-ci.json`、`github-build-check.log` 和 `browser-layout.log`；另读取主检查随后补充的 `agent-profile-pg-confirmed-tests.json/log`。该临时目录不是长期档案；下面保留了关键计数、定位与判读方法，后续应按主报告的证据归档方式保存日志。

证据等级：A＝本次已有实测/执行产物直接证明；B＝当前代码、配置、Git 历史可确定的行为或范围；C＝需要补充定向实验的归因假设。一个发现可能同时含 A/B 事实和 C 级未决项；不把 C 级内容升级为确定业务缺陷。估时按一名熟悉仓库的工程师有效工作日计算，不含排期等待。

## 一、结论及正确解读

| 编号   | 优先级 | 确定问题                                                                                       | 不应解读成什么                                           |
| ------ | ------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| ENG-01 | P2     | 本机与权威 Linux 验证环境不等价，入口缺少完整前置条件契约；另有布局检查完成断言后进程清理挂起  | 不是“生产有 801 个故障”，也不是应删除 Linux 文件安全限制 |
| ENG-02 | P2     | 巨型业务热点仍多，既有防增长机制未覆盖全部运维源码形态，环境变量统计也有明确边界               | 不是没有治理，也不是要求立即把所有文件拆到 1,000 行以下  |
| ENG-03 | P2     | 覆盖率只代表指定逻辑层；被排除层的验证不能由该百分比替代，且存在过期验收脚本和未激活的 PG 测试 | 不是“Web 没有 UI 测试”，也不是“产品少了一个页面”         |

本章不重复 [交付与运维章](delivery-operations.md) 的 OPS-05（coverage 分片完整性）、OPS-06（ESLint 必经门禁）和 OPS-07（Hand 自身测试入口）。这里讨论的是测试环境、度量语义、技术债治理范围及具体验收工具的有效性。

已有工程投入应明确肯定：同 SHA 的 [APP CI 34169355270](https://github.com/ZengLeiPro/agent-saas/actions/runs/34169355270) 成功；主检查归档的 Linux Server 结果为 8,183 passed、18 skipped、3 todo，904 个测试文件通过、2 个跳过；11 个工作区 typecheck 通过。仓库已存在按变更规划测试、全量分片、PostgreSQL 契约、真实浏览器布局夹具、管理导航单测、源码行数和环境变量预算棘轮。这不是缺少测试基础设施的项目，而是基础设施已很大、验证契约尚未完全收敛的项目。

## ENG-01：跨平台本地验证不可等价复现，且部分验收命令不能可靠结束

### 1. 证据、触发条件与影响

证据等级 A/B；影响主要是开发效率、结果可信度、回归定位成本和本地检查的可完成性。

本机是 macOS。即使 Node/pnpm/源码一致，下面这些入口也不是纯 JavaScript 单元测试：

| 位置                                                       | 当前契约及本次证据                                                                                                                         | 触发方式                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `server/src/security/trustedFile.ts:39`                    | 非 Linux 明确抛出 `ENOTSUP: Trusted descriptor-relative file operations require Linux /proc`；随后使用 `/proc/self/fd/<fd>` 绑定已打开对象 | macOS 上执行真正进入 trusted-file 路径的 Server 测试或功能 |
| `server/src/config/adminConfigMutationService.ts:69`       | `spawn('flock', ['--nonblock', …])` 获取跨进程配置写锁；本地日志有 `spawn flock ENOENT`                                                    | 本机缺少支持这些参数的 `flock` 时执行配置变更测试          |
| `scripts/release/verify-selected-release-artifacts.mjs:79` | 调用 `tar --list --verbose --gzip … --quoting-style=literal`；本地对应发布记录/选中制品测试在该命令失败                                    | 本机默认 tar 与 GNU tar 参数不兼容                         |
| `scripts/release/seal-root-staged-payload.sh:17`           | 使用 `realpath -m/-ms`；本次日志直接输出 `realpath: illegal option -- m`                                                                   | macOS 默认 realpath 不支持脚本所需参数                     |
| `scripts/release/compatibility-deploy-transaction.sh:13`   | 使用 `date -Is`；本次日志输出 `date: invalid argument 's' for -I`，另有临时路径 canonical 校验失败                                         | 本机 BSD 工具与 Linux 工具/路径语义不同                    |
| `.github/workflows/ci.yml:122`、`:134`、`:163`             | 权威分片运行在 Ubuntu，配置 PostgreSQL 16 服务，Node 来自 `NODE_VERSION`；`:44` 为 `22.23.1`                                               | CI 与 macOS 原生执行的操作系统及工具集合不同               |

`scripts/release/build-release.mjs:98` 已明确要求生产制品在 Linux 构建，原生依赖的平台边界是刻意设计，不应通过删除断言“兼容”掉。`scripts/pr-preflight-task.sh:6` 会检查 `TEST_DATABASE_URL`，但它没有在运行整套检查前一次性报告 Linux `/proc`、GNU 工具、`flock`、浏览器安装及版本等完整前置条件。`server/package.json:15` 的 `test` 直接接 typecheck + Vitest；`package.json:42` 的 Release 契约直接运行 Node 测试。结果是前置条件不满足时仍进入大量业务断言，形成高度噪声化的失败列表。

本次结果必须保留原状，不能只摘通过项：

| 验证                   | 实际结果                                                                                               | 正确结论                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| macOS Server 测试      | 8,204 total；7,378 passed、801 failed、22 skipped、3 todo；实际 906 文件中 792 标记 passed、114 failed | 本地整套检查没有通过；其中大量失败有明确平台前置条件证据，不能等同 801 个独立产品 bug                    |
| 同 SHA Linux Server CI | 8,183 passed、0 failed、18 skipped、3 todo；904 文件 passed、2 skipped                                 | 同一代码在权威环境通过现有用例；不能反向证明所有业务行为正确，但足以否定“本地红＝当前生产回归”的直接推断 |
| macOS Release 契约     | 725 total；673 passed、40 failed、11 skipped、1 cancelled、0 todo                                      | 本地契约检查没有通过，且有 GNU 工具、锁与路径差异；取消项也不能计入 passed 或普通 skip                   |
| macOS Web Vitest       | 2,591 passed、0 failed，354 个文件                                                                     | 仅证明这次 Vitest 子命令通过，不等于 `pnpm -F web test` 整条链成功                                       |
| 布局检查               | 输出全部 tracks JSON，布局断言已通过，但主检查观察到超过 15 分钟仍未退出，需要清理本次专属进程         | “布局断言通过，验收脚本清理挂起”，不是完整命令 green                                                     |

### 2. 另一个确定缺陷：布局脚本只结束包装层进程

`web/scripts/check-comparison-layout.mjs:40` 启动的是 `pnpm exec vite`，并捕获 stdout/stderr 管道；`:83` 在全部布局断言完成后输出结果。`:84` 的 finally 关闭浏览器，向所持有的 `vite` 变量发送 SIGTERM，并最多等待 2 秒的 `exit` 事件（`:86`—`:90`）。变量名虽然叫 vite，实际 ChildProcess 对象却是最外层 pnpm。

主检查的进程树证据显示：脚本进程 PID 73693 仍存在；`pnpm exec vite` PID 73728 已成为 PPID 1 的孤儿，其 Vite 子进程 PID 73734 仍在。结合代码，可以确定当前 finally 没有管理整个自有子进程树；存活后代保留继承的管道，是主脚本不能自然结束的有力解释。这里没有依据断言布局计算失败，也没有依据把原因笼统归咎于 Playwright。上述 PID 只用于本次取证，后续不能拿这些旧 PID 直接执行 kill。

影响不止是多等几分钟：`web/package.json:12` 将布局脚本放在管理契约检查之前，以 `&&` 串联。前者挂起会让后者根本没有机会执行；即使 Vitest 和浏览器断言都绿，调用方仍拿不到可信的进程级完成状态。主检查已经把管理契约脚本单独运行，其独立问题见 ENG-03。

### 3. 修复方案及不应采用的捷径

1. 建立版本化的本地验证环境契约。提供一个只用于测试的 Linux runner/开发容器配置，固定 Node 22.23.1、仓库锁定的 pnpm、所需 GNU 工具和 util-linux，配套隔离 PostgreSQL 16。macOS 开发者应能够通过一条明确入口运行与 CI 相同的 `scripts/pr-preflight-task.sh` 子任务。不应让测试容器读取生产凭据、连接生产数据库或挂载 Docker socket；用专属临时数据库/目录，明确清理责任。
2. 在入口执行快速 doctor/preflight：输出操作系统、架构、Node/pnpm 版本、工具可用性及所需参数能力、`/proc` 能力、数据库连通性、浏览器版本；报告名字和布尔状态，不打印 token/连接密码。前置条件不足时返回单一、可识别的 setup failure，而不是继续产生数百条业务失败。
3. 明确区分 `unit:portable`、`integration:linux`、`browser:contract` 等验证 profile，并在报告中写清“未运行”与“通过”。Linux 专属测试可以在原生 macOS profile 中明确 skip，但必须由必经 Linux profile 补齐；不得增加一个全局 skip 让 CI 看起来更绿。
4. 将布局检查改为可直接管理的 Vite 实例。优先考虑 programmatic Vite server 并在 finally `await server.close()`，或者直接用当前 Node 启动已解析的 Vite entry，避免 pnpm 包装层。补上启动失败、浏览器启动失败、断言失败、取消及正常结束的清理路径；若仍有子树，则只清理本次创建并记录归属的进程/进程组，并设置软终止、硬截止和 stdio 关闭策略。不要用全局 `pkill vite` 误杀开发者服务。
5. Linux 环境统一后，按附录的待归因清单定向复跑剩余失败，保存首次根因与环境指纹。先消除前置依赖噪声再讨论真正的产品断言，不能把所有 “other” 项直接 close 成“macOS 原因”。

不要为了本地绿色把 descriptor-relative I/O 改成不等价的普通路径拼接，不要忽略配置锁失败，不要放宽制品安全校验，也不要只延长所有 timeout。那些做法会改变生产正确性或掩盖失败，不能解决验证可复现性。

### 4. 验收与估时

- 在干净 Linux runner 上以同一 SHA、锁文件和标准入口复现 CI 测试集合；输出所运行 profile、发现/执行/跳过数和退出码。macOS 原生 profile 对 Linux 专属能力给出清晰 setup/skip 原因，完整 profile 有可执行的 Linux 路径。
- 人为移除测试容器中的单个依赖，例如 GNU tar 或 flock，doctor 在进入业务测试前指出具体缺项；不能只报告“801 tests failed”。这是后续正常工程验收，不是本次已执行实验。
- 布局脚本正常路径在结果输出后约 5 秒内退出 0；断言失败退出非 0；中断/浏览器失败后不留自有监听端口、后代进程和管道。连续执行三次可以复用系统资源，其他开发进程不受影响。
- 预计：环境契约及入口 2—4 人日；布局生命周期修复与回归 0.5—1.5 人日；剩余失败的首次定向归因另留 1—2 人日，不能预先承诺所有未决项都是环境问题。

## ENG-02：巨型热点有防增长机制，但运维源码与配置契约的治理边界仍不完整

### 1. 现状与已有保护

证据等级 A/B。`inventory.json` 的盘点快照含 5,647 个 tracked files，原始源码统计中有 32 个非测试文件超过 1,000 行。这个“32”不是 ratchet 违规数：其中包含生成代码及不在现有扫描范围内的源文件；不能把生成的 `server/src/dws/generated/commandPolicy.ts` 当成人工维护热点要求拆分。

本次 `ratchets.log` 记录：36 个 ratchet/相关契约测试全部通过；max-lines 检查通过，允许保留的历史超长文件 49 个，其中生产源码 29 个、测试 20 个。`config/max-lines-baseline.txt:1` 已写明：生成/构建产物排除，生产阈值 1,000、测试 800，历史文件只许缩小或移除；`scripts/check-max-lines-ratchet.mjs:97` 阻断新增超限和历史文件继续增长，`:114` 阻断相对 merge-base 的预算膨胀，并支持重命名债务身份。这个渐进治理方向是正确的。

仍值得优先处理的人工维护热点如下。行数来自该基线快照及当前未变文件，不代表函数复杂度、缺陷概率或修改频率的直接测量：

| 文件                                           | 物理行数 | 业务/工程作用           | 当前行数 ratchet        |
| ---------------------------------------------- | -------: | ----------------------- | ----------------------- |
| `server/src/channels/web/channel.ts`           |    4,227 | Web 会话入口与执行编排  | 历史预算覆盖            |
| `server/src/runtime/rawAgentLoop.ts`           |    3,893 | 核心 Agent 运行循环     | 历史预算覆盖            |
| `server/src/routes/sessions.ts`                |    3,306 | 会话路由集合            | 历史预算覆盖            |
| `server/src/app/runtime.ts`                    |    2,989 | 运行时装配              | 历史预算覆盖            |
| `server/src/runtime/rawRuntimeRunDispatch.ts`  |    2,985 | 运行派发                | 历史预算覆盖            |
| `web/src/hooks/useChatAppState.ts`             |    2,707 | Web 聊天状态及副作用    | 历史预算覆盖            |
| `web/src/components/BillingManager/index.tsx`  |    2,256 | 计费管理界面            | 历史预算覆盖            |
| `mobile/src/hooks/useChatAppState.ts`          |    1,819 | Mobile 聊天状态及副作用 | 历史预算覆盖            |
| `scripts/release/migration-plan.mjs`           |    4,585 | 发布迁移计划与校验      | 不在当前 max-lines 范围 |
| `.github/workflows/ci.yml`                     |    3,503 | 测试、构建及部署工作流  | 不在当前 max-lines 范围 |
| `scripts/release/deploy-production-release.sh` |    1,980 | 生产发布生命周期        | 不在当前 max-lines 范围 |

以上热点“较大”是事实；需要拆到哪些边界仍是设计判断，不能仅据行数证明每个文件都违反单一职责。实际风险在于身份、并发、持久化、部署恢复等高约束代码的联动审查成本较高，同时未覆盖形态可以继续增长而不消耗现有行数预算。

### 2. 两种 ratchet 必须分开讨论

`scripts/check-max-lines-ratchet.mjs:16` 只扫描各业务工作区 `src`、Mobile app 和 packages，`:17` 只接受 `.ts/.tsx/.js/.jsx`。因此根 `scripts/`、`server/scripts/`、`.github/workflows/` 以及 `.mjs/.mts/.cjs/.sh/.yml` 等不进入这一机制。这是明确范围，不是当前检查实现随机漏报。

环境变量 ratchet 的覆盖面则更广，不能误写为“scripts 的 mjs 全未覆盖”：

| 维度          | 当前明确覆盖                                                                                                                    | 当前不应假定已覆盖                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| max-lines     | 指定业务源码根目录内的 TS/TSX/JS/JSX，区分生产/测试阈值                                                                         | 发布 mjs、shell、工作流 YAML、server/scripts 等                       |
| env-var-count | `scripts/check-env-var-count.mjs:17` 的七类 domain；包括 `scripts/`、`server/scripts/`、Web scripts；`:28` 包含 mjs/cjs/mts/cts | Mobile 根目录、shell 变量、工作流 YAML 注入、各类动态变量名的实际全集 |
| env 动态访问  | `scripts/check-env-var-count.mjs:67` 报告表达式，本次日志列出 16 条动态表达式记录                                               | 日志明确“reported, not counted”，不能据预算数声称掌握全部运行配置名字 |

本次 env ratchet 通过的 domain 计数为：server 64、ACS 43、Hand 17、shared/runtime 2、Web build-time 3、deployment/scripts 40、packages 19。它们是按域去重的静态变量名，不是整个仓库唯一变量总数，同一名字可能出现在多个域。`scripts/check-env-var-count.mjs:131` 已允许通过相对 merge-base 的新显式 reason 审核扩张；新增配置并非被永久禁止。扩大扫描范围时应延续这个机制，不应把正当功能扩张一律判错。

### 3. 建议实施顺序

1. 先建立“治理范围表”，分别列出业务源码、发布 JS、shell、工作流、生成代码、类型声明和测试。为每类说明 owner、扫描工具、阈值语义及例外理由。扫描覆盖扩大时新增初始基线，而不是把已有巨型发布文件直接变成全仓阻塞。
2. 给人工维护的发布 mjs/mts/cjs 增加独立行数或复杂度预算；shell/YAML 可以使用适配其语法的单独指标，例如 shell 函数规模、工作流内嵌脚本行数、重复阶段、入口参数数量。不要用 TS AST 工具硬解析 shell，也不要用一个不理解语法的通用正则采集所有配置变量。
3. 对 shell/YAML/Mobile 的环境变量制定独立 schema/allowlist 或生成式配置契约，区分 secret、运行配置、仅测试和构建期公开变量。动态访问应在 owner 处关联允许集合/解释，不应尝试把实际秘密值导出进审计报告。
4. 选择一条已有明确边界的热点做小步拆分：例如会话入口将纯请求归一化、权限判定与副作用执行分离；Agent loop 抽取独立状态转换；发布计划把 schema/纯计划推导/外部状态读取分层；工作流提取可本地执行且有参数契约的阶段。优先维护可观测状态、输入输出与失败语义，拆文件前后跑同一组行为回归。
5. 每轮只收敛一类责任并下调对应 baseline，保留 API、导出与持久化格式。涉及发布恢复状态的抽取，需要成功、失败、中断、恢复及真实入口的覆盖；仅验证源码包含某个字符串不足以证明拆分等价。不要为了行数把大函数随意切成相互引用的碎片，也不要通过删除注释、压缩行数或挪到未扫描目录“还债”。

### 4. 验收与估时

- 新增范围用独立测试证明：维护型 mjs 增长会命中，生成目录不误伤，shell/YAML 按自己的规则判定；重命名不重置历史债务；减少后要求收紧预算。
- env 扩张必须有新的理由、所属 domain 和作用说明；Mobile/shell/YAML 新增配置不再处于不知是否受管的状态；动态变量只输出名字/来源，不泄漏值。
- 首轮重构前后行为、构建入口、发布状态机测试及受影响集成测试等价；目标模块实际责任减少，基线可下调，而不是仅物理挪行。
- 预计：范围清单与新增预算 1—2 人日；每个热点的特征测试/设计/小步抽取约 2—5 人日。按季度逐个消减，避免在同一 PR 同时重写 Agent loop、会话路由和发布流程。此项不是要求立即停下业务进行大重构。

## ENG-03：覆盖率百分比不等于功能覆盖，部分独立验收已与真实契约脱节

### 1. 覆盖率数字的准确含义

证据等级 A/B。以下采用同 SHA 成功 Linux CI 的 `github-build-check.log:12534` 摘要，不采用失败的 macOS Server 测试计算一个“权威总体覆盖率”：

| 包                       |              Statements |               Branches |              Functions |                  Lines |
| ------------------------ | ----------------------: | ---------------------: | ---------------------: | ---------------------: |
| Server                   |  75.3%（72,535/96,281） | 67.4%（56,712/84,185） | 76.3%（12,386/16,234） | 78.8%（66,359/84,211） |
| Web                      |    80.2%（1,688/2,104） |   72.4%（1,371/1,893） |       85.0%（403/474） |   82.4%（1,446/1,755） |
| Shared                   |   80.0%（8,830/11,041） |  74.3%（8,317/11,198） |   78.5%（1,551/1,977） |   83.1%（7,691/9,252） |
| 三者已纳入部分的加权汇总 | 75.9%（83,053/109,426） | 68.3%（66,400/97,276） | 76.7%（14,340/18,685） | 79.3%（75,496/95,218） |

这张表不能读成“整个项目 79.3% 功能已测过”，原因不是数学有问题，而是分母有刻意选择：

- `web/vitest.config.ts:48` 先 include TS/TSX，`:58`—`:62` 又排除所有 TSX、components、layouts、hooks 和 types。UI 中即使包含重要状态管理/副作用，也不会进入这个主指标。
- `server/vitest.config.ts:46` 包含 `src/**/*.ts`，排除入口、源码 scripts、迁移和 types（`:53`）；根发布脚本不在其 source root 内。`shared/vitest.config.ts:18` 同样采用自己的范围。
- `scripts/coverage-summary.mjs:119` 已经明确标注“逻辑层覆盖率”，说明 React 组件/hooks、入口、脚本、迁移不纳入主指标。当前实现并未隐藏这些排除项，不能把它描述成造假。
- “Web/lib 纯工具”是简化说明，不是精确路径过滤器：本次 Web summary 有 81 个源文件键，还包括 `web/src/platform/tabScopedAuthStorage.ts`、`web/src/contexts/savedAccountLifecycle.ts` 等非 TSX 文件。准确边界应以 include/exclude 和生成的文件清单为准。
- 本地 Web 为 lines 82.39%、branches 72.37%；成功 Linux CI 的 Web branches 是 1,371/1,893，而本地为 1,370/1,893。一次分支命中的细小差异并不等于阈值回归，也不应混拼两次运行的数据。V8 可执行行数不能直接除以 `inventory.json` 的物理行数得出新的“总体覆盖率”。

被排除 coverage 不等于没有测试。`web/vitest.config.ts:41` 的测试发现仍包含 `.test.tsx`；仓库有 `useAppLifecycle.test.tsx`、`useMessages.test.tsx`、`useChatAppState.queueConsistency.ackLifecycle.test.tsx` 等，且本次 Web Vitest 的 2,591 条断言全过。真正需要补的是：对主指标明确不覆盖的状态转换和交互层，提供可审查的行为证据，而不是以单一百分比替代。

### 2. 确定实例 A：管理后台独立检查仍坚持过期的页面死数

主检查实际运行 `pnpm -F web check:management-contract` 返回 exit 1：`web/scripts/check-management-contract.mjs:62` 用源码正则统计 `surface: 'config', area: 'platform'`，`:64` 固定要求 14，实际 13。

Git 历史给出明确反证：提交 `39707f5b910e28be6617a812921c01941e699f6f`（#556，合并业务系统与组织接入页面）有意删除 `platform-system-deliveries` 导航注册。当前 `web/src/lib/managementNavigation.contract.test.ts:26` 正确要求平台配置 13 项，并且在 `:29`—`:30` 同时检查旧交付入口退出、统一业务系统入口存在。这是现有产品行为与 Vitest 契约已经一起更新，独立脚本仍旧的确定案例；不是产品缺失页面。

风险在于两套“契约事实源”互相矛盾。独立脚本还依赖源码字段顺序/空白布局，合理的格式化和对象构造重写也可能影响计数。`:78` 的固定“47 个真实管理页面”输出同样不应当作运行时产品事实。

该脚本为什么没有让本次 CI 红：`web/package.json:12` 只在普通 Web test 链尾调用它；`scripts/pr-preflight-task.sh:79` 的标准 CI Web 路径直接执行 Vitest，没有执行这些独立脚本。`scripts/pr-preflight-contract.test.mjs:90` 甚至明确保留了“不调用 Web check 脚本”的既有选择。需要认可布局脚本依赖浏览器这一历史设计，但管理契约检查本身只是 Node 读取源码，并不需要浏览器；两者没有必要永久绑在一起。

### 3. 确定实例 B：提供标准 PG URL 不会激活所有 PG 用例

`server/src/__tests__/agentRuntimeProfileStore.pg.test.ts:10` 只读取 `AGENT_PROFILE_TEST_PG_URL`，缺失便在 `:11` 使用 `describe.skip`。标准入口 `scripts/pr-preflight-task.sh:6`—`:8` 要求 `TEST_DATABASE_URL`，只额外映射 `MEMORY_CONSOLIDATION_TEST_PG_URL`；`.github/workflows/ci.yml:172` 的标准分片环境也是这两个 URL。本次检索所审 `.github/`、`scripts/` 与相关入口未发现配置 `AGENT_PROFILE_TEST_PG_URL`。

本地已有隔离 PG 并不意味着这一文件实际执行：JSON 中该文件的 5 条断言全部 skipped。其文件级 `status` 仍是 `passed`，所以只看文件状态会错误报告“79 个 `.pg.test.ts` 全部验证通过”。正确统计是 79 文件被发现、78 文件包含通过断言、1 文件全 skip；451 passed、0 failed、5 skipped。

在发现此缺口后，主检查使用本次专属隔离 PostgreSQL（端口 55438），显式设置 `AGENT_PROFILE_TEST_PG_URL` 做了一次定向补测，结果为 **3 passed、2 failed、0 skipped**，随后已停止该数据库。补测日志/JSON 给出的两个失败是：

- `agentRuntimeProfileStore.pg.test.ts:38`：初始化内置 Profile 的断言预期版本 2，实际是 3。
- `agentRuntimeProfileStore.pg.test.ts:68`：模拟旧版 Profile 后的断言预期 `arpv_builtin_memory_poll_v2`，实际仍为 `arpv_builtin_memory_poll_v1`。

这份新增证据说明默认门禁确实跳过了会失败的现存测试，不能只把问题记成抽象的 coverage 缺口。后续归因已经区分：第一条是当前 memory_poll 已演进到 v3 的旧测试期待；第二条是 seed 只匹配最近前驱 v2，导致未经自定义的 v1 在跨中间版本升级或旧库恢复时无法直接升到 v3，详见 [运行时与数据章 REL-12](./runtime-data.md#rel-12内置-profile-升级只匹配紧邻前版跨版本旧库停留在-v1)。新库和正常 v2→v3 不受影响，生产是否存在适用旧记录尚未核实。不能通过只改两个期望值假装修复，也不能覆盖管理员自定义草稿或旧会话 pinned version。上述定向补测独立于原始全量，原始 **451 passed / 5 skipped** 的 PG 统计不改写、不混算。

本项不宣称这个测试从未被人手动执行。确定问题是标准 PG 环境变量契约不统一、文件级绿可能掩盖关键测试未运行。修复应给测试提供标准 URL fallback 或在测试环境装配其专属 URL，并由标准 profile 检查预期 PG 测试确实执行；不应连接生产库来消除 skip。

### 4. 改善方案：将比例、场景与验收工具分别治理

1. 保留现有逻辑层主指标及清晰排除说明，增加机器可读的范围清单、源文件数、分母和该次运行标识。是否收紧阈值应记录负责人、日期和依据；`web/vitest.config.ts:64` 仍是“两周观测后再谈”的注释，不应让临时观测政策无限期没有决策记录。不要直接对所有 UI 强设 80% 并要求大量低价值快照凑数。
2. 给高风险但被排除的层另建行为矩阵：身份切换/登出/刷新时序、离线→重连、异步旧请求完成、缓存代际、存储失败、乐观更新回滚、路由重挂载与完整 reload。每行记录具体不变量、覆盖它的测试文件/测试名、运行入口、最近结果和缺口 owner。UI 章已确认的问题可逐个转为回归场景，不在本章重复编号和业务修复。
3. 对已有范围内的低覆盖模块按风险排期，而不是只追总体数。本次本地 Web 的 `messageCache.ts` 为 43.69% lines（119 个可执行行），`swUpdate.ts` 47.95%（98 行），`sessionAutomationApi.ts` 46.34%（41 行）；这些只是测试选择线索，不是据此确认实现缺陷。先看故障分支是否影响数据一致性，再决定补测成本；只有 3—6 行的平台适配器也不能凭 0% 自动排成最高优先级。
4. 将管理导航校验收敛到真实导出的 registry/能力不变量。复用现有 `managementNavigation.contract.test.ts` 的 ID 唯一、合法路由、必要能力入口、已退休入口、组织 scope 与 tab 反向识别等断言；确有产品意义的总数可以保留为辅助快照，但不能让源码正则死数成为第二事实源。独立 CLI 可以调用同一校验函数，而不是维护另一份 14/18/5/10。
5. 拆开“无浏览器管理契约”和“浏览器布局验收”的调度，前者进入轻量标准检查；后者在 ENG-01 的可靠启动/退出修复后，明确本地和 CI 哪个 profile 承担，不再仅靠注释说明。保留对单壳、滚动容器、路由可达性的实际渲染/行为测试；字符串出现次数只能作为辅助结构检查。
6. 对 PG 测试、todo、条件 skip 建立有原因和期限的清单。标准 PG profile 明确预期必须执行的测试，数据库不可用应报 setup failure；真正可选的外部集成才允许记录原因后 skip。让 summary 区分“文件发现”“文件含执行断言”“全 skip”，避免 status=passed 的文件标签掩盖空执行。

### 5. 验收与估时

- 报告仍能展示现有逻辑层百分比，但页面/文档无法把它误称为全仓/UI 功能覆盖率；各指标有范围和分母，不混入其他平台失败运行的数字。coverage 分片完整性另按 OPS-05 验收。
- 管理检查在当前有意合并后的 13 个平台配置页面上通过；人为移除必需 ID、增加重复 ID、挂到非法 route 或破坏租户作用域时失败。仅调整属性格式不应引发失败。修改 registry 的 PR 会触发同一套有语义的契约。
- 标准隔离 PG profile 能执行 `agentRuntimeProfileStore.pg.test.ts` 的 5 条断言，两个定向失败分别有契约/版本演进层面的明确归因及回归证据；无法连接时明确失败，不再静默全 skip。其余可选 skip 有名字和理由；不能只是把 describe.skip 改成会连生产的 describe。
- 新增至少一组 UI 时序不变量的回归并通过现有测试入口执行；矩阵注明其余未覆盖项而不虚报完成。总覆盖率可暂不明显上升，因为新增测试可能作用于已排除层，这不代表改善无效。
- 预计：过期管理脚本/共享契约和 PG 入口校正 0.5—1.5 人日；度量范围及 skip 清单 1—2 人日；第一批高风险 UI 时序回归 2—4 人日。后续按具体 UX 修复逐项补齐，而不是把全仓 UI 改造成一次大测试工程。

## 附录：本地 Server 失败记录的保留与后续归因队列

原始 JSON 的 `numTotalTestSuites=2314` 含测试套件层级，不能当成文件数。本文按 `testResults.length=906` 统计文件；按 `assertionResults[].status` 统计 passed/failed/skipped。`server-failure-groups.txt` 是依据错误文本粗分组的工作产物，不是已经完成的根因分析：

| 粗分组     | 文件数 | 失败断言数 | 使用限制                                                            |
| ---------- | -----: | ---------: | ------------------------------------------------------------------- |
| linux-proc |     68 |        555 | 提供强平台线索；不是 68 个相互独立的代码问题                        |
| other      |     44 |        242 | 包含明确的 flock ENOENT 和包裹后的 ENOTSUP，并非 242 个未知业务缺陷 |
| timeout    |      2 |          4 | 包含 Git 命令 exit 128/断言不符，不保证已经确认是超时根因           |
| 合计       |    114 |        801 | 只描述本次失败集合，不构成生产问题清单                              |

“other” 中可直接定位的环境信号包括 `adminConfigMutationService.test.ts` 13 条、`capabilityEnableTransaction.test.ts` 7 条、`systemPromptsAdmin.test.ts` 2 条、`toolControlsAdmin.credentials.test.ts` 8 条出现 flock 缺失；`appRuntimeCoverage.test.ts` 1 条与 `rawAgentLoop.automationGate.test.ts` 5 条首个错误已有包裹的 trusted-file 异常。这里的数量是对应文件的失败断言数，不证明同文件每条失败都已逐一归因为该信号。

以下保留的未决样本值得在受控 Linux 环境下定向对照，不应直接作为待修业务 bug 开工；完整 44 个 other 文件仍以原始分组档案为准：

| 测试文件（Server 内）                               | 本次失败数 | 首个/代表性现象                        | 下一步应核对什么                                                        |
| --------------------------------------------------- | ---------: | -------------------------------------- | ----------------------------------------------------------------------- |
| `src/__tests__/guardrailService.test.ts`            |          1 | 最近真实用户消息得到空数组             | 输入 transcript 的真实读路径是否因平台错误短路，再查消息抽取语义        |
| `src/__tests__/runtimeStoresPureSlices.test.ts`     |          2 | 扫描/回填计数 0，预期 4 或 2           | 真文件 fixture 可读性、目录绑定与 PG fake 的职责边界                    |
| `src/__tests__/mcpConfigStore.test.ts`              |          1 | workspace 同名覆盖后的对象不一致       | 本地配置是否真正读取、默认值和合并层级，不只更新 snapshot               |
| `src/__tests__/tokenUsageRebuild.test.ts`           |          4 | channel 回退 web、用户名回退、桶未合并 | meta 文件读取失败是否导致共同 fallback；不得直接改计费归属              |
| `src/__tests__/memoryConsolidationEngine.test.ts`   |          3 | journal 恢复后文件/模型调用不符        | trusted-file 前置能力、fixture 和恢复时序三者分开验证                   |
| `src/__tests__/clientDaemonRunner.test.ts`          |          1 | reporter 只给出 `STACK_TRACE_ERROR`    | 取定向运行完整 stderr/未处理拒绝，当前摘要不足以给根因                  |
| `src/app/configRuntimeRecovery.integration.test.ts` |          1 | reporter 只给出 `STACK_TRACE_ERROR`    | 同上，保留观察/提交阶段日志，不能假定是超时                             |
| `src/taskboard/safeServerGitRunner.test.ts`         |          3 | Git exit 128，预期成功或特定拒绝       | Git 版本、配置隔离、stderr、进程执行约束；粗分组 timeout 不足以确认原因 |
| `src/agent/containerEditHelper.test.ts`             |         10 | 返回 ok:false，预期成功内容            | Helper 所依赖 shell/文件能力是否可用，再检查编辑契约                    |
| `src/taskboard/workspaceCommitMaterializer.test.ts` |         20 | Promise 被 materialization error 拒绝  | 真实 Git、工作区路径和安全文件能力，逐条记录首个失败边界                |

归因顺序应是：固定环境和源码 → 单文件复现 → 保留最早的实际异常与系统依赖 → 对照 Linux 同一用例 → 决定修平台测试入口、fixture，还是业务实现。若统一环境后不再复现，记录具体缺失前置条件并归档；若仍复现，再新建有独立证据的业务问题。不能把当前 CI green 用来忽略这些线索，也不能把 macOS 红色计数包装成已证实的生产事故。
