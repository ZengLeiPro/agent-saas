# Runtime EventStore retention / capacity runbook

> 适用：PG `runtime_events`。禁止在生产执行未经本 runbook 门禁的 DELETE；禁止 90 天全表删除。本仓库不包含生产 RDS 容量、备份/PITR 或恢复成功事实。

## 1. Retention 矩阵

| 类别 | event_type / 条件 | 默认 TTL | 可删前置 |
|---|---|---:|---|
| 工具过程 delta | `tool_output_delta`,`tool_progress` | 工具终态后 10 分钟 | **同 tenant** 的 invocation 为 completed/failed/cancelled，且同 tenant/session/run/toolCall 的 `tool_result` 已持久化并过宽限期 |
| Assistant 流片段 | `assistant_stream_event` | run 终态后 10 分钟 | 同 tenant/session/run 已有 `run_finished` 且过宽限期 |
| 成功工具摘要 | `tool_stream_summary` 且 status=success | 24 小时 | 双水位通过 |
| 失败/取消工具摘要 | `tool_stream_summary` 其他状态 | 7 天 | 双水位通过 |
| 模型诊断过程 | `model_request_started`,`model_request_checkpoint` | 7 天 | 双水位通过 |
| 模型完成诊断 | `model_request_finished` | 30 天 | 不得短于模型诊断 TTL，双水位通过 |
| Hand 过程诊断 | `hand_provisioning_log`,`hand_health_changed`,`hand_failure` | 30 天 | 双水位通过 |
| 未列出的事实 | 消息、`tool_result`、工具生命周期、run/session 事实及其他类型 | 不自动删除 | 另立政策、数据映射与审批，不得借本任务删除 |

每批按 `global_sequence` 升序，以 `FOR UPDATE ... SKIP LOCKED` 锁候选并原子删除；默认每批 10,000、每类别每轮最多 10 批。运维 CLI 更保守，默认每类别每次仅 1 批。

## 2. 双水位语义

- **billing watermark**：`runtime_billing_projection_state[key='runtime_events'].last_global_sequence`，表示 billing 已消费到（含）的序号。
- **legal watermark**：法务/合规明确授权可删除到（含）的 `global_sequence`。它必须来自审批单，配置/CLI 缺省为 `0`，不得用 `MAX(global_sequence)` 自动代填。
- **effective delete-through** = `min(billing watermark, legal watermark)`；所有类别还必须满足各自 TTL/终态条件。
- legal hold、争议、调查或导出请求出现时：立即停用 execute，不得推进 legal watermark。标量水位不能表达历史区间 hold；若 hold 覆盖已授权区间，必须阻断整项 retention 并升级法务。

## 3. 删除前阻断门禁（全部满足）

1. **容量/增长率**：保存连续至少 7 天、同一时刻的 RDS 已分配空间、可用空间、`pg_database_size(current_database())`、`pg_total_relation_size('runtime_events')`；以每日差值给出 P50/P95 日增长。证据不足即阻断。
2. **空间余量**：RDS 告警阈值已配置；预计 30 天 P95 增长后仍有余量，且维护窗口可承受 DELETE 产生的 WAL/临时膨胀。控制台不能给出可用空间或 WAL 峰值预算时阻断，不凭代码猜测。
3. **备份/PITR**：取得覆盖 `agent_runtime` 的策略截图/导出、保留窗口、最近成功备份任务 ID、最早/最晚可恢复时间；任何一项未知即阻断。
4. **隔离恢复演练**：最近一次备份/PITR 恢复到非生产隔离实例；核对事件行数/最大序号、抽样 session 回放、billing watermark；记录恢复任务 ID、RTO/RPO、校验结果并销毁隔离实例。未演练或演练失败即阻断，禁止覆盖生产。
5. **授权**：变更单包含 legal watermark、billing watermark、effective watermark、dry-run 分类计数、batch 参数、维护窗口、观察人与回滚/停止条件，并获法务/数据 owner/DBA 明确批准。

只读采样（保存结果，不改库）：

