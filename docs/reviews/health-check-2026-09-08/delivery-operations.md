# 发布、CI 与运维体检

审查基线：2026-09-08，`main` / `a6b6865e`。本分报告依据当前工作区源码、工作流、测试入口和运维文档形成；只新增报告，不修改部署实现，不触发工作流，不连接生产主机或生产数据库。

## 结论与阅读顺序

当前发布体系已经具备较完整的不可变制品、组件身份、迁移审核、Staging 对账、生产互斥及失败收敛机制。2026-09-07 报告 D-01～D-05 的修复都能在当前代码中找到，不能把这些旧问题继续当作未修复缺陷。当前更值得处理的是新增加的 Evidence Writer 分支尚未享有主发布链同等的恢复与测试保障，以及 CI 的“全量”范围仍有遗漏。

本分报告登记 7 项当前发现：1 项发布凭证持久性风险，2 项 Writer 重试/恢复问题，3 项 CI 证据或检查覆盖缺口，1 项 Hand 自有测试未进入门禁。它们不表示线上已经发生对应故障。除 OPS-07 的纯函数规划结果有本次直接执行证据，其余以代码路径及已有测试检查为主，未执行故障注入。

| 编号   | 优先级 | 性质                 | 结论                                                                          | 主要入口                                       |
| ------ | ------ | -------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| OPS-01 | P1     | 数据持久性及恢复风险 | 不可变证据直接写最终文件，部分写入可能永久占住该 SHA                          | `scripts/release/evidence-service.mjs:43`      |
| OPS-02 | P2     | 失败重试缺陷         | Writer 按 SHA 固定安装目录，但重建 tar 摘要不稳定，失败后重试会冲突           | `scripts/release/deploy-evidence-writer.sh:62` |
| OPS-03 | P2     | 恢复及可运维性缺口   | Writer 回退未验证恢复服务，缺少持久阶段记录，服务不可达时自动升级入口也被阻断 | `scripts/release/deploy-evidence-writer.sh:75` |
| OPS-04 | P2     | CI 缺口              | Writer 的真实打包入口 smoke 只在手动部署的“需要升级”分支执行                  | `.github/workflows/deploy-staging.yml:143`     |
| OPS-05 | P2     | 指标完整性缺口       | coverage 可以缺分片仍汇总，下载/合并失败不影响最终门禁，也没有完整性状态      | `.github/workflows/ci.yml:413`                 |
| OPS-06 | P2     | CI 缺口              | ESLint 只在本地提交钩子运行，CI 没有同等检查                                  | `.husky/pre-commit:2`                          |
| OPS-07 | P2     | CI 范围缺口          | Hand 自有 9 个测试文件不在根 test 或 CI 测试矩阵内                            | `scripts/ci-plan.mjs:13`                       |

优先级口径：P1 指应优先解决的权威数据完整性/持续阻塞风险；P2 指有明确触发条件的可靠性与质量保障缺口。这里没有声称存在未授权生产部署入口，也没有把可接受的产品决策自动升级成安全漏洞。

## 已修问题复核及目前仍有效的防线

