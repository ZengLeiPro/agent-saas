# Runtime Worker容量压测与性能判读

> 目标不是证明某个并发数字“看起来能跑”，而是找出在不同Run类型下，CPU、内存、Event Loop、PG队列和执行延迟随并发增长的真实曲线，以及第一个失控指标。

## 1. 为什么旧数据不能回答容量问题

下列指标只能描述采样时刻，不能证明并发安全：

- Worker自启动以来的平均CPU。
- 单次低负载时的RSS或cgroup `memory.current`。
- 未与Running/Pending Run数量绑定的主机内存。
- “file/slab可回收”这一静态判断。

容量结论必须把同一时间点的四层数据关联起来：

1. Node进程：CPU、RSS、Heap、External、ArrayBuffers、GC、Event Loop。
2. Worker cgroup：CPU、内存分项、Memory Event、I/O和CPU Throttling。
3. 宿主机：`MemAvailable`和CPU/Memory/I/O PSI。
4. Runtime负载：本地in-flight、PG全局Pending/Running/Waiting、Run类型和准入状态。

## 2. 结构化性能采样

Runtime Worker默认每30秒向journald输出一条：

```text
[RuntimePerf] {"schemaVersion":1,...}
```

配置：

```bash
AGENT_SAAS_RUNTIME_PERF_ENABLED=true
AGENT_SAAS_RUNTIME_PERF_INTERVAL_MS=30000
```

容量压测期间建议临时改为`2000`～`5000`毫秒。低于1秒会被钳制到1秒；不建议长期以1秒采样，因为每次采样包含一次PG活动Run计数查询和多次cgroup文件读取。

主要字段：

|字段|含义|
|---|---|
|`process.cpuPercent`|Node进程在采样窗口内的CPU，可超过100%|
|`process.rssBytes`|Node进程RSS|
|`process.heapUsedBytes`|V8 Heap Used|
|`process.externalBytes` / `arrayBuffersBytes`|Native/Buffer内存|
|`process.eventLoopDelay*`|Event Loop延迟分位数和最大值|
|`process.gc`|采样窗口内GC次数、总暂停和最大暂停|
|`cgroup.cpuPercent`|整个Worker cgroup（含子进程）的CPU|
|`cgroup.memoryCurrentBytes`|整个Worker cgroup内存记账|
|`cgroup.memory.*`|anon/file/slab/page table等分项|
|`cgroup.memoryEvents`|MemoryHigh、OOM和OOM Kill累计计数|
|`host.*Psi`|宿主CPU/内存/I/O压力|
|`workload.scheduler`|本Worker本地in-flight和类型分布|
|`workload.activeRuns`|PG全局Pending/Running/Waiting计数|
|`workload.admission`|Memory Pressure Guard是否仍在领取新Run|

性能采样只写结构化日志，不把高频样本写入PG，避免监控本身制造数据库压力。

## 3. 压测场景

必须分别跑场景，最后再跑混合场景；只跑一个短回复不能代表Agent负载。

|场景|目的|副作用|
|---|---|---|
|`model-short`|基础调度、上下游模型等待|产生模型调用费用|
|`context-replay`|约12KiB预填历史后的回放/上下文构造|模型输入费用较高|
|`tool-read`|Workspace读取和Tool Result事件|只读|
|`tool-shell`|Sandbox分配、exec、流式工具事件|执行固定无副作用命令|
|`subagent`|父Run等待子Run、共享全局并发池|产生额外Agent Run和模型费用|
|`mixed`|接近真实业务的混合负载|包含以上各类成本|

`subagent`需要单独谨慎看待：父Run等待前台子Agent时，父子都占全局Run容量。如果父Run填满全部并发槽，子Run可能长期Pending。首次测试不要直接从16并发开始，应按1/2/4/8递增并观察Pending与首进度延迟。

## 4. 压测工具

先只打印计划，不发送Run：

```bash
pnpm -F server benchmark:runtime-worker -- \
  --base-url=https://api.agent.kaiyan.net \
  --scenario=model-short \
  --tiers=1,2,4,8,16 \
  --waves=3
```

远端真实执行必须同时满足：