```sql
SELECT now(), pg_database_size(current_database()) AS db_bytes,
       pg_total_relation_size('runtime_events') AS events_total_bytes,
       pg_table_size('runtime_events') AS table_bytes,
       pg_indexes_size('runtime_events') AS index_bytes;
SELECT n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables WHERE relname='runtime_events';
```

RDS 已分配/可用空间、备份/PITR 必须从云控制台/API 取证，不能由上述 SQL 推断。

## 4. Dry-run（默认、严格只读）

优先从未入库的 `config.json` 读取连接；不要把密码写进命令历史。

```bash
pnpm -C server maintenance:runtime-events -- \
  --legal-delete-through <审批中拟定的global_sequence> \
  --batch-limit 1000 --max-batches-per-category 1
```

生产主机上没有源码检出与 tsx，改用随 release 交付的 Admin Runner（同一 release、依赖和配置）：
`node dist/admin/runtime-events-maintenance.mjs …`，加载环境与配置的方式见
[`admin-runner.md`](admin-runner.md)。参数语义与本节完全一致。

不传 `--execute-retention` 时只执行 SELECT；不推进 billing projection、不取行锁、不 DELETE。输出只代表“下一批候选”，审批材料须同时保存 watermarks、分类候选数、表/索引大小及 `stats_reset`。

## 5. 显式授权后分批删除

先确认应用配置的自动 worker 未处于 execute，且 billing/法务水位与审批单一致。在低峰窗口每次只放一批：

```bash
pnpm -C server maintenance:runtime-events -- \
  --execute-retention \
  --legal-delete-through <已批准global_sequence> \
  --authorization-ref <CHG/审批单号> \
  --batch-limit 1000 --max-batches-per-category 1
```

生产主机等价命令：`node dist/admin/runtime-events-maintenance.mjs …`（同参数，见
[`admin-runner.md`](admin-runner.md)）。

每次执行后重跑 dry-run并观察 DB CPU/IOPS、复制延迟、锁等待、WAL、可用空间与应用错误率。任一越过审批阈值、watermark 变化异常、长锁等待、备份状态异常即停止；删除无 SQL 回滚，只能走已验证的隔离恢复/PITR 决策流程。不得在本任务中直接连生产或试删。

## 6. VACUUM 与索引空间回收

1. 删除后先观察 autovacuum；需要时由 DBA 在审批窗口执行 `VACUUM (ANALYZE) runtime_events;`。它回收页供表内复用，通常不会把文件空间归还操作系统。
2. 以 `n_dead_tup`、表/索引大小、索引扫描和 bloat 取证决定是否 `REINDEX INDEX CONCURRENTLY <index>`；逐个索引执行并监控额外磁盘/WAL。空间不足则阻断。
3. `VACUUM FULL` 会强锁并重写表，默认禁止；只有独立审批、容量预算、停机窗口与已验证恢复方案齐备时另案处理。
4. 旧索引 DROP 默认 fail-closed。先记录开始持续观测的 UTC 时间；执行时 CLI 以数据库 `now()` 为终点、以 `max(stats_reset, --index-observed-from)` 为有效起点，必须形成至少连续 7 天窗口。`stats_reset` 缺失/无效/晚于当前时间、参数缺失、有效窗口不足，均阻断整批且不得执行任何 DROP；不得把空统计或缺失统计当作 `idx_scan=0`。
5. 每个待删索引都必须在同一有效窗口内取得明确的 `idx_scan=0`：legacy event JSON GIN 依此证明零扫描；legacy `session_idx` 还必须存在 valid、ready、非 partial、首键为 `session_id` 的 btree 替代索引（例如表的 `UNIQUE(session_id, session_sequence)` 索引），不得无条件删除；可选 legacy `run_idx` 还必须与 `session_run_idx` 定义等价，否则阻断整批。任一候选证据失败时先完整停止，不允许先删已通过的索引。
6. 不可逆 DROP 继续要求已批准的 `--authorization-ref`；CLI 会先 trim，空串或纯空白均 fail-closed，审计输出只记录 trim 后的值。核对保存的只读快照、`stats_reset`、逐索引定义/扫描计数及替代索引定义后，才可在审批窗口执行：

