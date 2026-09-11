# Grok 订阅 CI 验证入口

PR：[Grok 原生订阅与平台全局多账号池 #652](https://github.com/ZengLeiPro/agent-saas/pull/652)。

## 精确源码与结果

实施过程的独立验证包括代码提交 `fbd09175531a5a5e0eab0a660f1956d219c76d12`，对照主分支 `eec01d4c1d043a3de0eec54f9fc1ab8d64651c4b`，记录在 [34631801790](https://github.com/ZengLeiPro/agent-saas/actions/runs/34631801790)。后续运行 [34634367986](https://github.com/ZengLeiPro/agent-saas/actions/runs/34634367986) 验证历史审核补充后的代码。每轮报告记录实际 checkout SHA、远端 feature SHA、工作树是否干净、命令返回码、Vitest 通过/失败/跳过数量和失败断言；不能把运行控制分支 SHA 当作受测源码。

最终合并前以本 PR **当前 head SHA** 对应的标准 CI Checks 为准，不使用旧绿色记录替代最终提交检查。单元测试的既有 skip/todo 与实际执行成功分开统计；未完成的命令不能记为通过。

## 标准 CI 与独立验证

标准 PR CI 使用真实 PR base/head 元数据，覆盖静态检查、历史迁移审核、server/web/shared 分片测试与覆盖率、移动端类型/原生契约与 Web 导出、Web 生产构建、Writer 真实入口、真实 Release Bundle 启动、ACS 生命周期、PostgreSQL 契约及 Chromium 冒烟。既有 workflow、发布计划、签名与管理员权限门禁不变。临时开发 workflow 和应用脚本不在本 PR 的最终差异中。

独立 runner 位于单独的 workbench 分支，但 checkout 的是功能分支。其发布契约测试不读取无关的 workbench push event；同时显式执行 `grok-migration-evidence.mjs origin/main HEAD`，验证实际主分支到功能提交的完整变更闭包。此处理仅影响独立测试运行环境，不更改标准 PR CI 或迁移分类规则。

历史审核已对五个受本功能影响的既有运行时/类型/配置投影文件进行精确重审，保留旧分类、baseline 摘要及已有证据；新增负向断言保证源码变化或证据缺失仍拒绝。详细依据见[运行时装配重审](grok-runtime-assembly-migration.md)。必须再次运行完整 `check-reviewed-migrations.mjs`，不能以当前 main 单一基线通过替代全部已登记历史基线检查。

Grok 新表的后置条件在隔离 PostgreSQL 实际执行，覆盖短/长前缀、列/类型/空值约束、主键、有效 CHECK、默认值和有效索引；缺表、移除索引或移除 CHECK 必须失败。Codex 原 DDL 另有锁定旧源码的兼容性夹具。

## 交付边界

真实 SuperGrok 账号资格、OAuth client/scopes 的适用性、真实订阅推理和额度、双账号上游行为，以及生产蓝绿部署不由这些模拟测试证明，仍需按[发布指南](../grok-subscription-rollout.md)由获授权管理员验收。本 PR 不合并、不部署、不修改生产配置，也不以 API Key 成功替代订阅验收。

测试语义映射见 [T01–T36 对照](grok-subscription-validation.md)，日常使用见[操作指南](../grok-subscription.md)。
