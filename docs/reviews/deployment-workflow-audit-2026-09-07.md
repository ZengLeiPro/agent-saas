# 测试环境部署与生产环境发布审查

审查日期：2026-09-07（北京时间）。基线：`03237fdcfbf9495c5fc091b583a0dab6a37b86e2`，工作区 `/Users/kaiyan001/code/agent-saas-hand-repair`。本文所有代码行号均对应该基线；不包含并行进行的 Hand 兼容修复。

本次发现 **3 项 P1、2 项 P2，未发现能够证实的 P0**。最应先处理的是：旧进程未收到交接信号仍可报告发布成功、Staging 成功或接近成功后的重跑不能更新验收部署绑定、迁移完成凭证没有核验本次迁移的数据库后置条件。

本次只读取代码、GitHub 运行记录、部署状态和已存在的运行产物，并执行本地无云端副作用的测试。没有触发工作流、连接云主机执行命令、执行数据库操作或发布；只新增本文档。

## 1. 范围和线上证据

主入口为 `.github/workflows/deploy-staging.yml`、`.github/workflows/promote-release.yml`。关联审查覆盖 `staging-acceptance.yml`、`scripts/release/` 中的产物验证、分阶段部署、配置身份、迁移确认、回执/重试、锁和回滚，以及 `scripts/staging/` 的隔离、夹具与发布检查；为确认门禁含义，也追踪了 `server/src/index.ts`、`server/src/routes/health.ts`、部分启动初始化路径和 systemd 模板。