```bash
pnpm -C server maintenance:runtime-events -- \
  --execute-drop \
  --index-observed-from <持续观测开始的ISO-8601时间> \
  --authorization-ref <CHG/审批单号>
```

`run_idx` 仅在上述全部门禁外再显式传 `--drop-run-idx`。CLI 在同一数据库 session 上按表名取得 session-level PostgreSQL advisory lock，完成整批初次取证后，仍会在**每个实际 DROP 前**重新读取数据库 `now()`/`stats_reset`、尚未执行候选的 `idx_scan` 与定义，以及已选替代索引的 validity/readiness/partial/定义；`stats_reset` 变化、窗口不足、扫描数非零、候选或替代索引缺失/失效/定义漂移时立即停止后续 DROP，并在 `finally` 解锁。`DROP INDEX CONCURRENTLY` 不能放入事务，因此该锁只串行化本维护脚本，不能阻止其他会话改 DDL/重置统计；仍须使用独占维护窗口并监控。任何 DROP 都无 SQL 回滚，不得在本任务中连接生产试跑。

## 7. 管理诊断状态与容量序列

平台管理员可只读调用 `GET /api/admin/system/event-store?hours=24`（`hours` 范围 1–720，默认 24）。接口只读取既有 `system_metrics`，不会触发 retention、DELETE、billing projection、索引操作或扫描 `runtime_events`。响应固定为 `schemaVersion: 1`、`available`、`generatedAt`、`retention`、`capacity`。