| 旧问题或防线                           | 当前代码证据                                                                                                                                                                        | 本次判断与边界                                                                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01：旧进程交接必须得到确认           | `scripts/release/deploy-production-release.sh:1497` 的 `hand_off_retired_authority()`；1505～1515 行校验 PID/MainPID、信号返回及 15 秒期限；1522～1526 行要求匹配 PID 的 drain JSON | 已修。1530 行明确失败；`scripts/release/deployment-audit-regressions.test.mjs:76` 实际执行提取的 shell 函数，覆盖缺 PID、PID 不符、信号失败、未确认、确认、退出六类场景。它证明受控函数行为，不等于现场 systemd 演练。 |
| D-02：Staging 重试保留 deployment 绑定 | `scripts/release/staging-deployment-retry.mjs:4`；`.github/workflows/deploy-staging.yml:1074`                                                                                       | 已修。只允许 built/staging_deployed/verified，同 run 重用已登记的 deployment ID；跨 run、跨摘要或已开始晋级会拒绝。OPS-02 针对独立 Writer 安装分支，不是重报 D-02。                                                    |
| D-03：expand 迁移需要真实后置条件      | `.github/workflows/deploy-staging.yml:1196`；`scripts/release/finalize-expand-migration.sh:160`、181；`scripts/pr-preflight-task.sh:104`                                            | 已修。Staging 执行数据库读回，生产主机锁内执行两次读回，PostgreSQL 契约入口存在。历史 migration review 检查通过不能替代实际基线的完整 release plan。                                                                   |
| D-04：失败后必须记录实际版本并阻止验收 | `scripts/release/staging-final-state.mjs:24`、61；`scripts/release/deploy-staging-release.sh:170`；`.github/workflows/deploy-staging.yml:1296`、1341                                | 已修。状态区分 unknown/target_runtime/previous_runtime/mixed_versions；`runtimeConverged` 不冒充最终验收资格。最终 deployment 状态在 SSH 撤权和证据上传后写入。                                                        |
| D-04：最近一次 attempt 决定验收资格    | `scripts/release/assert-staging-acceptance-deployment.mjs:4`；`.github/workflows/staging-acceptance.yml:147`                                                                        | 已修。依据 status 时间及 ID 排序，较新的无状态 deployment 也会阻断；不会从旧 success 推断当前可验收。                                                                                                                  |
| D-05：公网首页与实际 JS/CSS 必须一致   | `scripts/release/verify-public-web.mjs:11`、24；`.github/workflows/deploy-staging.yml:1189`；`.github/workflows/promote-release.yml:910`                                            | 已修。普通 URL 读取首页和全部 JS/CSS，逐字节比对，记录缓存头；真实本地 HTTP 回归在 `deployment-audit-regressions.test.mjs:111`。不证明用户已有 Service Worker 缓存或所有浏览器业务流程。                               |
| APP CI 使用稳定 workflow 身份          | `.github/workflows/deploy-staging.yml:98`、118                                                                                                                                      | 当前 Writer 门禁解析 workflow ID，最终复核 event/main/SHA/completed/success。历史“名称变化导致永远等不到 CI”的根因不应重报。                                                                                           |
| 唯一在线 Staging 槽位                  | `.github/workflows/deploy-staging.yml:18`；`.github/workflows/staging-acceptance.yml:21`                                                                                            | 部署和验收使用同一 concurrency group，避免业务验收中途由这两个入口换版。                                                                                                                                               |
| 汇总 required check                    | `.github/workflows/ci.yml:384`、464；`config/github-main-ruleset.json:30`                                                                                                           | `Build & Check` 明确汇总计划内 jobs；非计划跳过、取消及失败不被误认为成功。此处不能推断远程 ruleset 与本地配置永久一致。                                                                                               |

主代理本次另行读到基线 SHA 的 APP CI `34169355270`、ACS CI `34169355282`、Staging `34169361409`、Promotion `34171082432` 状态均为 success。本分报告未重复查询；这些结果支持最近正常路径能够完成，不能反证下述故障路径缺陷，也不等于生产业务健康证明。

## OPS-01：不可变发布凭证存在部分写入后无法重试的窗口

**定位与证据等级**：`scripts/release/evidence-service.mjs:43`～50，105～116；代码机制明确，故障结果为基于代码及文件 API 语义的分析，本次未制造磁盘满或杀进程。

`writeImmutable()` 先创建目录，然后直接对最终文件名执行 `writeFile(path, content, { flag: 'wx', mode: 0o600 })`。`wx` 的作用是“不覆盖已经存在的文件”，它不把创建与全部内容持久化变成一个事务。Node 官方文档说明 `fsPromises.writeFile()` 内部可能执行多次 write，失败或中止并不保证最终路径没有部分内容；默认也不是每次同步刷盘。[Node.js 22 文件写入文档](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromiseswritefilefile-data-options)

触发链路如下：

1. 已通过 schema 校验的某 SHA 凭证开始写入 `release/<sha>.json`。
2. 最终文件已经建立，写入期间发生 ENOSPC、I/O 错误或进程终止，留下空文件或截断 JSON。
3. 服务重启后，GET 在 116 行读取并解析/校验失败。
4. POST 重试在 47 行得到 EEXIST；49 行发现现有内容不等于完整凭证，继续抛错。
5. 同 SHA 无法靠正常幂等重试恢复；下游证据准备 fail closed，该发布 SHA 持续阻塞，直到执行受控的损坏凭证恢复。

