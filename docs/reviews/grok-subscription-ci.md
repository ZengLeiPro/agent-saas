# Grok 订阅 CI 验证入口

PR：[Grok 原生订阅与平台全局多账号池 #652](https://github.com/ZengLeiPro/agent-saas/pull/652)。

## 精确源码与结果

最终源码核验基线为 `main@eec01d4c1d043a3de0eec54f9fc1ab8d64651c4b`。独立运行 [34635258347](https://github.com/ZengLeiPro/agent-saas/actions/runs/34635258347) 实际 checkout 并验证 `beac0285593ee804b5439095490d89387ef009bc`：报告同时记录实际源码 SHA、远端功能分支 SHA、干净工作树、各命令退出码、测试通过/失败/跳过数量。控制分支的 SHA 不是受测源码 SHA。

最终合并前以本 PR **当前 head SHA** 对应的标准 CI Checks 为准，不使用旧绿色记录替代最终提交检查。独立验证和标准 PR CI 都保留失败记录，未完成或跳过的命令不能记为通过。标准 CI 在本文件更新后对当前提交重新运行，结果不在源码内自我声明为成功。

## 标准 CI 与独立验证

标准 PR CI 使用真实 PR base/head 元数据，覆盖静态检查、历史迁移审核、server/web/shared 分片测试与覆盖率、移动端类型/原生契约与 Web 导出、Web 生产构建、Writer 真实入口、真实 Release Bundle 启动、ACS 生命周期、PostgreSQL 契约及 Chromium 冒烟。既有 workflow、发布计划、签名与管理员权限门禁不变。临时开发 workflow 和应用脚本不在本 PR 的最终差异中。

独立 runner 位于单独的 workbench 分支，但 checkout 的是功能分支。其发布契约测试不读取无关的 workbench push event；同时显式执行 `grok-migration-evidence.mjs origin/main HEAD`，验证实际主分支到功能提交的完整变更闭包。完整 `check-reviewed-migrations.mjs` 在其他测试之前运行，检查全部 44 个已登记历史基线。此处理不更改标准 PR CI 或迁移分类规则。

## 历史迁移审核

五个受本功能影响的既有运行时/类型/配置投影文件经过精确重审，保留旧分类、baseline 摘要及已有证据，见[运行时装配重审](grok-runtime-assembly-migration.md)。新增负向测试保证源码变化或证据缺失仍被拒绝。

全部 source/evidence 绑定逐项核对后，最后一条失效绑定位于迁移计划的启动根清单。实际 diff 仅把 Codex 兼容导出替换为两个真正执行初始化的公共 store；分类算法、依赖闭包、拒绝条件与发布门禁不变。该项单独复核并更新一个精确证据摘要，见[启动根证据重审](grok-startup-root-evidence.md)。没有根据连锁错误批量放行其他文件。

Grok 新表的后置条件在隔离 PostgreSQL 实际执行，覆盖短/长前缀、列/类型/空值约束、主键、有效 CHECK、默认值和有效索引；缺表、移除索引或移除 CHECK 必须失败。Codex 原 DDL 另有锁定旧源码的兼容性夹具。当前 main 单一基线通过不替代完整历史基线验证。

## 交付边界

真实 SuperGrok 账号资格、OAuth client/scopes 的适用性、真实订阅推理和额度、双账号上游行为，以及生产蓝绿部署不由模拟测试证明，仍需按[发布指南](../grok-subscription-rollout.md)由获授权管理员验收。本 PR 不合并、不部署、不修改生产配置，也不以 API Key 成功替代订阅验收。

测试语义映射见 [T01–T36 对照](grok-subscription-validation.md)，日常使用见[操作指南](../grok-subscription.md)。