- retention 使用 `metric=runtime_event_retention,label=status` 的权威单例状态。合法 worker 启动时先写入 `scheduled`（当前 mode、sweep interval 与 timer 实际采用的 `nextScheduledAt`），成功落库后才武装 timer；首轮完成前因此显示“需关注”，不会沿用上个进程的绿色结果。worker 还会在每轮开始、成功、门禁阻断和失败时更新同一落点；execute 缺少授权或正数 legal watermark 时应用保持 fail-closed，并在真实启动路径写入脱敏 `blocked`，不会触发 EventStore 查询或删除。重复调用正在执行的 worker 不会覆盖 `running`。有 Store 但尚无快照时，接口派生 `never_run`，未知的下一轮时间保持 `null`。运行结果包括 `never_run/scheduled/running/dry_run_succeeded/execute_succeeded/blocked/failed`；新鲜度由独立 `stale` 布尔值表达，`unavailable` 仅表示当前状态不可验证。
- 快照字段包括 mode、sweep interval、最近开始/完成/成功时间、duration、nextScheduledAt、legal/billing/effective watermarks、max global sequence，以及每类别 eligible/deleted；同一类别前批已提交、后批失败时会保留累计 deleted，并据真实副作用标记 `partial_failure`。启动快照保留历史 `lastSuccessAt`，但当前 mode 与调度由本次启动覆盖；调度时间只来自 worker 快照，不按请求时间猜测。错误只保存并展示稳定白名单 `errorCategory`（`authorization_missing`、`legal_watermark_invalid`、`status_persistence_unavailable`、`partial_failure`、`execution_failed`）；持久层出现其他值时 API 降级为 `unavailable`，不展示错误 message、authorizationRef、SQL 参数或事件内容。启动 `scheduled/blocked` 无法落库时不武装 timer；已启用的 execute 每轮必须先成功写入 `running`，否则在 billing projection/EventStore 查询或 DELETE 前阻断。dry-run 或末态快照写入失败仍只记固定告警，不改写该轮业务结果。
- retention 过期阈值为 `max(2 × sweepInterval, 30 分钟)`；容量过期阈值为 30 分钟；最新容量或趋势样本明显晚于响应生成时间（允许 5 分钟时钟偏差）时，最新快照降级为不可用、未来趋势点被丢弃，前端 schema 同样拒绝越界响应。有 Store 但无运行快照时显示 `never_run`，Store 缺失、当前进程状态持久化不可用或快照契约不可识别时显示 `unavailable`；未知数值保持 `null`，不得解释成健康或 0。过期只设置 `stale=true`，不会覆盖最近一次 `failed/blocked/succeeded` 结果；页面在总体标记“已过期”的同时继续展示最近可信结果和稳定脱敏 `errorCategory`。API 按 state 校验时间、非负 duration、水位、max sequence 和固定六类分类摘要；成功状态缺字段、非法或明显晚于采样时间的运行时间、负数、分类缺失/未知、dry-run 出现删除量，或快照 mode/sweep 与当前配置不一致时均返回 `unavailable`。成功水位还必须满足 effective=min(legal,billing)、max≥billing，lag 由 max−effective 推导；未知 state 先归一为 `unavailable`，不能因采样时间较旧而伪装成合法旧结果。写入用事务级 advisory try-lock 做确定性无等待门禁；连接获取失败同样立即把当前进程状态持久化标为不可用，未获锁则回滚并让 worker 启动降级：不武装 timer、不推进 billing projection、不查询 EventStore、不 DELETE，HTTP 仍可启动；释放锁后可显式重试。成功获锁后按受索引支撑的最大 `id` 读取权威行，单调合并 `lastSuccessAt`，以 `clock_timestamp()` 更新并清理旧重复行；它不依赖事务开始时间，也不按 JSON 字段排序历史。普通 metrics 裁剪同样按最大 `id` 保留该状态，因此蓝绿进程乱序获锁、停用或长期故障后不会回退成更旧成功时间或 `never_run`。
- 容量继续复用 `metric=pg_table_size` 历史序列；每个 PG 表的 `valueNum=totalBytes`，`tableBytes` 使用 `pg_table_size`（含 heap、TOAST、FSM/VM，不含索引），`indexBytes` 使用 `pg_indexes_size`，`totalBytes` 使用 `pg_total_relation_size`。PostgreSQL `tablePrefix` 在配置层归一为小写，`capacity.series` 仅映射真实 events table 的既有采样。滚动发布期间遇到缺少任一三分量、负数、非法采样时间或 total 小于 table+index 的旧/无效样本时，容量整体返回“不可用”，不得显示绿色健康；趋势只有 0/1 个有效样本时总体状态为“需关注”，至少 2 个有效样本后才允许恢复“健康”。
- 性能边界：状态写入只通过 `runtime_event_retention/status` 的 partial `id DESC` 索引读取并更新一个权威行，首次遇到旧重复行时在锁内收敛为单例，不做每轮全历史 JSON 扫描或排序。一次接口请求只在 `system_metrics` 查询最新 retention、最新容量，并以 `metric='pg_table_size' AND label=<eventsTable> AND sampled_at>=...` 定向读取容量时间窗，使用既有 `(metric,label,sampled_at)` 索引；不会先加载同时间窗全部 metrics，也不做 runtime_events 的 COUNT/MAX、不启动采样或维护任务。

合并后至少观察两个 sweep 周期：确认 never-run 派生、合法启动先出现当前配置的 scheduled、启动门禁 blocked、running/成功状态按时更新、同类后批失败保留累计删除、乱序写入后 lastSuccessAt 单调、容量三分量和 total 对齐、容量趋势从不足 2 个有效样本的“需关注”恢复为“健康”、旧样本不显示健康、stale 在采样恢复后解除；同时检查固定的状态落库告警、system_metrics 增长量、接口 P95 延迟和平台管理员 403 门禁。

## 8. 生产取证清单


- RDS 实例/region/数据库标识（脱敏）、规格、存储类型、已分配与可用容量
- 7 天以上容量与 runtime_events 表/索引快照，P50/P95 日增长与 30 天 runway
- CPU/IOPS/WAL/复制延迟/连接/锁等待基线及停止阈值
- 备份策略、PITR 窗口、最近成功任务 ID、恢复权限 owner
- 隔离恢复实例/任务 ID、时间、RTO/RPO、行数/水位/抽样回放校验
- legal/data-owner/DBA 审批单、legal watermark 来源、billing watermark 查询结果
- 每批命令参数、开始/结束时间、分类删除数、VACUUM/REINDEX 回执
- `/event-store` 连续两个 sweep 周期的状态快照、容量采样、stale 恢复与接口延迟证据