影响范围是发布证据可用性和可靠恢复，不是“坏凭证会被放行”。现有 schema 校验会拒绝损坏内容，因而完整性门禁没有静默失守；问题在于服务把未完成的内容发布到了不可覆盖名称。`staging-isolation`、`production-observation` 也共用此写函数，损坏的最新文件还可能让读取最新证据失败。

`evidence-service.test.mjs:112` 已经覆盖“非法输入不占用 SHA”，但这是写入前验证路径，不能覆盖“合法输入写到一半中断”的路径。

**建议实现**：将“完整写入”和“不可覆盖发布”拆成两个阶段。在同一持久卷创建独占临时文件，写完整并 sync，验证摘要，再用文件系统支持的 create-only 原子发布方式把该 inode 挂到最终名称；例如同一文件系统上使用 hard link 建立最终路径，EEXIST 时只接受完整且相同的已有文件。普通 rename 默认可能覆盖目标，不能直接把 `wx` 改成无条件 rename；需要保留不可覆盖语义。完成后同步父目录，最后清理临时文件。确认实际持久卷支持的语义；若改用事务数据库或对象存储，也应保留条件创建与 canonical readback。

已有损坏文件的恢复需要独立管理入口：首先只读列举并验证，记录 SHA、原文件大小、摘要及失败原因；将确定损坏的文件隔离保留，重新从可信源生成后再发布。不能自动删除“内容不一致”的文件，因为不一致也可能意味着真实的权威冲突。

**验收要求**：

- 对写入前、写入中、完整写后发布前、发布后返回前分别中断；重启后 GET 只出现“不存在”或完整合法文档，不能出现最终路径的部分 JSON。
- 注入 ENOSPC/EIO 后，同一合法 payload 重试可完成；恢复前的损坏文件有可审计隔离记录。
- 两个并发相同 payload 最终同一摘要；两个不同 payload 只有一个成功且已有内容从未被覆盖。
- POST 响应丢失后的重试保持幂等；读写 token 隔离及现有 schema 回归继续通过。
- 在部署所用持久卷类型完成一次隔离环境演练，补足文件系统语义证据。

建议责任域：发布基础设施/后端；可拆为原子写入、小型恢复工具、故障注入三项任务。处理过程中不需要改动生产业务 schema。

## OPS-02：Writer 同 SHA 失败重试可能被不稳定 tar 摘要卡住

**定位与证据等级**：`.github/workflows/deploy-staging.yml:149`～173；`scripts/release/deploy-evidence-writer.sh:16`、62～70、75～107。静态路径明确；本次未执行两轮 Writer 发布。

Writer 的安装键是源码 SHA：`target=$releases/$release_sha`。目标存在时，部署脚本要求目标中的 `.bundle-digest` 必须与本次 tar 摘要完全相同。另一方面，Workflow 每次运行都会创建目录、重新 esbuild 并 `tar -czf`，没有固定 tar 元数据中的修改时间、uid/gid、目录顺序等。至少新生成文件/目录的 mtime 会随着重跑改变，即使业务字节相同也不能保证 tgz 摘要一致。

**明确触发条件**：一次升级已经在 70 行留下不可变 `releases/<sha>`，随后启动或 capability 验证失败并回到旧 Writer。旧 Writer revision 仍落后，所以同 SHA 重跑会再次进入构建与部署；新 tar 摘要不同，在 63 行失败，连恢复后的重试机会都没有。普通成功升级后由于 capability 满足而跳过，此问题不会在每次成功发布中出现。

**根因**：同一身份键混用了“相同源码”和“完全相同压缩包”，同时失败后保留不可变目录却没有复用原始制品的路径。主应用基于已登记 RC/制品的重试机制不能自动覆盖这个独立 Writer 分支。

**影响**：暂时的启动/网络故障会变成需要人工介入的持续发布阻塞。手工删除目录虽然可能让重跑过去，却丢失失败制品证据，还可能误删 current/previous 所引用版本，不应作为默认恢复方案。

**建议实现**：优先把 Writer 构建产物也变成“只构建一次、重试复用”的不可变发布对象，用源码 SHA、构建输入摘要和 bundle digest 共同登记。安装目录可使用内容摘要，源码 SHA 保存在 manifest 中；或者保留按 SHA 目录，但在重试前下载同一已登记 tar。作为补充统一 tar 的排序、固定 mtime、数值 owner/group 和 mode，使相同输入可重现，不要只依赖这一点代替制品复用。

