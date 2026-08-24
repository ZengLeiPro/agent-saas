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
       pg_relation_size('runtime_events') AS heap_bytes,
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

## 7. 生产取证清单

- RDS 实例/region/数据库标识（脱敏）、规格、存储类型、已分配与可用容量
- 7 天以上容量与 runtime_events 表/索引快照，P50/P95 日增长与 30 天 runway
- CPU/IOPS/WAL/复制延迟/连接/锁等待基线及停止阈值
- 备份策略、PITR 窗口、最近成功任务 ID、恢复权限 owner
- 隔离恢复实例/任务 ID、时间、RTO/RPO、行数/水位/抽样回放校验
- legal/data-owner/DBA 审批单、legal watermark 来源、billing watermark 查询结果
- 每批命令参数、开始/结束时间、分类删除数、VACUUM/REINDEX 回执
