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

`PRODUCTION_OBSERVATION_TOKEN` 是 Evidence Service 的只读身份；
`RELEASE_EVIDENCE_WRITE_TOKEN` 是专用于自动任务调用不可覆盖 `POST /release-evidence` 的独立写
身份。二者禁止复用。写 Token 只进入受 `main` 分支策略保护的 `Prepare Release Evidence`
Workflow，不进入 Staging 部署或 Production Promotion Workflow。

Variables：`PRODUCTION_OBSERVATION_URL`、`PRODUCTION_SSH_HOST_KEY_SHA256`、
`RELEASE_RECORD_OSS_URI`、`RELEASE_RECORD_OSS_REGION`。OSS Region 必须是对应 bucket 的实际
地域，Workflow 会对每次 OSS 请求显式传入，不依赖 runner 的隐式 CLI profile。观察 URL 指向
`evidence-service.mjs` 的
`/production-observation` 端点；端点必须返回
绑定 release ID 和 Manifest digest 的连续探针样本，覆盖 HTTP/WS、Agent 首 Token/完整轮次/
恢复、Worker lease、Integration gate、Sandbox 生命周期、Cron 去重以及登录/会话/任务看板
只读路径和真实业务验收。缺项、错误率超限、重复执行、服务端时间偏离实际采集时间，或首末
有效样本不足 15 分钟，均阻断 `completed`。

## 权威证据服务

仓库提供 `scripts/release/evidence-service.mjs` 和
`daemon-packaging/systemd/agent-saas-release-evidence.service.template`，不是只保留 URL
消费者。服务提供三个带 Bearer 鉴权的生产/读取端点：

- `/release-evidence?sha=<full-sha>`：完整 SHA 对应的 GitHub 合并、CI、生产基线和迁移证据；
  同一 SHA 使用不可覆盖写入。
- `/staging-isolation?releaseId=<rc-id>`：五项真实生产访问拒绝，以及两项共享 NAS 逻辑隔离
  读回证据；每次采集按时间和摘要追加，并显式记录主机特权身份可重新挂载文件系统根目录的
  已接受残余风险。
- `/production-observation?releaseId=<rc-id>&manifestDigest=<digest>`：绑定 RC 和 Manifest 的
  连续生产探针样本；每个样本追加保存。

Staging Workflow 会在每次 RC 部署后现场采集七项证据：六项由 Staging ECS 读取数据库权限、
NAS mount、通知配置、生产 ACS 网络拒绝、ACK RBAC 与 PVC/PV；Production OSS 写拒绝由 GitHub
Runner 使用 Staging 专用 RAM 身份发起带 `x-oss-forbid-overwrite` 的无损探针。完整证据随后传回
Staging ECS，由仅存在于该 ECS 的 Evidence Writer 写 Token 通过本机回环地址 `POST`；GitHub
Environment 只保存读 Token，既不保存也不传输写 Token。Workflow 再通过 HTTPS `GET` 回读并逐字段
比较，证据缺项、写权限意外放开或读写内容不一致都会 fail closed。Production
Promotion Workflow 同样只持有读身份。两端都必须带
`Authorization: Bearer <token>`，读写 token 禁止复用。服务会重算 release
evidence digest，校验隔离拒绝与共享 NAS 逻辑隔离读回的新鲜度，
并校验生产样本的全部业务/运行检查。它不会在缺少真实探针时合成通过证据。运行参数：
`RELEASE_EVIDENCE_ROOT=/var/lib/agent-saas-release-evidence`、
`RELEASE_EVIDENCE_READ_TOKEN_FILE=<0600 read token file>`、
`RELEASE_EVIDENCE_WRITE_TOKEN_FILE=<0600 write token file>`、可选 `RELEASE_EVIDENCE_HOST` 和
`RELEASE_EVIDENCE_PORT`。

`Prepare Release Evidence` 在 `main` 的 `App CI / Deploy` 成功结束后自动运行，无需管理员手工生成
或上传 JSON。它锁定该 CI 的完整 SHA，验证唯一关联的已合并 GitHub PR，使用与 ACS Workflow 相同
的分类器决定 `ACS Impact Gate` 是否必要；必要时等待并验证同 SHA 的 ACS push run。随后通过固定
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

## 不可变发布记录

`STAGING_RELEASE_OSS_URI/records/<releaseId>/`（生产使用同值的
`RELEASE_RECORD_OSS_URI`）持久化 canonical Manifest、artifact index、只新增 attestation
快照和逐组件 operation receipt。GitHub Release 中的同名资产也只新增，禁止 `--clobber`。
RC annotated tag message 必须包含 `manifest-digest: sha256:...`；Promotion 同时核对 tag、GitHub
Release 与 OSS 三份绑定。任何分叉 attestation、同路径不同内容或 receipt 缺失都 fail closed。
OSS bucket 还必须启用版本控制/保留策略或 WORM，并把 Workflow RAM 身份限制为不可删除、不可覆盖；
仓库 helper 能阻止正常流程覆盖，但不能替代云端对高权限凭据失陷的保留保护。

生产 API、Runtime Worker 和 ACS 的运行目录会保留原始压缩包并写入组件级 byte seal，后续复用与
发布后读回都会重新计算压缩包和展开目录摘要。现有未带 byte seal 的旧目录不会被自动信任；首次
启用时必须让 RC 对三个运行组件执行 `deploy`，或在停机维护窗口用已知可信制品完成一次受审计的
seal bootstrap，不能仅根据旧目录名补写摘要。

## 外部设置

- `prepare-release-evidence.yml` 自动完成 `main CI 成功 → Evidence 写入 → 独立读回`。若缺少
  `production` Environment Secret `RELEASE_EVIDENCE_WRITE_TOKEN`，它必须 fail closed；不得回退为
  人工伪造、复用只读 Token 或跳过生产基线读回。
- `ci.yml` 与 `acs-sandbox.yml` 永久保留 `workflow_dispatch` 人工部署入口，可按实际需要部署任意
  新旧版本；push/PR 仍只执行 CI，不自动部署生产。这两个入口不生成不可变 RC、Staging E2E、
  Promotion receipt 或 15 分钟生产观察证据，因此通过它们部署不等于新版发布契约已通过。
  需要完整发布证据链时使用 `promote-release.yml`，但不得因此关闭两个既有人工入口。
- GitHub main 与 RC tag ruleset 需一起应用 `config/github-main-ruleset.json`、
  `config/github-rc-tag-ruleset.json`；后者禁止更新或删除 `refs/tags/rc-*`。应用前导出旧规则作为回退。
- main ruleset 按单人维护模式配置：不要求人工审批、CODEOWNER 审批或 Last Push Approval，但仍要求
  PR、Review 对话全部解决、分支基于最新 main，并通过 `Build & Check` 与 `ACS Impact Gate`。
- Staging 资源按 `infra/staging/resource-plan.json` 创建；只有清单为 `provisioned`、
  `firstDeploymentReadiness=ready`、`blockingConditions` 为空，并完成生产边界拒绝与共享 NAS
  逻辑隔离实测后，才允许首次运行。
- `fc.kaiyan.net` 是共享域名，所有流程均不得使用 `fc3-domain`；本工作流只使用 OSS、ECS 和
  已明确配置的增量 DNS/反向代理资源。