**验收要求**：

- 相同 SHA、锁文件和构建工具版本，在两个不同时间的干净目录打包，输出 digest 相同；若采用复用方案，则重试必须消费原始 digest。
- 第一次在 target 安装后注入启动失败，确认 previous 恢复；第二次同 SHA 可以完整通过。
- 原 target 内容与登记 digest 不一致时必须阻断，并给出目标、期望摘要、实际摘要，保留证据。
- 不通过清理整个 releases 目录解决问题；current、previous、pending 引用的对象必须保护。

## OPS-03：Writer 的恢复声明和持久恢复状态不足

**定位与证据等级**：`scripts/release/deploy-evidence-writer.sh:23`～30、73～110；`.github/workflows/deploy-staging.yml:60`～86；`docs/release-workflow-configuration.md:106`～109。当前代码与文档可直接比对，现场失效未实测。

Writer 升级在两条失败分支中切回 previous 并调用一次 `systemctl restart`，之后输出“restored the previous release”。它没有对旧版本执行 `is-active`、本地 capabilities 或公网读回；对于 `Type=simple` 的 unit，仅 restart 命令返回不等于服务持续就绪。第二次 restart 本身失败时，`set -e` 又会直接退出，最终只剩普通命令错误。

另外，`previous` 只在 shell 变量里，EXIT trap 只删临时路径。进程在切换链接后被中断，或 85 行读 token、110 行写标记失败，都没有通用的“已改变到哪一步、目前指向谁、是否已验证恢复”记录。它和主 Staging 应用部署已经引入的 `recovery-status.json` 能力不对齐。主流程的 D-04 已修，不能据此宣称 Writer 也具备同等恢复保证。

恢复入口还有一个可用性边界：Workflow 一开始必须从公网拿到 HTTP 200 capabilities，才可能决定 `needs_upgrade=true`。Writer 已经停止、代理返回 502、capability 输出损坏时，此 job 会先失败，无法使用后面的 SSH 路径恢复 Writer。这可以是有意的 fail-closed 设计，但必须配套明确的恢复方式，不能把“重跑部署会自动修好 Writer”作为运维承诺。

**影响**：日志可能把“链接已还原”表达成“服务已恢复”，真正恢复失败缺少机器可读状态；负责发版的人很难只凭工作流分辨旧版本可用、新版本仍活动或服务完全不可用。

**建议实现**：

- 与主部署链一致，创建 root-owned、按 attempt 独立的持久状态记录，在 mutation 前保存 previous/target/digest/schema/phase。
- 将恢复实现为独立幂等函数，逐步记录 restore_link、restart、local_readback、public_readback 的结果。仅全部满足才写 `restored`；否则写 `needs_human`，保留日志及安装对象。
- 使用 trap 覆盖可捕获的中断/错误，同时保证下次入口能识别 SIGKILL 或断电遗留的 pending 状态；不能把 trap 当作所有中断的保障。
- 服务不可达时保持发布证据生成关闭，并提供范围严格的 Writer-only 恢复入口或 runbook：核对可信 SHA/原 digest、SSH 固定指纹和持久状态，再决定原版本恢复或精确制品重装。不要把任意 HTTP 错误自动解释成可升级授权。
- capabilities 增加可审计的 Writer 构建身份，区分“schema 兼容”和“实际实现版本”。只按 schema revision 判断升级，会让同 schema 的实现修复缺少显式推广依据；这是后续改进，不是当前所有升级均失败的结论。

**验收要求**：分别注入新版本启动失败、旧版本 restart 失败、旧版本启动后马上退出、capability 不匹配、读 token 失败、切换后 kill；最终记录必须准确。正常恢复检查只读 token，不输出 token 值。公网不可达且本地健康与本地也不健康两类情况，应给出不同诊断与下一步。

## OPS-04：Writer 打包入口修复没有进入合并前真实执行门禁

**定位与证据等级**：`scripts/pr-preflight-task.sh:18`；`scripts/release/evidence-service.test.mjs:6`、30；`scripts/release/staging-workflow.test.mjs:747`；`scripts/release/staging-release-evidence-workflow.test.mjs:82`；`.github/workflows/deploy-staging.yml:143`。CI 入口可静态确认。

