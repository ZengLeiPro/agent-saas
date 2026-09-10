# 平台配置发布恢复运维说明

事务为 `applying`、`rolling_back` 或 `recovery_required` 时，新写入 fail closed。不得手工把 observed 写成 expected，不得删除签名、快照、回执或锁制造绿色状态。

恢复前固定同一 releaseId/SHA，读取 publication、raw revision、API/Worker 活动颜色、PID 和两端回执。仅在磁盘属于候选或 previous snapshot 时使用既有受控恢复入口；完成需同时确认 committed、raw revision、凭据版本摘要和双端新鲜回执一致。

未提交且可证明归属的候选凭据才清理；committed 最终确认丢失、恢复失败或归属不确定时保留；旧生产 ref 为历史恢复保留。Codex 显式撤销后，回滚旧配置前须确认历史引用可恢复，不能悄悄复活账号。

浏览器或代理丢失响应时，先用同一登录身份查询 `/api/admin/config-operations/<operationId>`。`applied` 表示可刷新业务 GET 核对；`committed_unconfirmed` 表示签名 head 已提交但最终双端确认响应不完整；`publishing`/`preparing` 不得重发；`recovery_required` 先执行同 release 的受控恢复；只有 `not_committed` 或 `rolled_back` 在重新读取 raw revision、重新核对草稿并重新确认后，才可生成新的 operationId。不得删除 operation journal 来绕过状态。

生产操作不在本 PR 授权范围内；本文只交付代码路径与演练规则。