- token只通过`AGENT_SAAS_BENCH_TOKEN`环境变量提供，不接受CLI token。
- 传`--execute`。
- 传与URL完全一致的`--confirm-host`。
- 包含8或16并发时额外传`--confirm-high-concurrency`。

示例：

```bash
AGENT_SAAS_BENCH_TOKEN='仅放环境变量' \
pnpm -F server benchmark:runtime-worker -- \
  --base-url=https://api.agent.kaiyan.net \
  --confirm-host=api.agent.kaiyan.net \
  --confirm-high-concurrency \
  --scenario=model-short \
  --tiers=1,2,4,8,16 \
  --waves=3 \
  --settle-ms=30000 \
  --wave-gap-ms=5000 \
  --max-error-rate=0 \
  --execute
```

安全约束：

- 单次工具硬限制最高16并发。
- 每个Run有超时；超时后发送Abort。
- 任一波错误率超过阈值，停止后续波次和更高并发档。
- 每波后执行健康检查，失败立即停止。
- 工具场景只自动批准白名单工具，模型请求其他工具会被拒绝并标记失败。
- 每一波使用独立Session，避免上一波上下文增长污染下一波。

## 5. 推荐执行顺序

不要一次性把所有场景和所有并发档塞进一个批次。

1. `model-short`：1/2/4/8/16。
2. `context-replay`：1/2/4/8/16。
3. `tool-read`：1/2/4/8/16。
4. `tool-shell`：1/2/4/8/16。
5. `subagent`：1/2/4/8，确认无父子Run容量阻塞后再决定是否测16。
6. `mixed`：1/2/4/8/16。
7. 对首次出现压力或异常的相邻两档重复至少一个独立批次。

每档默认三波。同一档少于20个测量Run时，P95只能作描述性参考，不能用于SLA。

## 6. 日志导出与报告

记录压测开始时间后，从活动Worker unit导出包含前后基线的日志：

```bash
journalctl -u agent-saas-runtime-worker@green.service \
  --since '2026-08-03 23:00:00' \
  --until '2026-08-04 01:00:00' \
  -o cat > worker-runtime-perf.log
```

活动色必须按部署状态确认，不能照抄`green`。

生成汇总：

```bash
pnpm -F server benchmark:runtime-worker:report -- \
  --samples=worker-runtime-perf.log \
  --load=assets/20260803/Worker并发压测-*.json \
  --output-md=assets/20260803/Worker容量压测报告.md \
  --output-json=assets/20260803/Worker容量压测汇总.json
```

报告按每个测量窗口关联性能样本，不把Session预填和波次间隔误算成测量Run；Memory Event、CPU Throttle和I/O按窗口前后计数器差值汇总。

## 7. 停止条件与判读

任一条件出现时，不应继续提高并发：

- Run失败或超时。
- 健康检查失败。
- Memory Pressure Guard暂停领取。
- `memory.events.high`持续增长。
- `oom`或`oom_kill`增加。
- Event Loop出现500ms以上尖峰。
- PG Pending持续增长且前一档结束后不能回落。
- Worker cgroup CPU持续接近主机核数，或出现显著Throttle。
- Run结束后RSS/anon无法回到稳定基线，并在重复波次中单调抬升。

“通过”只能表述为：

> 本轮指定场景在并发N下未观测到失败、准入暂停、OOM或指定压力信号。

不能直接表述为：

> 并发N已经证明安全。

## 8. 优化决策映射

|证据|优先动作|
|---|---|
|Heap与GC随并发非线性增长|Heap Snapshot、对象保留链和上下文复制调查|
|External/ArrayBuffers增长|Buffer、流、SDK响应体和工具结果生命周期调查|
|进程CPU高、Event Loop高|CPU Profile/Flame Graph，定位同步计算和热循环|
|cgroup CPU高但Node CPU不高|子进程、Sandbox CLI和外部工具执行调查|
|file/slab增长并伴随PSI/High|Workspace扫描、NAS访问和目录项缓存调查|
|PG Pending/连接等待增长|连接池、SQL和Lease/Scheduler路径调查|
|父Run占满、子Agent长期Pending|为嵌套Run保留容量或重新设计父子调度语义|
|热点集中在可隔离计算|评估Go服务或FC任务|
|热点是等待模型/PG/NAS|换语言不是首要解法|
