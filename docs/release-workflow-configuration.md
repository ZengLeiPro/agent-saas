# 发布 Workflow 外部配置

Workflow 只消费明确命名的 GitHub Environment 配置，不在仓库保存密钥。首次运行前必须创建
`staging` 和 `production` Environment；两者不设置 Required Reviewers，人工意图由
`workflow_dispatch` 和追加式 attestation 记录。

## staging

Secrets：`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`STAGING_ECS_HOST`、
`STAGING_ECS_USER`、`STAGING_ECS_SSH_KEY`、`RELEASE_EVIDENCE_TOKEN`、
`STAGING_E2E_USERNAME`、`STAGING_E2E_PASSWORD`。

Variables：`STAGING_RELEASE_OSS_URI`、`RELEASE_EVIDENCE_URL`、
`STAGING_ISOLATION_EVIDENCE_URL`、`STAGING_E2E_INTEGRATION_TASK_ID`、
`STAGING_SSH_HOST_KEY_SHA256`。其余非敏感域名、OSS bucket 和 ACR repository identity 固定在
Workflow 中，修改时必须走 CODEOWNER 审核。

`RELEASE_EVIDENCE_URL` 返回的记录必须绑定请求的完整 SHA，至少包含 Integration Candidate、
PR/check、当前生产矩阵及基线制品、组件分类、由 `migration-plan.mjs` 重算一致的迁移计划，
以及真实 N/N+1 兼容测试报告的 `compatibilityEvidenceDigest`。字段未知时 Workflow fail closed。

## production

Secrets：`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ECS_HOST`、`ECS_USER`、
`ECS_SSH_KEY`、`PRODUCTION_OBSERVATION_TOKEN`。

Variables：`PRODUCTION_OBSERVATION_URL`、`PRODUCTION_SSH_HOST_KEY_SHA256`。观察端点必须返回
绑定 release ID 和 Manifest digest 的连续探针样本，覆盖 HTTP/WS、Agent 首 Token/完整轮次/
恢复、Worker lease、Integration gate、Sandbox 生命周期、Cron 去重以及登录/会话/任务看板
只读路径。缺项、错误率超限或重复执行均阻断 `completed`。

## 外部设置

- 旧 `ci.yml` 与 `acs-sandbox.yml` 不再暴露 `workflow_dispatch`；它们只承担 App/ACS CI 和
  main push 的 ACR 自动构建。生产手动入口只能是 `promote-release.yml`。
- GitHub main ruleset 需独立应用 `config/github-main-ruleset.json`；应用前导出旧规则作为回退。
- Staging 资源按 `infra/staging/resource-plan.json` 创建，所有 `UNASSIGNED` 清零并完成反向隔离
  实测后才允许首次运行。
- `fc.kaiyan.net` 是共享域名，所有流程均不得使用 `fc3-domain`；本工作流只使用 OSS、ECS 和
  已明确配置的增量 DNS/反向代理资源。
