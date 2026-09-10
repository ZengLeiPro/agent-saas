# 兼容矩阵与运行手册

状态：代码与非生产验证已完成；staging/production 未执行。本文所有运行时动作仍需按具体环境、RC、账号和动作另行授权。

## 兼容矩阵

| 组合                                            | 必须行为                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| baseline ACS + baseline runner                  | 维持旧行为，不写新 ownership                                                |
| A reader + baseline runner                      | 未知/未来 ownership 保守阻断；取消不能把本地 transport 关闭当成远端已停     |
| B owner + baseline runner                       | capability 协商；没有精确终态证明时保留 owner                               |
| B owner + owned-attempt runner                  | 按 operation/attempt/UID/generation 验签并监督；单任务超时不关闭共享 daemon |
| C consumer + durable receiver                   | account epoch/revision/receiver fence；原始帧先落 PG，业务提交后才 ACK      |
| C consumer + 缺 receiver capability             | 明确 unsupported/blocker，不回退到 Shell 输出流                             |
| B/C state + reader-capable rollback             | 新 ownership 仍受保护；legacy reader 排除 `durable-v1` 与 `handoff_pending` |
| B/C state + below-floor rollback                | 管理接口返回 `reader_capable_rollback_floor_required`，发布不得继续         |
| malformed/future journal、lease、receiver state | fail closed，不按 TTL 删除或解释为空闲                                      |

最低安全回滚版本必须是包含 ownership reader、DWS delivery protocol reader 和所需 RBAC 的具体 release digest，不能写成分支名。当前尚未经过 staging RC 固定，因此生产 rollback floor 仍是 `NOT_RUN`。

## 控制接口

- ACS `GET /operations?invocationId=...`：只返回内存快照或 durable journal 快照并标记 provenance；journal 不可用时 503。
- ACS `GET /dws-receivers/capabilities`、`POST /dws-receivers/control`：复用 bearer 认证；控制请求包含 account/revision/epoch/receiver/workspace，输入和输出有硬预算。
- Server `GET /agent-dws-accounts/:accountId/durable-receiver-migration?tenantId=...`：读取迁移和 owner 诊断。
- Server `POST .../activate`：平台管理员提交 `tenantId + expectedRevision`，开始 T0。
- Server `POST .../reconcile`：只重试 `planned/handoff_pending/blocked` 的同一迁移。
- Server `POST .../abort`：只允许撤销尚未碰旧 owner 的 `planned` 记录。
- Server `POST .../rollback-check`：存在任何未 aborted 的迁移即拒绝 below-floor rollback。

诊断不得返回命令、stdout、环境变量、凭据或原始 DWS payload。ACK 只能推进到相同 owner fence 下已经业务提交的连续游标。

## T0 首次迁移

1. 为 exact environment、RC、账号和动作取得明确授权；本 PR 不包含这项授权。
2. 读取真实 release/image/config identity、旧 account owner、invocation、UID、mount 与 journal RBAC，固定 reader-capable rollback digest。
3. 在 staging 用同一 RC 演练 mixed image、journal 不可用、旧 owner 未终止和 receiver 重启；未知状态必须保持 blocker。
4. 调用 `activate`。事务先创建 `planned` registration；随后把账号改为 `handoff_pending` 并撤销 legacy runtime lease。
5. 请求旧 listener 停止，并查询 exact `agent-dws-events-{accountId}` journal。只有全部 operation 都是签名 `stopped/not_started` 才允许继续；本地 promise、HTTP 200 或 cancel accepted 均不是证明。
6. 在同一事务确认新 owner 未启动、游标均为 0、账号 revision 匹配，再切换 `durable-v1`。立即唤醒失败不回滚已提交的 authority，由 worker reconciliation 重试。
7. 验证 receiver epoch/revision、spool head、PG received/acknowledged cursor、业务 inbox/outbox 幂等和可见回复，记录 RC/SHA/image/log/事件 ID。
8. 只能 promotion 同一个 staging RC。不要额外 dispatch 第二次 ACS。旧 owner 证据缺失时迁移保持 `blocked`，不得以 sandbox 删除、重启或手工清表替代证明。

## 恢复与回滚

先读 dependency-independent diagnostics，再检查精确 operation/attempt。周期 reconciler 只接受绑定 UID/generation/attempt 的签名 receipt；pod 不存在、deadline 过期或进程号变化都不足以释放 owner。

Spool 压力必须显式报错并保留数据；不得静默丢帧、跳 cursor 或批量重放业务副作用。基础设施回滚前逐账号调用 rollback check，并与发布系统持有的具体 floor 对照。below-floor、强制中断、删除 sandbox 或数据修复都需要单独授权。

## 历史业务影响

`NOT_RUN / BLOCKED`。仍需生产侧核对来源连接缺口、上游 replay/ACK 语义、owner 转换、spool/inbox event ID、conversation/run/outbox 与最终可见回复。没有这些证据，不宣称历史完整或补偿成功。