已只读核验的实际生产发布：[run 34060310070](https://github.com/ZengLeiPro/agent-saas/actions/runs/34060310070)。

| 项目             | 实际记录                                                                  |
| ---------------- | ------------------------------------------------------------------------- |
| 触发代码         | `03237fdcfbf9495c5fc091b583a0dab6a37b86e2`                                |
| RC               | `rc-20260906-75`                                                          |
| 工作流结论       | `completed / success`，所有执行的部署及收尾步骤成功                       |
| 创建至完成       | 2026-09-07 05:11:45–05:24:54 北京时间                                     |
| Manifest digest  | `sha256:f472e6026358c3addee74cd54d4e3e5eb7d1ff7c6418aa728d68d79663688744` |
| 对账结果         | `all components match the Manifest target with confirmed ConfigIdentity`  |
| 迁移状态         | `awaiting_expand_confirmation` → `completed`                              |
| Staging 证据引用 | run `34058265040`、deployment `6297960303`                                |
| 生产 artifact    | `production-promotion-rc-20260906-75-1`，artifact ID `9997448568`         |

这能证明该次流水线规定的组件身份和配置身份检查完成，不能证明全部用户任务可正常运行。本次 Hand 事故已经说明：release identity、进程 readiness 和业务路由可用性存在不同的验证范围。

## 2. 问题清单

| 编号 | 级别 | 问题                                                                     | 证据强度                                        |
| ---- | ---- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| D-01 | P1   | 旧 generation 的 drain 信号失败仍返回成功，没有进程进入 drain 的确认     | 真实函数本地隔离复现，结合运行时代码            |
| D-02 | P1   | Staging 重跑创建新 deployment，但 verified 历史仍绑定旧 deployment       | 完整控制流；GitHub 官方状态语义；未实际触发重跑 |
| D-03 | P1   | expand 完成凭证只证明运行版本收敛，没有证明本次迁移已在数据库生效        | 验证函数、通过的单测、线上凭证及可降级启动路径  |
| D-04 | P2   | Staging 后端和 Web 分开提交，后续步骤失败没有整套运行版本恢复或对账      | 完整控制流；未执行故障注入                      |
| D-05 | P2   | Web 验证主要覆盖 OSS 字节和身份文件，未验证公网实际 HTML/JS 属于目标产物 | 两条工作流及在线观察器代码                      |

### D-01 / P1：旧进程未收到 drain 信号，发布仍可成功

**位置**

- `scripts/release/deploy-production-release.sh:1497–1513`：`hand_off_retired_authority()`。
- 同文件 `1934–1954`：先提交新 authority，再交接旧 Worker/API，随后只检查新实例并结束。
- `daemon-packaging/systemd/agent-saas-runtime-worker@.service.template:30–35`，以及 API 模板 `44–46`：drain marker 用于 `ExecCondition`。
- `server/src/index.ts:143–157,469–505`：marker 由进程写出；进入 drain、关闭新连接和请求安全交接发生在 `SIGUSR2` handler 中。
- `scripts/release/read-live-production-components.mjs:201–212`：最终观察器按 active-color 选择当前 API/Worker，不确认旧 generation 已进入 drain。

**触发条件和后果**

旧 unit 仍为 active，但 pidfile 丢失、内容不正确，或 `kill -USR2` 失败。函数已经写 marker、尝试 disable，最后却只输出 WARN 并返回 0。`systemctl disable` 不会停止正在运行的进程；`ExecCondition` 只阻止下一次启动。当前 Node 进程没有读取该 marker 后自行进入 drain 的对应逻辑。

因此，“旧进程已停止接新工作并请求安全交接”未经证明，流水线仍可能最终 `completed`。旧进程可能继续维持已有连接、任务 lease 或后台工作；下一次发布也可能因 idle 槽位一直占用而失败。是否重复领取任务取决于各子系统的租约/领导者保护，本次没有证明发生重复执行，不能把它直接写成“必然双跑”。

**本地复现**

从源文件提取真实 `hand_off_retired_authority()`，只在临时目录创建 marker/pidfile，并用 shell 函数替换 `systemctl` 和 `kill`：让 unit 一直 active，分别令 pidfile 为空、令 `kill` 返回 1。两种输入都输出 signal/pidfile 告警，退出码均为 **0**。没有向真实进程发信号。

现有 `deploy-app-handoff.test.mjs` 主要检查“不等待旧进程退出、marker + disable + SIGUSR2”等文本结构，没有覆盖投递失败应如何影响最终发布结论。

**建议**

保持旧 run 后台安全排空的设计，但增加短时、独立于完整排空期限的“已进入 drain”确认：按 systemd MainPID 校验 pidfile，信号只发送给确认的主进程；等待该 PID 写出带身份的 drain ack，或明确读取旧进程的 drain 状态。投递/ack 失败后保留已提交的新 authority，记录 `needs_human` 和旧 unit/PID 证据，不能把未确认的交接计为成功，也不应为修复此问题强杀在途 run。

**验收**：PID 缺失、PID 不一致、信号失败、进程未处理信号四种情形均无法得到发布完成凭证；正常情况下只等待进入 drain，不等待长任务全部结束。

### D-02 / P1：Staging 重跑成功仍可能无法晋级

**位置**

- `.github/workflows/deploy-staging.yml:534–543`：同一 run 的重跑复用 RC ID。
- 同文件 `595–626`：恢复该 RC 已有的最新 attestation。
- 同文件 `825–837`：每次执行都创建新的 Staging deployment。
- 同文件 `997–1019`：只有 `current=built` 才写 `staging_deployed` 并记录 deployment ID；`current=verified` 时完全复用旧证据。
- 同文件 `1028–1052`：写完 verified 后还可能在 SSH 回收阶段失败，并把本次 deployment 标为 failure。
- `.github/workflows/promote-release.yml:167–171,198–206`：读取历史 `staging_deployed` 中的 deployment ID，并强制其最新状态为 success。

**触发路径 A：首次已经成功后重跑**

1. 第一次生成 `staging_deployed(deployment=A)` 和 `verified`，A 状态为 success。
2. 同一 run 重跑，复用 verified 历史，但又创建 deployment B。
3. B 部署和全部校验成功；由于 `current=verified`，不会产生指向 B 的新部署证明。
4. B 发布成功状态时未设置 `auto_inactive=false`。GitHub 默认会把同环境中符合条件的先前成功部署标为 inactive；当前仓库 Staging deployment 的确是 `transient_environment=false`、`production_environment=false`。[GitHub 官方部署状态文档](https://docs.github.com/en/rest/deployments/statuses#create-a-deployment-status)
5. 生产门禁仍查 A 的最新状态，`inactive != success`，拒绝晋级。

**触发路径 B：首次在写完 verified 后失败**

如果 verified 已上传，但后面的 SSH 授权撤销失败，A 会被标为 failure。成功重跑 B 同样不更新绑定，因此即使不考虑 `auto_inactive`，生产仍固定检查失败的 A，无法靠重跑修复。

**证据边界**

这是代码控制流与外部 API 合同共同确定的缺陷；本次没有为了复现而创建 deployment 或触发工作流。实际 RC75 的首次 deployment `6297826120` 失败、后续 `6297960303` 成功，最终 attestation 正确绑定后者；它说明“built 阶段失败再重跑”能工作，**不能反证上述在 staging_deployed/verified 之后失败的分支**。

**建议**

将“构建/RC 身份”与“Staging 部署 attempt 证明”分开记录。每次部署都追加不可变 attempt 记录，绑定 `runId + runAttempt + deploymentId + manifestDigest`；晋级选择该 RC 最新完整成功的 attempt。保留原历史，不修改旧快照。另一种受限实现是同一 RC 的部署重跑复用原 deployment，但必须明确失败/成功状态的更新规则。仅关闭 `auto_inactive` 不足以修复路径 B。

**验收**：覆盖 built、staging_deployed、verified 三个时点后的失败与重跑，尤其 verified 已持久化而 SSH cleanup 失败；最终生产门禁必须引用实际恢复成功的 attempt。

### D-03 / P1：迁移“完成”未绑定数据库后置条件

**位置**

- `scripts/release/confirm-expand-migration.mjs:74–123`：核对计划摘要、版本身份、组件矩阵和时间，直接返回 `status: completed`。
- `scripts/release/finalize-expand-migration.sh:148–180`：两次调用在线组件观察器和 HTTP readiness 后执行确认，没有数据库 schema/迁移记录读取。
- `scripts/staging/ensure-integration-fixture.mjs:17–37,128–137`：`migrationReadback` 只覆盖固定的三个 Taskboard 表和取消状态夹具。
- `.github/workflows/deploy-staging.yml:935–951,999–1005`：把上述检查计入整体 `migration-readback`。
- `server/src/routes/health.ts:128–189`：readiness 聚合运行准入、配置身份、安全证明和 Integration v3 状态，没有本次 Manifest 迁移清单的逐项执行结果。
- `server/src/app/runtime.ts:780–844`：例如 Connector Dictionary、DWS/飞书连接与授权 store 的初始化失败会捕获并降级，应用继续启动。

**触发条件和后果**

某次 expand 涉及的初始化受权限、锁、历史数据或特性开关影响，未执行成功；对应模块允许降级，或者是当前 readiness 不覆盖的模块。只要 API/Worker/ACS 版本和配置收敛，确认器仍可给该 migration plan 写入完成凭证。Staging 的固定三表夹具也不能证明其他模块的列、索引、约束、回填已经生效。

“源码中计划为 expand”“部署的代码包含该计划”和“目标数据库已经满足计划后置条件”是三种事实。当前凭证只证明前两者及应用总体 readiness。可能后果是发布记录显示 completed，但某个连接/字典功能降级，或后续代码首次使用新 schema 时才报错。

**证据**

现有 `confirm-expand-migration.test.mjs:74–109` 的成功 fixture 中，`apiReady` 只有 `status` 和 release 身份，`live` 只有组件矩阵，完全没有数据库迁移执行证据；本次该测试通过。

实际 RC75 下载得到的两个 migration confirmation 文件也只有 release/plan/baseline/target digest 和观察时间等字段，没有 schema 版本或逐项数据库断言。两次 `liveObservedAt` 分别为 `2026-09-06T21:22:51.116Z`、`21:23:29.989Z`。本次没有查询生产数据库，**未证明 RC75 实际漏执行任何迁移**；这里证明的是完成门禁无法排除此类失败。

**建议**

为每项 expand 定义只读、可重放的数据库后置条件，并将其摘要绑定到 migration plan。确认阶段读取实际数据库/租户范围、迁移 ledger、必要的列/索引/约束状态及回填统计，逐项通过后写 completed。允许降级启动的业务模块，若属于本次迁移范围，应进入发布专用阻断检查。Staging 也按本次计划生成检查集合，不再用固定 Taskboard 三表代表全部迁移。

**验收**：模拟其中一项迁移缺失、列定义错误、索引未 ready、初始化失败被捕获四类情形，即使总体 readiness=ok，也不得产生 migration completed 凭证。

**与持续观察的区别**：仓库 `promotion-workflow.test.mjs:584–587` 明确约束生产发布不运行旧的 15 分钟 `observe-production.mjs`。这是现有产品选择，本文没有把“未跑 15 分钟观察”单独当作实现 bug；补上实际迁移结果核验不依赖恢复该旧流程。

### D-04 / P2：Staging 部分切换后缺少整套版本对账和恢复

**位置**

- `scripts/release/deploy-staging-release.sh:664–667`：后端检查通过即设置 `deployment_committed=true` 并结束 SSH 脚本。
- `.github/workflows/deploy-staging.yml:881–933`：后端部署和 Web 发布是两个独立步骤。
- 同文件 `909–917`：先上传其他资源、再 identity、最后 index，均为直接覆盖，没有旧 Web 入口备份或错误 trap。
- 同文件 `935–1052`：后续夹具/隔离检查失败只影响证据和 GitHub deployment 状态，没有组件矩阵 readback 或整套版本补偿。
- `scripts/release/deploy-staging-release.sh:130–184`：脚本内部回滚为 best effort，systemd 恢复失败被吞掉，也没有旧版 readiness 确认。

**触发条件和后果**

后端已经提交新 RC 后，Web 上传失败；或新 identity 上传成功而 index 失败。此时后端保持新 RC，Web 可能仍为旧入口或部分更新，工作流只能报告 failure。原 SSH 进程已经结束，其内部 rollback 不会因后续步骤失败再触发。后续 API/Agent 验收容易在混合版本上运行，直到另一次完整部署恢复；如果恢复脚本自身失败，也缺少明确的恢复结论。

生产流程已经有 Web 入口备份和逐组件对账，因此该问题主要影响测试环境稳定性和验收可信度，评为 P2。代码证明失败分支存在，本次没有线上制造中断。

**建议**

Staging 同样持久化部署前组件矩阵和 Web 入口备份，增加始终执行的最终 readback：明确报告“旧版全部恢复 / 新版全部收敛 / 混合版本待处理”。在后续校验失败时按明确策略恢复入口及运行版本，或者保留新版本并显式阻止业务验收。内部 rollback 应记录恢复错误并检查旧版 readiness，不能只重启后假定恢复成功。

**验收**：分别在后端提交后、Web identity 上传后、index 上传前、隔离证据发布时注入失败，最终证据准确指出实际组件版本；回滚失败必须可见。

### D-05 / P2：公网 Web 字节不属于强制部署门禁

**位置**

- `.github/workflows/deploy-staging.yml:918–933`：逐文件比较 OSS 下载字节，公网只执行主页 HTTP 成功检查，内容丢弃。
- `.github/workflows/promote-release.yml:888–908`：逐文件比较 OSS 字节，公网只检查 `release-identity.json` 中的 webDigest。
- `scripts/release/read-live-production-components.mjs:219–222`：Web 观察仅请求 identity JSON。
- `.github/workflows/staging-acceptance.yml:189–195` 和 `.github/workflows/promote-release.yml:1172–1175`：浏览器验收为单独、可选流程。

**触发条件和后果**

OSS 目标字节正确、identity 路径也返回新版本，但 CDN/反代缓存规则、域名回源规则或 Service Worker 让实际用户拿到旧 `index.html`、错误 JS、或不匹配的入口。当前强制门禁可能通过，因为它没有将公网 HTML 引用的哈希资源与本次产物逐一绑定。

身份文件正确不等于浏览器执行了对应 Web 代码。该问题是可确定的覆盖缺口，本次未抓取浏览器缓存或复现当前线上回源异常，不能声称 RC75 的页面有此问题。

**建议**

发布后经真实域名读取 HTML，比较其规范化内容/摘要或目标 script/link 清单，并读取至少所有入口 JS/CSS 的公网字节与选定包比对。记录响应的缓存标头及目标 release。仍可保持完整浏览器/模型验收为可选，但增加无业务写入、无模型成本的页面加载 smoke，检查入口成功加载且运行版本一致。

**验收**：用独立测试服务器返回“新 identity + 旧 HTML”“新 HTML + 旧/缺失 JS”两种响应，必须阻断；全套目标字节才通过。

## 3. 已检查、未发现新增问题的机制

下表表示本次在相应范围内未发现可证实的新缺陷，不表示对生产环境作出全量安全认证。

| 检查项                 | 结论与代码依据                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 人工触发和参数注入     | 两条主流程仅 `workflow_dispatch` 且限制 main；release ID 先验证，再通过环境变量使用。生产 reason 通过 `jq --arg` 组装，而非直接拼入 shell。见 `promote-release.yml:39,52–61,207–214`。                                                               |
| 同一 SHA 的 CI/PR 证据 | Staging 校验同一 main push SHA 的 CI workflow ID、结论和已合并 PR；并检查 SHA 属于可信 main 历史。见 `deploy-staging.yml:116–228`。                                                                                                                  |
| 不可变 RC 和产物       | Manifest、annotated tag 的 commit/digest、GitHub/OSS record、artifact index 以及精确 ACR image digest 均有相互绑定；不在生产重新构建业务 bundle。见 `promote-release.yml:85–113,280–379`。                                                           |
| 分阶段生产基线         | ACS → App → Web 顺序，每个阶段在主机锁内重建在线前缀；不只依赖 GitHub 开始时读到的旧基线。见 `deploy-production-release.sh:405–445`、`verify-promotion-phase-state.mjs`。                                                                            |
| 配置身份并发           | API/Worker 私有快照、shared expected config identity、governance fence 和统一 active-color generation 提交均存在；配置不一致会阻断，不能用匿名健康摘要替代。见 `deploy-production-release.sh:481–548,1924–1950`。                                    |
| 产物解压和安装身份     | 选定压缩包、Runtime dependency identity、成员路径及安装后 seal/readback 有独立校验。`verify-artifact.test.mjs` 和 phase-state 回归本次通过；GNU tar 相关限制见下文。                                                                                 |
| 生产失败状态           | 变更前持久化 promoting；开始/成功回执分开；缺对账或回执走 needs_human；已提交分阶段状态以精确前缀恢复，未简单重置为旧基线。见 `promote-release.yml:381–409,490–644,1076–1195`。                                                                      |
| 生产 Web 回滚          | 同时备份/恢复 index 与 identity，恢复后字节 readback；失锁时拒绝无锁回滚。见 `promote-release.yml:753–777,821–876`。这并不等价于自动回滚全部已提交后端阶段。                                                                                         |
| 迁移分类               | 源码计划使用生产启动 root、依赖闭包、精确文件 digest 审核；主流程仅允许 none/expand，contract 不走普通晋级。没有把计划分析漏覆盖 runtime schemas 当成发现；其显式 root 包括 `runStoreSchema.ts`、`handStore.ts` 等。见 `migration-plan.mjs:34–121`。 |
| Staging 验收版本稳定   | Acceptance 与 Deploy 共用 `staging-runtime`，验收前、紧邻执行前、结束后均检查 Manifest/组件身份；不是只在一开始检查版本。见 `staging-acceptance.yml:19–22,146–187,220–245`。                                                                         |
| 隔离证据检查           | 七类反向隔离探针验证时间和 evidence digest；OSS 必须是明确的 403/AccessDenied，NAS 的共享文件系统残余风险有明确标签。见 `scripts/staging/assert-isolation.mjs:5–20,91–121`。本次没有重新执行这些云端探针。                                           |

## 4. 凭据、审批和验收的实际边界

**生产审批。** 本次只读 GitHub `environments/production` 返回的保护规则只有 `branch_policy`；没有 `required_reviewers` 或 wait timer。因此当前“人工批准”的具体机制是有权限的人手动触发并填写 reason，工作流随后记录 `approved`，不是另一个独立审核人点击 Environment approval。`promote-release.yml:136–138,155` 中“受保护环境审核”的注释不能作为存在二人审批的证据。本次没有修改环境设置；项目没有明确要求二人审批，故未将其单独列为缺陷。

**生产凭据在 Staging 准备阶段的边界。** `deploy-staging.yml:36–50` 的 prepare-evidence job 使用 production Environment 中的 `ECS_HOST/ECS_USER/ECS_SSH_KEY` 和云 AK；生产晋级 `promote-release.yml:42–48` 使用相同 Environment 和相同 secret 引用。这意味着“只读获取在线生产状态”描述的是实际执行的动作，不是独立只读凭据。SSH 还会创建/上传/删除 `/tmp/release-evidence-*`（`deploy-staging.yml:382–394`）。job 级凭据也会进入安装依赖等步骤。这里不存在“Staging build job 直接拿 production key”的证据，因为 build-deploy-verify 是另一台 staging Environment runner；但 prepare job 与生产部署拥有相同的凭据信任范围。

建议后续把生产观察统一收敛到已有 Evidence 服务，或使用受 forced-command/最小权限限制的单独观察账号，并按 step 注入凭据。未读取实际 secret 值、authorized_keys、sudoers 或 RAM 策略，因此没有把引用相同名称推断成“Staging 云身份一定能写生产”。

**共享资源。** 现有隔离器明确接受“特权主机仍可重新挂载共享 NAS 根目录”的残余风险，而不是物理隔离。未对这项既有明确接受的设计重复报新问题。

**业务验收。** 浏览器/Agent 验收是可选的，生产完成也不要求旧 15 分钟观察脚本。基础设施成功、确定性发布成功和真实业务成功应继续分别报告。对本次 Hand 事故，应增加能覆盖历史登记状态和真实 dispatch 的测试；不能只再加一个相同版本的 healthz 检查。本文没有重复列出该已知事故作为新发现。

## 5. 本地验证和未完成事项

执行过的本地检查：

```sh
node --test --test-reporter=dot \
  scripts/release/confirm-expand-migration.test.mjs \
  scripts/release/verify-promotion-phase-state.test.mjs \
  scripts/release/reconcile-promotion.test.mjs \
  scripts/release/verify-artifact.test.mjs \
  scripts/release/deploy-app-handoff.test.mjs \
  scripts/staging/ensure-integration-fixture.test.mjs
```

上述 **37 项通过**。另对 D-01 提取真实函数做了两种无真实 systemd/信号副作用的隔离复现，均得到告警后退出 0。

首次把 `verify-selected-release-artifacts.test.mjs` 一并运行时，共 52 项，38 通过、14 失败；失败落在 macOS BSD tar 不支持 `--quoting-style=literal` 的路径（`verify-selected-release-artifacts.mjs:79–90`），本机未发现 GNU `gtar`。因此没有将这 14 项说成测试通过，也没有据此认定 Ubuntu 工作流失败；未安装替代工具或修改测试绕过。移除该平台不兼容文件后，剩余 37 项独立通过。

本次未执行以下验证：

- 真实 Linux/systemd 蓝绿交接与 PID/信号故障注入；D-01 复现只验证 shell 的成功/失败语义。
- Staging/production 的 workflow dispatch、云端回滚演练、网络分区或 runner 强制终止。
- 云数据库 schema/迁移 ledger 的现场读取；当前 RC75 是否存在迁移遗漏尚未得到业务数据证据。
- 当前 RAM、SSH 用户、sudo、NAS、Kubernetes 网络和 RBAC 的现场重新审计；只检查对应采集和判断代码。
- 公网浏览器、Service Worker/CDN 故障复现，以及真实模型/Agent 工具执行。
- 整个仓库 CI 等价测试；本次是部署专项审查，不把选取回归的通过说成全量 CI 通过。

优先修 D-01、D-02，并把 D-03 的数据库后置条件纳入发布证据设计；D-04、D-05 可以分别在 Staging 失败处理和 Web 无写入 smoke 中落地。每一项都有独立触发路径，应分开实现和验证，避免在 Hand 修复中顺带改动两条发布工作流。
