# ACS / DWS 实施证据

## 源码检查点

| SHA                                        | 含义                                                  | 证据                                                                                            |
| ------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `30cacdc2e05a993f9a47a79c6dc035deffeb9171` | 审计交接基线                                          | 历史基准，不代表当前生产                                                                        |
| `8df72aaa3f3eaf4fc47ae3b24314b51b17d5b8b4` | reader/primitive 准备                                 | Evidence run 34376525189：回归 5 PASS/4 FAIL，primitive 14 PASS，typecheck/ratchets/bundle PASS |
| `fe4f6669c7312f17c3239ef86653dd69abffaacf` | invocation pump、shared owners、retained queue        | 中间实现检查点                                                                                  |
| `83f2b920c8b012c073036829ab8546c398861a95` | executor/manager/transport/lifecycle/diagnostics 接线 | 中间实现检查点                                                                                  |
| 本文件所在提交                             | A/B/C、T0、迁移审查与临时 authoring 清理完整候选      | 下表本地结果 + exact-SHA PR CI                                                                  |

## 需求到实现

| 范围                           | 实现                                                                                                                       | 失败边界                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A 等待/取消/诊断               | `ownedSharedWork.ts`、`remoteOwnership.ts`、`operationDiagnostics.ts`                                                      | journal 不可用或无精确 proof 时保持 unknown/blocker                               |
| B supervisor/receipt/reconcile | `executor.ts`、`runner_daemon.py`、`lateRunnerTerminal.ts`、`remoteOwnershipReconciler.ts`、`invocationRestartRecovery.ts` | 只接受 capability + exact fence + signed terminal；lease cleanup 失败进入恢复队列 |
| C ACS receiver                 | `dwsReceiverRoutes.ts`、`dws_receiver_state.py`、`sandboxRunner.ts`                                                        | drain 禁 start；输入/磁盘/页大小有限；错误显式返回                                |
| C Server authority             | `durableEventGateway.ts`、`durableDeliveryStore.ts`                                                                        | PG owner/revision/epoch 为 authority；业务提交前禁止 ACK                          |
| T0                             | `durableReceiverMigration.ts`、`agentDwsMigrationRoutes.ts`                                                                | 旧 journal 终态不完整即 `blocked`；只有 untouched `planned` 可 abort              |
| 构建/发布                      | ACS bundle/native smoke、V47 expand migration、postcondition、migration review、ratchet prune                              | 缺生产输入、未审 SQL 或 postcondition 不成立均阻断 CI/发布                        |

## 本地验证结果

| 命令/环境                                                    | 结果                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| `pnpm -F acs-orchestrator test`                              | 60 files / 461 tests PASS                                   |
| `pnpm -F acs-orchestrator typecheck`                         | PASS                                                        |
| `pnpm -F acs-orchestrator build`                             | PASS                                                        |
| PostgreSQL 16 原生容器运行 `durableDeliveryStore.pg.test.ts` | 11/11 PASS                                                  |
| Linux arm64 Python native control（root）                    | 23 PASS / 1 SKIP（同 UID 隔离需要非 root）                  |
| Linux arm64 Python native control（UID/GID 65534）           | 24/24 PASS                                                  |
| 新增 Server migration/gateway/routes 定向测试                | 6/6 PASS                                                    |
| PostgreSQL 16 运行 `migration-postconditions.pg.test.mjs`    | 5/5 PASS，含 V47 列/索引破坏性反向验证                      |
| `bash scripts/pr-preflight-task.sh postgres`                 | postcondition 5/5、Server 141/141、KY App Server 13/13 PASS |
| `pnpm -F server typecheck`                                   | PASS                                                        |
| `pnpm -F server build`                                       | PASS                                                        |
| `pnpm check:ratchets`                                        | PASS，grandfathered 大文件 52→49                            |

macOS 全量 Server suite 产生 123 files / 849 tests 失败，主错误为 `Trusted descriptor-relative file operations require Linux /proc` (`ENOTSUP`) 并引发并行级联；该运行被判定为平台不适用，不计通过。PR 的 Linux full suite 是合并硬门禁。

## 外部状态

- staging：`NOT_RUN`
- production：`NOT_RUN`
- 历史 DWS 完整性/补偿：`BLOCKED`，等待生产事实证据与独立授权
- T0 真实账号迁移：`NOT_RUN`，等待固定 staging RC、真实旧 owner inventory 与 rollback floor

CI 绿色只能证明 exact source 的代码与构建门禁，不证明生产部署、旧 listener 已停止或历史消息完整。
