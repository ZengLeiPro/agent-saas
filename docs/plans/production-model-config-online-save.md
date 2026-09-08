# 生产模型配置在线保存：分阶段修复与未完成边界

日期：2026-09-08。状态：第一阶段代码修复；生产在线发布事务尚未实现，不能据此宣称生产保存已经恢复。

## 产品目标不变

管理员在当前环境的模型管理页保存，只修改该环境。生产需明确环境、二次确认、并发控制、审计、恢复与跨进程生效确认；不增加 Draft、审批平台，也不要求把 Staging 配置同步到 Production。遵循 `staging-production-config-parity.md` 的产品决策。

## 本阶段实际实现

- 配置服务公开与 `mutate` 使用同一判断的 `getWritePolicy()`；GET 和成功 PUT 返回能力元数据。环境来自服务端 Runtime 装配，客户端的 environment、allowProductionMutation 和 writePolicy 均不是授权输入。
- 生产限制稳定返回 HTTP 409、`PRODUCTION_CONFIG_PUBLISH_REQUIRED` 和写入策略，不再被模型路由的中文关键词匹配降格为 HTTP 400。
- 模型页加载时展示限制；缺少或未知策略也不推断为可写。保留面板导航，禁用配置编辑、增删、复制、拖拽、键盘排序和保存。
- 后端在编辑过程中拒绝写入时，前端撤销写权限但保留未保存草稿，不显示“已保存”。刷新失败也撤销旧可写能力。
- 独立订阅授权入口仍遵循自身权限和后端接口，不被模型配置的只读状态意外关闭。
- 提取纯类型以遵守已有文件行数棘轮，不抬高既有门槛，不新增依赖。

**本阶段没有删除生产门禁，没有向普通 Runtime 管理接口注入 `allowProductionMutation: true`，没有变更 ConfigIdentity 计算、Release identity 或部署脚本。它修复错误契约与误导性交互，但没有恢复生产在线保存。**

## 为什么不能只放开写入

`configIdentityRuntime.ts` 的 expected identity 在装配时绑定发布值。后台写盘后，API / Worker 只重算 observed identity；这不等于更新可信 expected identity。与此同时，`scripts/release/read-live-production-components.mjs` 还验证当前私有快照与 `runtime-identity.json`。只在 API 进程更新 expected、将 observed 无条件接受为 expected，或只添加可写旁路文件，都不构成完整生产发布。

## 后续完整实现需要关闭的契约

### 1. 独立且可信的配置版本权威

将代码制品身份和可在线调整的业务配置版本明确分层。保留不可变的发布基线；每次授权配置事务产生与环境、release、旧版本、目标摘要绑定的配置 revision。权威记录必须能由 API、Worker、部署与回滚工具共同验证。仅由业务进程任意可写的 JSON 不能单独成为可信权威；不得启动时自动接受磁盘漂移。凭据保持 SecretVault 引用，不输出明文。

### 2. 配置事务的阶段与故障语义

建议明确 `prepared -> applying -> applied` 和恢复失败状态。写入前在现有部署共用锁中核对 expectedRevision 与当前基线；完成整份配置及全部辅助模型引用校验、SecretVault 处理和备份，再提交候选。所有异步边界均要处理并发改写、进程崩溃和发布竞争，不能在未胜出的候选上发布 consistent。

API 与 Worker 都要读回目标 revision、目标摘要、当前进程身份及生效时间，且覆盖实际使用的模型解析器、标题/门禁链、定价和 memory.index 派生运行态。不得把“文件已写”“收到事件”或旧的 consistent 快照当作生效证据。未完成读回不能返回普通成功。

### 3. 回滚与凭据生命周期

应用失败时协调恢复配置、全部执行侧派生状态、可信配置版本和观察面。恢复无法证明成功则 fail closed 并保留诊断。旧 Secret 只能在所有相关运行进程不再使用且回滚策略允许时清理；结果不确定不能立即撤销仍可能被执行侧使用的凭据。崩溃恢复不能把半完成事务解释为已成功。

### 4. 发布与重启兼容

同时更新 `configIdentityAssembly.ts`、运行时摘要/Worker readiness、`read-production-state.mjs`、`read-live-production-components.mjs`、生产 deploy / rollback 的基线选择与验证契约。重启、重复发布、发布中断恢复、蓝绿切换和回滚都必须使用同一权威版本，不得把合法在线修改误判成漂移，也不能因此放过未经授权的文件变更。

### 5. 页面与回归验收

受控事务可用后，服务端才公开生产可写能力。原页面显示生产环境和明确确认，仍不新增审批平台。至少覆盖：真实生产模式成功保存、并发 409、无效引用、权限不足、凭据失败、API/Worker 分别失败或超时、读回滞后、提交后维护失败、崩溃/重启、合法修改后发布、回滚、非授权磁盘漂移、双环境隔离及已有测试环境行为。

## 本 PR 的验证边界

新增共享策略、模型 HTTP 路由和页面交互回归，并运行现有模型与配置治理定向测试。执行结果以 PR 的 GitHub Actions 和检查记录为准；本文不是测试通过证明。未连接或修改生产服务器、配置文件、SecretVault、运行时环境或部署资源，也不把单元测试替代真实生产事务验收。