近期两次修复处理了真实产物与源码运行方式不同的问题：`evidence-service.mjs:185`～193 通过 realpath 识别 symlink 启动入口；Workflow 构建命令通过 `AGENT_SAAS_EMBEDDED=true` 抑制依赖文件的独立 CLI；最终通过 symlink 路径启动 bundle。

当前保障分为三层：

| 层次              | 当前实际动作                                                                                           | 能证明什么                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| service 单元测试  | import `createEvidenceService()` 后在本地监听 HTTP                                                     | 端点业务逻辑与鉴权/schema 验证                   |
| workflow 契约测试 | 正则匹配 define、symlink 路径、日志文字、依赖 CLI 防护                                                 | 关键文字仍存在；不能证明产物真的能启动           |
| 部署时真实 smoke  | `.github/workflows/deploy-staging.yml:150` 实际 esbuild，159～171 行从 symlink 启动 2 秒并检查监听日志 | 这次需要升级的部署所生成的 bundle 能进入监听状态 |

问题是第三层只在手动 Staging 部署且 `needs_upgrade=true` 时执行。APP CI 即使全绿，也不会构建并启动该 bundle。引入入口导出、新的带 CLI 副作用依赖、打包参数或 symlink 路径变化时，正则和 import 单元测试可能一起通过，错误要到真正升级 Writer 时才暴露。

**建议实现**：抽取唯一 Writer 构建与 smoke 脚本，APP CI `preflight_checks` 和发布打包共同调用。最小测试直接使用实际 esbuild 输出、实际启动入口和临时凭证；监听就绪后做认证 GET `/capabilities`，再执行一组合法凭证 POST/GET，最后干净终止进程。不要单纯以 `timeout` 返回 124 和固定日志替代协议读回。

**验收要求**：

- 普通 PR 和 main push 都执行该测试，且不需要云端 secrets 或外部服务。
- direct path 与 symlink path 都通过；依赖的独立 CLI 不得执行。
- 在隔离测试中移除 realpath 处理、移除 embedded define 或导入一个带错误入口副作用的 fixture，门禁应失败。
- 绑定到生产使用的同一构建参数，禁止 CI 自己维护第二套“近似构建”。

这项修复风险较低，适合先做，为 OPS-01～03 的后续实现提供真实入口回归。

## OPS-05：覆盖率缺分片时仍可能展示为完整统计

**定位与证据等级**：`.github/workflows/ci.yml:183`～195、413～444、464～503；`scripts/ci-plan.mjs:15`；`scripts/coverage-summary.mjs:90`～134。代码行为明确，未制造 GitHub artifact 故障。

全量计划规定 shared 1 片、server 4 片、web 2 片。每片测试产生 blob，但上传允许失败；汇总下载也允许失败。合并只检查某工作区的目录是否非空，没有验证每个预期 shard 是否恰好出现一次。例如 server 第 4 片测试成功而 blob 上传失败，仍可用剩下 3 个 blob 合并。生成的 summary 只知道工作区的 summary 文件是否存在，不知道其输入缺片。

如果没有任何 blob，合并会打印 error 并退出，但该步骤仍 `continue-on-error: true`；最终 `Build & Check` 只汇总 ci_plan/preflight/tests/PG/Web/Mobile jobs，不把 coverage 完整性计入状态。仓库已有注释解释了配额紧张、artifact 上传不判红的历史决策。因此应明确：**当前测试通过门禁仍存在；缺口是覆盖率统计不能证明完整，不是测试失败会被覆盖率步骤掩盖。**

**影响**：覆盖率可能断档或以不完整输入计算，却没有显著的 incomplete 标识，削弱趋势比较、差异评审及本次体检之后持续追踪的可信度。现有配置也未建立 coverage threshold；这是当前策略，而不是脚本实际实现了阈值却未生效。

**建议实现**：由 ci_plan 同时输出预期 blob manifest，记录 workspace/shard/total/source SHA/run ID/attempt；汇总逐项校验数量、身份和唯一性。缺片时不生成可与完整数据混用的总体百分比，明确输出 `incomplete` 与缺失片列表。是否把完整 coverage 设为 required gate 可以另行决定；最小改动应先保证“可选上传”和“可信指标”之间的边界。

**验收要求**：正常 7 片完整；缺任一片、重复片、其他 SHA 或其他 attempt 的片全部标记不完整；summary 不给出正常 total。若选用硬门禁，故意缺片必须使 required check 失败；若维持观察指标，则明确记录质量状态并为连续缺失设告警/待办阈值。

