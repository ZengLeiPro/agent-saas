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
`STAGING_ISOLATION_EVIDENCE_URL`、`STAGING_E2E_INTEGRATION_TASK_ID`、
`STAGING_SSH_HOST_KEY_SHA256`。其余非敏感域名、OSS bucket 和 ACR repository identity 固定在
Workflow 中，修改时必须走 CODEOWNER 审核。

`RELEASE_EVIDENCE_URL` 指向仓库已实现的 `evidence-service.mjs` 的
`/release-evidence` 端点。返回记录必须通过 `release-evidence-schema.mjs` 的版本化完整 Schema，
绑定请求的完整 SHA，并包含 Integration Candidate、PR/check、当前生产矩阵及相互绑定的基线制品、
合法且满足 API/Runtime Worker 耦合约束的组件分类、由 `migration-plan.mjs` 重算一致的迁移计划，
以及真实 N/N+1 兼容测试报告的 `compatibilityEvidenceDigest`。Schema 校验和摘要复算都在不可变
写入之前完成，字段未知、缺失或冲突时 fail closed，不会占用并毒化该 SHA 的记录路径。

## production

Secrets：`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ECS_HOST`、`ECS_USER`、
`ECS_SSH_KEY`、`PRODUCTION_OBSERVATION_TOKEN`。

Variables：`PRODUCTION_OBSERVATION_URL`、`PRODUCTION_SSH_HOST_KEY_SHA256`、
`RELEASE_RECORD_OSS_URI`。观察 URL 指向 `evidence-service.mjs` 的
`/production-observation` 端点；端点必须返回
绑定 release ID 和 Manifest digest 的连续探针样本，覆盖 HTTP/WS、Agent 首 Token/完整轮次/
恢复、Worker lease、Integration gate、Sandbox 生命周期、Cron 去重以及登录/会话/任务看板
只读路径和真实业务验收。缺项、错误率超限、重复执行、服务端时间偏离实际采集时间，或首末
有效样本不足 15 分钟，均阻断 `completed`。

## 权威证据服务

仓库提供 `scripts/release/evidence-service.mjs` 和
`daemon-packaging/systemd/agent-saas-release-evidence.service.template`，不是只保留 URL
消费者。服务提供三个带 Bearer 鉴权的生产/读取端点：

- `/release-evidence?sha=<full-sha>`：完整 SHA 对应的 Integration、CI、生产基线、迁移和
  N/N+1 兼容证据；同一 SHA 使用不可覆盖写入。
- `/staging-isolation?releaseId=<rc-id>`：七项真实反向隔离拒绝证据；每次采集按时间和摘要追加。
- `/production-observation?releaseId=<rc-id>&manifestDigest=<digest>`：绑定 RC 和 Manifest 的
  连续生产探针样本；每个样本追加保存。

实际探针/集成系统用独立写身份通过 `POST` 写入，Workflow 只持有读身份并通过 `GET` 读取；
两端都必须带 `Authorization: Bearer <token>`，读写 token 禁止复用。服务会重算 release
evidence digest，校验隔离拒绝的新鲜度，
并校验生产样本的全部业务/运行检查。它不会在缺少真实探针时合成通过证据。运行参数：
`RELEASE_EVIDENCE_ROOT=/var/lib/agent-saas-release-evidence`、
`RELEASE_EVIDENCE_READ_TOKEN_FILE=<0600 read token file>`、
`RELEASE_EVIDENCE_WRITE_TOKEN_FILE=<0600 write token file>`、可选 `RELEASE_EVIDENCE_HOST` 和
`RELEASE_EVIDENCE_PORT`。

`STAGING_ISOLATION_EVIDENCE_URL` 应指向 `/staging-isolation`。Staging 与 Production 可部署
相互隔离的实例和 token；反向代理必须只暴露 HTTPS，数据目录必须落在持久盘。服务落地和真实
探针接入仍属于首次运行前的外部资源建设，不得用本地单测替代。

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

- 旧 `ci.yml` 与 `acs-sandbox.yml` 不再暴露 `workflow_dispatch`；它们只承担 App/ACS CI 和
  main push 的 ACR 自动构建。生产手动入口只能是 `promote-release.yml`。
- GitHub main 与 RC tag ruleset 需一起应用 `config/github-main-ruleset.json`、
  `config/github-rc-tag-ruleset.json`；后者禁止更新或删除 `refs/tags/rc-*`。应用前导出旧规则作为回退。
- Staging 资源按 `infra/staging/resource-plan.json` 创建，所有 `UNASSIGNED` 清零并完成反向隔离
  实测后才允许首次运行。
- `fc.kaiyan.net` 是共享域名，所有流程均不得使用 `fc3-domain`；本工作流只使用 OSS、ECS 和
  已明确配置的增量 DNS/反向代理资源。
