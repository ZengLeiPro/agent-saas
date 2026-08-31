# 发布 Workflow 外部配置

Workflow 只消费明确命名的 GitHub Environment 配置，不在仓库保存密钥。首次运行前必须创建
`staging` 和 `production` Environment；两者不设置 Required Reviewers，人工意图由
`workflow_dispatch` 和追加式 attestation 记录。

## staging

Secrets：`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`STAGING_ECS_HOST`、
`STAGING_ECS_USER`、`STAGING_ECS_SSH_KEY`、`RELEASE_EVIDENCE_TOKEN`、
`STAGING_E2E_USERNAME`、`STAGING_E2E_PASSWORD`。

`STAGING_E2E_USERNAME` 必须是只用于隔离 Staging 的平台管理员测试账号：E2E 要读取完整 run
trace 核对工具调用/结果和 ACS 执行目标，并在前后精确清理该账号拥有的 Sandbox。不得复用真人账号。

Variables：`STAGING_RELEASE_OSS_URI`、`RELEASE_EVIDENCE_URL`、
`STAGING_ISOLATION_EVIDENCE_URL`、`STAGING_SSH_HOST_KEY_SHA256`。其余非敏感域名、OSS bucket 和 ACR repository identity 固定在
Workflow 中，修改时必须走 PR 并通过 `Build & Check` 与 `ACS Impact Gate`。

`STAGING_E2E_INTEGRATION_TASK_ID` 不再由管理员预先填写。首次不可变 RC 启动 API 并完成数据库
迁移后，Workflow 在 Staging 数据库内事务性创建一个固定为 `canceled` 的隔离 fixture，权威读回
Taskboard 表、owner、source 和状态后才把 task ID 写入当前 job 环境。该 fixture 只证明迁移后的
真实存储与鉴权读取，不代表真实代码合并成功，也不能作为生产业务验收证据。

`RELEASE_EVIDENCE_URL` 指向仓库已实现的 `evidence-service.mjs` 的
`/release-evidence` 端点。返回记录必须通过 `release-evidence-schema.mjs` 的版本化完整 Schema，
绑定请求的完整 SHA，并包含最终 GitHub PR 合并事实、PR/check、当前生产矩阵及相互绑定的基线制品、
合法且满足 API/Runtime Worker 耦合约束的组件分类，以及由 `migration-plan.mjs` 重算一致的迁移计划。
Taskboard Integration Candidate 仅作为可选审计信息，不是 RC 前置条件。Schema 校验和摘要复算都在不可变
写入之前完成，字段未知、缺失或冲突时 fail closed，不会占用并毒化该 SHA 的记录路径。

## production

Secrets：`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ECS_HOST`、`ECS_USER`、
`ECS_SSH_KEY`、`PRODUCTION_OBSERVATION_TOKEN`、`RELEASE_EVIDENCE_WRITE_TOKEN`。

`PRODUCTION_OBSERVATION_TOKEN` 是 Evidence Service 的只读身份，当前只供
`部署预发 RC` 的 `prepare-evidence` 前置 job 写后回读使用；
`RELEASE_EVIDENCE_WRITE_TOKEN` 是专用于该前置 job 调用不可覆盖 `POST /release-evidence` 的独立写
身份。二者禁止复用。写 Token 只进入使用 `production` Environment 的证据 job，不进入使用
`staging` Environment 的实际部署 job 或 Production Promotion Workflow。

Variables：`PRODUCTION_OBSERVATION_URL`、`PRODUCTION_SSH_HOST_KEY_SHA256`、
`RELEASE_RECORD_OSS_URI`、`RELEASE_RECORD_OSS_REGION`。OSS Region 必须是对应 bucket 的实际
地域，Workflow 会对每次 OSS 请求显式传入，不依赖 runner 的隐式 CLI profile。
`PRODUCTION_OBSERVATION_URL` 目前仅作为同域 Evidence Service 的兼容基址，
`部署预发 RC` 的证据前置 job 会把末尾路径替换为 `/release-evidence`；Production Promotion 不再
读取 `/production-observation`，也不把 Agent、浏览器或业务验收放进部署门禁。

## 权威证据服务

仓库提供 `scripts/release/evidence-service.mjs` 和
`daemon-packaging/systemd/agent-saas-release-evidence.service.template`，不是只保留 URL
消费者。服务提供三个带 Bearer 鉴权的生产/读取端点：

- `/release-evidence?sha=<full-sha>`：完整 SHA 对应的 GitHub 合并、CI、生产基线和迁移证据；
  同一 SHA 使用不可覆盖写入。
- `/staging-isolation?releaseId=<rc-id>`：五项真实生产访问拒绝，以及两项共享 NAS 逻辑隔离
  读回证据；每次采集按时间和摘要追加，并显式记录主机特权身份可重新挂载文件系统根目录的
  已接受残余风险。
- `/production-observation?releaseId=<rc-id>&manifestDigest=<digest>`：保留给显式外部采样器的
  可选样本存储；没有真实采样器和样本时返回 404，不参与 Production Promotion。

Staging Workflow 会在每次 RC 部署后现场采集七项证据：六项由 Staging ECS 读取数据库权限、
NAS mount、通知配置、生产 ACS 网络拒绝、ACK RBAC 与 PVC/PV；Production OSS 写拒绝由 GitHub
Runner 使用 Staging 专用 RAM 身份发起带 `x-oss-forbid-overwrite` 的无损探针。完整证据随后传回
Staging ECS，由仅存在于该 ECS 的 Evidence Writer 写 Token 通过本机回环地址 `POST`；GitHub
Environment 只保存读 Token，既不保存也不传输写 Token。Workflow 再通过 HTTPS `GET` 回读并逐字段
比较，证据缺项、写权限意外放开或读写内容不一致都会 fail closed。`部署预发 RC` 的
`prepare-evidence` 前置 job 使用 `production` Environment，并同时注入用途隔离的写、读身份：
producer 仅用写 Token 执行不可覆盖 `POST`，publisher 仅用读 Token 执行 `GET` 与 canonical 比较；
两种 Token 均不进入后续 Staging 部署 job。相关端点都必须带
`Authorization: Bearer <token>`，读写 token 禁止复用。服务会重算 release
evidence digest，并校验隔离拒绝与共享 NAS 逻辑隔离读回的新鲜度；它不会在缺少真实探针时
合成生产观察样本。运行参数：
`RELEASE_EVIDENCE_ROOT=/var/lib/agent-saas-release-evidence`、
`RELEASE_EVIDENCE_READ_TOKEN_FILE=<0600 read token file>`、
`RELEASE_EVIDENCE_WRITE_TOKEN_FILE=<0600 write token file>`、可选 `RELEASE_EVIDENCE_HOST` 和
`RELEASE_EVIDENCE_PORT`。

`部署预发 RC` 被人工触发后，`prepare-evidence` 作为第一阶段锁定 dispatch 的完整 SHA，限时等待
同 SHA 的 `main` push `App CI / Deploy` 成功，验证唯一关联的已合并 GitHub PR，并使用与 ACS
Workflow 相同的分类器决定 `ACS Impact Gate` 是否必要；必要时等待并验证同 SHA 的 ACS push run。
如果该 SHA 已有通过 Schema 校验的不可变证据则直接复用，否则通过固定
host key 的 SSH 只读生产状态，在 `RELEASE_RECORD_OSS_URI` 的 `baselines/` 与 `records/` 中按每个
组件的生产 source SHA 和 digest 解析不可变 artifact index，绑定四类基线制品。解析不依赖 GitHub
Release 已存在，因此可覆盖首次 RC 前已经 seal 的生产基线；找不到摘要一致的对象时 fail closed。

发布证据写入前使用 `scripts/release/produce-release-evidence.mjs` 汇合五类独立输入：GitHub
合并快照与 checks、`read-production-state.mjs` 的生产读回、不可变基线制品、组件分类和迁移计划。
生产器要求最终 GitHub PR 的 merge commit 与两类 check 的 `headSha` 都等于完整发布 SHA，并重算
GitHub 合并快照摘要。普通 GitHub PR 与 Taskboard Integration PR 均可成为 RC 来源；若提供 Taskboard
task/source 快照，会作为可选审计信息写入，但不会成为准入条件。生成结果由专用 Evidence Writer
通过写 Token `POST` 到服务，再由 `publish-release-evidence.mjs` 使用只读 Token `GET` 回读并进行
canonical JSON 比较。写 Token 不得进入任何部署或晋级 job。

`STAGING_ISOLATION_EVIDENCE_URL` 应指向 `/staging-isolation`。反向代理只暴露带读 Token 的 HTTPS
读取端点，数据目录落在持久盘；写 Token 文件只保存在 Staging ECS 并由本机回环发布脚本读取。
服务落地仍属于首次运行前的外部资源建设，真实探针则由每次 Staging RC Workflow 自动重采，
不得用历史 JSON 或本地单测替代。

### GitHub PR 作为 RC 来源

RC 来源只要求可验证的 GitHub PR 已合入 `main`，其 `mergeCommitOid` 等于发布 SHA，并且最终 SHA 的
CI/check 已成功。Taskboard Delivery、Review 和 Integration 链仍可用于团队协作与附加审计，但不再是
生成 RC 或晋级 Production 的必要条件。直接合并的 GitHub PR 无需创建 remediation Taskboard 链。

## Migration plan 的闭包边界

Migration plan 从权威 runner 同时构建 baseline/target 相对 import/re-export 图。除了路径、命名和独立 metadata 外，权威入口真实 import 的 export binding 会跨 re-export、local alias、default export 与普通 barrel 传播到最终静态声明；其中出现 DDL/DML 就会自动进入分类，不能通过任意文件名、任意变量名或省略 `release-migration` metadata 脱离门禁。所有非 type-only 静态 import/re-export 都进入 runtime execution 图（含具名、default、namespace、`import {} from` / `export {} from`）；其中出现顶层可执行代码、runtime namespace、class 求值副作用或静态 SQL provider时纳入闭包，实际调用 binding 会反向穿透赋值 alias、对象/数组解构与 namespace import，`import()`、`require()`、`createRequire` 等无法静态证明的动态加载一律 fail closed。纯 type-only edge、普通静态 logger/store 与未调用的延迟函数声明不误判；普通 logger/runtime store 的只读查询不会仅因具名 import 自动归为 migration。Expand metadata 只识别真实注释，单引号、双引号、模板字符串及 PostgreSQL `$$...$$`/`$tag$...$tag$`（tag 支持 PostgreSQL Unicode identifier） 正文中的伪注释均无效，未闭合 dollar quote 直接 fail closed。Expand SQL 只允许纯 schema CREATE/单一 ALTER 白名单，`DEFAULT`、`CHECK` 等 ALTER 表达式中的不可证明函数调用（含 Unicode 与双引号函数名）与所有 INSERT 均 fail closed；需要数据回填时必须拆到单独受审计流程。

## 不可变发布记录

`STAGING_RELEASE_OSS_URI/records/<releaseId>/`（生产使用同值的
`RELEASE_RECORD_OSS_URI`）持久化 canonical Manifest、artifact index、只新增 attestation
快照和逐组件 operation receipt。GitHub Release 中的同名资产也只新增，禁止 `--clobber`。
RC annotated tag message 必须包含 `manifest-digest: sha256:...`；Promotion 同时核对 tag、GitHub
Release 与 OSS 三份绑定。`promoting` attestation 必须不可变绑定 release SHA、migration phase、plan
digest 与生产 before/target digest：`none` 才能直接完成，`expand` 只能先进入
`awaiting_expand_confirmation`。最终 append 会再次验证 confirmation evidence 的完整 schema、API
ready release ID/SHA、2 小时确认窗口及 5 分钟 live/evidence 新鲜度；通用 operation key 或陈旧证据
都不能绕过。窗口过期时，独立确认 Workflow 只能在 `production-runtime` 锁内追加一条完整绑定原
release SHA/Manifest/plan/before/target 的 `expand-reobservation` 自迁移，并先把新快照不可变写入
GitHub Release，再重新读取生产现场；未过期或错绑定刷新均拒绝。任何分叉 attestation、同路径
不同内容或 receipt 缺失都 fail closed。OSS bucket 还必须启用版本控制/保留策略或 WORM，并把 Workflow RAM 身份限制为不可删除、不可覆盖；
仓库 helper 能阻止正常流程覆盖，但不能替代云端对高权限凭据失陷的保留保护。升级前已存在、尚未携带 migration binding 的旧 `promoting` 记录只允许原样 hydrate 供审计读取；兼容读取不会补写或推断 digest，也不会放宽任何新的 `promoting` append，停在旧 `promoting` 的历史不能由新代码直接补成 `completed`。

`failed_before_change` 的安全重试尾链允许 `approved → promoting → failed_before_change`，但其中 `promoting` 必须带完整 Manifest、plan 与生产 before/target digest；悬空 `promoting`、缺失绑定或任何 post-mutation outcome 都不能重试。`rolled_back` 只能由部署脚本或 Web 恢复 trap 实际执行后的 rollback 证据，加上完整权威读回确认为原生产矩阵后得出；Web receipt 区分 attempted/succeeded，只有 identity 与 `index.html` 都恢复并从 OSS 按字节回读一致才算 succeeded，失败时即使 identity 回到 before 也必须 `needs_human`。单纯的 deploy step failure 不构成 rollback 证据，trap 安装前失败且现场仍为 before 只记 `failed_before_change`；durable `promoting` 后若 Deployment API 失败，复用 promoting 前已上传的只读 reader 通过 SSH stdout 完成现场读回，确认零 runtime mutation 后可记 `failed_before_change`。远端 payload、candidate、backup、rollback 与 readback 临时路径同时绑定 GitHub run ID 和 run attempt，重跑不得复用上一 attempt 的恢复证据。

Production Promotion 的成功状态还硬性依赖 trusted identity 写入后的确认读回：只有 readback step
成功且输出 `target_match=true`，才允许从 reconcile 的 `completed` 推进到最终 `completed` 或
`awaiting_expand_confirmation`；identity 写入或 `production-confirmed.json` 回读失败一律记录
`needs_human`，即使物理组件已等于目标也不能宣称发布完成。

生产 API、Runtime Worker 和 ACS 的运行目录会保留原始压缩包并写入组件级 byte seal，后续复用与
发布后读回都会重新计算压缩包和展开目录摘要。现有未带 byte seal 的旧目录不会被自动信任；首次
启用时必须让 RC 对三个运行组件执行 `deploy`，或在停机维护窗口用已知可信制品完成一次受审计的
seal bootstrap，不能仅根据旧目录名补写摘要。

## 外部设置与兼容入口边界

- `deploy-staging.yml` 按 `Evidence 准备/复用 → Staging RC 构建与部署` 两个隔离 job 执行。前置 job
  使用 `production` Environment，实际部署 job 使用 `staging` Environment；若缺少
  `RELEASE_EVIDENCE_WRITE_TOKEN` 或证据不一致，必须在构建 RC 前 fail closed，不得回退为人工伪造、
  复用只读 Token 或跳过生产基线读回。
- `ci.yml` 与 `acs-sandbox.yml` 永久保留 `workflow_dispatch` 人工兼容部署入口，但都只接受
  `refs/heads/main`：App 通道部署 dispatch 时选中的 main SHA；ACS 通道会在部署前校验 latest main，
  并在 exact-SHA ACR build record 尚未出现时继续拒绝已落后 main 的 dispatch。记录一旦进入
  `PENDING`/`BUILDING`，Workflow 就锁定该 exact SHA 与镜像继续等待；此后 main 前进不会把本次
  已锁定部署改成新 SHA，也不会单独取消它。两个入口都不能用于 dispatch 任意旧 commit/tag。
  push/PR 仍只执行 CI，不自动部署生产。这两个入口不生成不可变 RC、Staging E2E、
  Promotion receipt 或跨组件物理收敛证据，因此通过它们部署不等于新版发布契约已通过。
  需要完整发布证据链时使用 `promote-release.yml`，但不得因此关闭两个既有人工入口。
- Production Promotion 的硬门禁仅包含不可变制品、确定性 Staging 部署证据、物理组件收敛、
  runtime identity 和逐组件 durable receipts。完整浏览器、Agent 与业务验收由独立的
  `预发验收` 手工 Workflow 承担，默认不运行、不阻断 Promotion，也不写入发布 attestation。
- GitHub main 与 RC tag ruleset 需一起应用 `config/github-main-ruleset.json`、
  `config/github-rc-tag-ruleset.json`；后者禁止更新或删除 `refs/tags/rc-*`。应用前导出旧规则作为回退。
- main ruleset 按单人维护模式配置：不要求人工审批、CODEOWNER 审批或 Last Push Approval，但仍要求
  PR、Review 对话全部解决、分支基于最新 main，并通过 `Build & Check` 与 `ACS Impact Gate`。
- Staging 资源按 `infra/staging/resource-plan.json` 创建；只有清单为 `provisioned`、
  `firstDeploymentReadiness=ready`、`blockingConditions` 为空，并完成生产边界拒绝与共享 NAS
  逻辑隔离实测后，才允许首次运行。
- `fc.kaiyan.net` 是共享域名，所有流程均不得使用 `fc3-domain`；本工作流只使用 OSS、ECS 和
  已明确配置的增量 DNS/反向代理资源。