## OPS-06：ESLint 只在本地提交钩子执行，CI 没有守住规则

**定位与证据等级**：`.husky/pre-commit:2`；`package.json:72` 起的 lint-staged 配置；`scripts/pr-preflight-task.sh:13`～26；`.github/workflows/ci.yml:113`；`.github/workflows/ci.yml:320` 只有 Mobile 专项 lint。代码范围确认，主代理本次独立执行了全仓 ESLint。

`lint-staged` 对本地暂存 JS/TS 调用 eslint，但当前 APP CI 的静态检查仅运行 ratchet、package tests/build、release contracts、runtime dependencies、server typecheck/build 等，没有执行 ESLint。scenarios lint 和 Mobile Maestro lint 是特定业务契约，不是 TypeScript/React ESLint 的替代。

可触发方式并不要求恶意行为：开发者通过不安装 hooks 的工作区、GitHub 网页编辑、自动化提交或跳过钩子提交，规则就不会运行。TypeScript 编译通过不会发现所有 React hooks 闭包/依赖问题。

主代理本次的独立结果：扫描 4,378 个文件，error 0、warning 1,898。非测试 warning 369，其中 `any` 245、hooks 123、unused disable 1；测试 warning 1,529，其中 `any` 1,528、unused disable 1。**这些 warning 不是 1,898 个已确认 bug**，应按规则和调用上下文逐条裁定，尤其 hooks 警告既可能是陈旧闭包风险，也可能是需要明确设计说明的稳定引用。

**建议实现**：先增加统一 `lint:check` 入口，在 CI 静态 job 调用，与本地使用同一 ESLint 配置。第一阶段让 error 成为硬门禁；warning 建立分类基线和只增不减的 ratchet，重点处理业务代码 hooks。不要一次性把全部历史 warnings 设为 `--max-warnings=0`，那会把补门禁变成大范围历史重构。测试中的 `any` 和产品逻辑中的 hooks 应分开治理。

**验收要求**：不依赖 Husky，直接 CI 入口仍能阻断一个真实 ESLint error；新 warnings 超出分类基线时有明确差异；生产 hooks 修复需以对应交互行为验收，不能机械补 dependency array 引入无限刷新或副作用重复执行。

## OPS-07：Hand 自有测试未进入根测试命令和 CI

**定位与证据等级**：`hand-server/package.json:10`；`pnpm-workspace.yaml:6`；`package.json:24`；`scripts/ci-plan.mjs:13`、63；`scripts/pr-preflight-task.sh:15`～17、48；`.github/workflows/acs-sandbox.yml:97`～110。本次已直接执行 CI 规划纯函数，结论可复现。

`hand-server` 是正式 workspace，自己提供 `test = pnpm run typecheck && vitest run`，当前有 9 个测试文件：workspaceResolver、handlers.durability、config、handlers.health、handlers.cancellation、invocationStore、handlers.env、handlers.provisioning、handlers.correlation。它们涉及取消 tombstone、持久调用结果、重启恢复、工作区映射及环境注入等行为。

