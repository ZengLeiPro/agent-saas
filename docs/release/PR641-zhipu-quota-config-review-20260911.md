# PR #641：智谱额度配置无数据库结构变更审核

## 审核范围

仅审核 `server/src/app/modelQuotaSourceSchema.ts`，不改变迁移分类器、发布门槛、数据库后置条件或任何其他文件的既有审核分类。

本次比较基线为 `9db36e8861304c9254e545c80a17ccc720595af9`。原文件 SHA-256：`afb78574da5d2e916166535061558b47256e7db91774dd67d836adae12d8191f`；本次目标文件 SHA-256：`68dc1c9a83e7d7618cbb70896f045aaf2c4aeba08365c13bc4516bd733024638`。

历史审核仅可复用两类已核对前态：文件不存在，或内容摘要与上述原文件完全一致。其他前态必须单独审核，不能直接更新摘要。审核登记保留每个历史基线的真实文件摘要和原有证据，并追加本说明的摘要；目标字节、基线字节或本说明变化均须重新审核。

## 实际差异与结论

原模块仅导入 `zod` 并声明模型分组的火山套餐凭据校验与类型。目标模块保留火山字段及其默认值，增加 `zhipu_coding_plan` 和 `none` 两种来源；新增来源显式拒绝独立 `secretAccessKey`/`secretAccessKeyRef`，由现有模型分组 API Key 机制承载智谱鉴权。

本文件只构造 Zod 校验对象并导出 TypeScript 类型，不访问数据库、文件系统或网络。不包含 SQL、DDL、启动建表、迁移调用、回填、数据删除或新的持久化格式。分类为 **no-schema-change**，不是 expand，也不是数据库迁移豁免。

已有供应商配置保持兼容。新增智谱来源或显式关闭值属于应用配置的新增枚举；回滚到不识别这些枚举的旧版本之前，应先移除这些显式配置。默认自动识别官方地址的分组不需要新增枚举配置。

## 验证依据与边界

`server/src/__tests__/zhipuQuotaAdmin.test.ts` 覆盖新增来源校验、独立 Secret 拒绝、分组 Key 复用、来源切换及权限边界。`server/src/quota/providerQuotaService.zhipu.test.ts` 覆盖自动识别、Vault 读取、单分组刷新、采集失败回退与禁用后历史过滤。

审核记录必须继续通过现有 `migration-plan.test.mjs`、`http-transport-pr-base-review.test.mjs` 及完整 CI 验证。此次没有读取生产数据库或真实智谱密钥，未执行部署或数据库迁移，不宣称已完成真实账号联调。
