# Grok 订阅 CI 验证入口

PR：[Grok 原生订阅与平台全局多账号池 #652](https://github.com/ZengLeiPro/agent-saas/pull/652)。

## 精确源码与结果

本轮独立验证的代码提交为 `fbd09175531a5a5e0eab0a660f1956d219c76d12`，对照主分支 `eec01d4c1d043a3de0eec54f9fc1ab8d64651c4b`。运行入口为 [Grok isolated final verification / 34631801790](https://github.com/ZengLeiPro/agent-saas/actions/runs/34631801790)。该运行的检查报告记录实际 checkout SHA、远端 feature SHA、工作树是否干净、每项命令返回码、Vitest 通过/失败/跳过数量和失败断言。报告仅包含隔离测试数据。

最终合并前以本 PR **当前 head SHA** 对应的标准 CI Checks 为准。不要将独立 runner 的控制分支 SHA 当作受测源码，也不要使用旧绿色记录替代最终提交检查。单元测试的既有 skip/todo 与实际执行成功分开统计；未完成的命令不能记为通过。

## 两种环境的迁移验证

标准 PR CI 使用真实 PR base/head 元数据，既有 workflow、发布计划、迁移审核、配置签名和管理员权限门禁不变。临时开发 workflow 和应用脚本不在本 PR 的最终差异中。

独立 runner 位于单独的 workbench 分支，但 checkout 的是功能分支。其发布契约测试不读取无关的 workbench push event；同时显式执行 `grok-migration-evidence.mjs origin/main HEAD`，验证实际主分支到功能提交的完整变更闭包。此处理仅影响独立测试运行环境，不更改标准 PR CI 或迁移分类规则。

Grok 新表的后置条件在隔离 PostgreSQL 实际执行，覆盖短/长前缀、列/类型/空值约束、主键、有效 CHECK、默认值和有效索引；缺表、移除索引或移除 CHECK 必须失败。Codex 原 DDL 另有锁定旧源码的兼容性夹具。

## 交付边界

真实 SuperGrok 账号资格、OAuth client/scopes 的适用性、真实订阅推理和额度、双账号上游行为，以及生产蓝绿部署不由这些模拟测试证明，仍需按[发布指南](../grok-subscription-rollout.md)由获授权管理员验收。本 PR 不合并、不部署、不修改生产配置，也不以 API Key 成功替代订阅验收。

测试语义映射见 [T01–T36 对照](grok-subscription-validation.md)，日常使用见[操作指南](../grok-subscription.md)。