根 `pnpm test` 只选 server/shared/web/mobile。APP CI 测试工作区列表也是 shared/server/web；Mobile 独立运行，packages/* 有专门 tests，ACS 有自己的测试入口，均未调用 `pnpm -F hand-server test`。将未映射路径回退成 full 也无济于事，因为 full 仍只包含那三个工作区。

本次只读执行结果：

```text
planCi(['hand-server/src/handlers.ts'], 'pull_request')
mode=full
reason=hand-server/src/handlers.ts is not mapped to a workspace
tests={shared:full,server:full,web:full}
matrix=shared 1/1; server 1/4,2/4,3/4,4/4; web 1/2,2/2
```

这不是“Hand 完全没有被其他测试碰到”：`acs-orchestrator/src/invocationCorrelation.integration.test.ts:10`～11 导入 Hand 的 request parser/store，部分协议路径有交叉覆盖。但它不能替代上面的 9 文件 suite，也无法证明一项只导致 Hand 自有测试失败的变更一定被 required check 拦截。

**影响**：开发者运行名为“test”或“full”的入口，会误以为覆盖全部 workspace；Hand 自有持久化、取消、环境与 provisioning 回归可以悄悄退出日常门禁。该 workspace 在 `docker-compose.yml:111` 仍有独立服务与镜像 target，并非仅凭目录名认定应测试的废弃代码。

**建议实现**：先把 `hand-server test` 放进静态检查或独立 required job，并将结果接入 `Build & Check`。随后统一“可执行测试 workspace 清单”，对 workspace manifest 中存在 test script 的包要求显式登记为测试入口或有说明的排除项。根 test 也应覆盖 Hand，并明确 ACS/packages 的入口关系，避免多个地方各自维护不一致清单。

**验收要求**：

- 只修改 hand-server 源码或测试时，PR plan 必须明确安排 Hand suite；main push 也运行。
- 在隔离分支给 Hand 自有测试加入必失败断言，required check 必须失败；不能靠 server/ACS 偶然 import 发现。
- Hand 依赖的 server/shared 协议变化能触发对应 Hand 回归，至少先采用保守全跑策略。
- 记录实际执行测试数，不把 `--passWithNoTests` 下的空运行当作覆盖证明。

## 尚需运维证据的事项，不计作已确认生产缺陷

现有文档对能力和事实的区分总体诚实。`docs/runtime-eventstore-retention-runbook.md:3` 明确说明仓库不包含生产容量、备份/PITR 或恢复成功事实；31～32 行要求取得备份策略与隔离恢复演练后才允许清理。`docs/azeroth-pg-setup.md:166` 也保留了相同证据缺口。不能因仓库没有备份脚本就断言云数据库没有备份。

后续建议建立一份受控的运行证据索引，至少包括：

| 待取证项                     | 需要的真实证据                                                                                           | 证据通过前的判断                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| PG 备份/PITR                 | 覆盖实际 database 的策略、最近成功任务、可恢复窗口、隔离实例恢复后的行数/水位/会话抽检、RPO/RTO          | 未验证；保留现有删除门禁                           |
| NAS/工作区及凭证服务数据恢复 | 持久卷快照/备份范围、恢复角色、最近一次隔离恢复结果，明确是否包含 `/var/lib/agent-saas-release-evidence` | 未验证；不能用代码回滚替代用户文件和凭证恢复       |
| Writer-only 恢复             | OPS-03 的持久状态、精确制品、失败恢复演练                                                                | 当前源码有缺口；正常部署成功不能覆盖此项           |
| 主发布故障演练               | Staging 的旧进程交接、主机/SSH 中断、混合版本、回退失败、同 RC 重试完整记录                              | 旧 D-01～05 代码已修；现场演练与业务验收需额外证据 |
| 独立业务可用性               | 用户登录、流式问答、工具执行、取消/审批/恢复、文件访问的实际业务探测与告警响应记录                       | workflow success 不能替代                          |
| 云权限和分支保护漂移         | 当前 ruleset、Environment 权限/审批、RAM/SSH 授权、临时安全组撤权的实际配置与记录                        | 本地配置是期望状态，不是永久的云端事实             |

浏览器与 Agent 验收本来就被设计成可选的独立 Workflow（`.github/workflows/staging-acceptance.yml:29`、197）。这不是遗漏的“自动生产部署门禁”；是否把其中某些关键路径提升为强制发布前验收，需要依据成本、稳定性及业务风险另外决定。

## 后续修复建议批次

1. **先补可观测的 CI 覆盖**：OPS-04、OPS-07、OPS-06 可以独立小 PR 完成，分别验证真正的产物入口、Hand suite 与 lint，不触碰生产运行逻辑。
2. **再修 Writer 持久化和恢复**：OPS-01、OPS-02、OPS-03 共享故障模型，但宜保留三个独立验收目标；先在隔离本地/容器环境稳定复现，再到 Staging 演练。
3. **保证质量数据可信**：OPS-05 补分片清单和 incomplete 状态，再决定覆盖率是否做硬门禁。
4. **补运行事实**：汇集既有备份、恢复、告警及发布演练记录；不存在的记录才转成运维任务，避免把“未查”当成“未做”。

本次没有在工作区写入临时业务代码或故障注入脚本。全量 release tests、类型检查、coverage、依赖审计和 ESLint 由主代理统一执行，本分报告不重复消耗对应测试资源。报告中的验收步骤均是后续修复完成时应新增或执行的要求，不能当成本次已经完成的验证。
