# PR644 后续：可执行的维护盘点、归档与故障摘要

日期：2026-09-11。基于固定 main `d59eca1e1cef7e83a1e59634569f80497ca37834`。
原交接 v1.2 的 H/F/T 编号和关闭条件保持不变；不修改历史审查或摘要绑定材料。

## 当前接续事实

PR #644 已于 `2026-09-11T12:44:25Z` 合并，合并提交为
`e04ffdae860311075a10c30b96a71bf36562b65b`。最终更新主线后的 head
`685aeea26e10bb48308cb76788498283e2340100` 的 CI #3770 / run `34600031850`
已完成且成功。不是仅借用旧 head `798c728…` 的 #3768。
因此 H02 的最小修复、文件消费回归和合并条件已具备，H02 可关闭；
H03/H04/H05/H06 的线上与运维关闭条件不随之自动满足。

本轮不再向已合并 PR 追加提交，改为关联 #644 的独立后续 PR。
上一轮（14:38Z 快照）上传中断，仅留下三个未被提交引用的 blob；原本地交付包保留该历史状态。
用户于 14:56Z 再次明确要求提交新 PR。本次重新读取 main、核对增量并重跑 54 项回归后，
通过正常 GitHub 写入接口提交完整源码。最终提交 SHA、PR 编号与 CI run/attempt 以本 PR 的
验证评论为准；未结束的运行不能引用旧 #644 或 main 的绿色结果替代。
#648 在另行处理 RC117 的生产恢复兼容问题，本增量不修改其迁移预检路径，
不触发新 RC、Staging、生产发布、恢复、凭据变更、分支删除或主机删除。

## H05：已经实现的工具，而不是仅写操作步骤

入口：`scripts/release/recovery-maintenance.mjs`。只依赖 Node 内置模块及
既有 `evidence-file.mjs`，不依赖 pnpm、数据库驱动、云凭据或 Docker。

支持四种模式：

```sh
node scripts/release/recovery-maintenance.mjs inventory <recovery-root>
node scripts/release/recovery-maintenance.mjs plan <recovery-root> <private-policy.json>
node scripts/release/recovery-maintenance.mjs archive <recovery-root> <new-private-archive-dir>
node scripts/release/recovery-maintenance.mjs verify-archive <archive-dir> <independent-snapshot-digest>
```

`recovery-root` 应含 `web/` 和 `retirements/`，线上对应
`/var/lib/agent-saas-release-recovery`。本轮只在隔离临时目录及历史证据副本运行，
没有访问线上这个目录。

### 盘点和预演

- 有界流式扫描并计算文件摘要；限制 4096 项、4 层、单文件 96 MiB、总计 512 MiB。
- 拒绝符号链接及其父目录、硬链接、FIFO/特殊文件、变化中的输入和超限内容。
- 输出容量、最早文件修改时间、终态分类、保护原因和告警代码；不解析或输出私有任务清单、租户内容及 capsule 正文。
- Web 按内容摘要、唯一终态回执、身份与时间判断；`active.json` 所指 capsule 即使 committed 仍保护。
- 退役按固定 run/attempt、targetDigest、进程身份、两个角色及 durable 计数判断；acknowledged、PID 消失、缺失/未知证明不得冒充 completed。
- 未知文件、缺失活动引用或任一未决记录均阻断全局清理候选；保守保留，不静默忽略。
- 保留时间、容量阈值、观察超时阈值必须显式提供；不替维护方设定线上政策。
- 当前发布、checkpoint、未结清任务引用必须由维护方从可信来源盘点后提供。引用快照须完整且在五分钟内；缺失、过期、未知、被引用或未到保留期均保留。

策略结构示意（数值只是隔离测试示例，不是批准的线上策略）：

```json
{
  "schemaVersion": 1,
  "retentionSeconds": 604800,
  "capacityWarningBytes": 536870912,
  "observerWarningSeconds": 1200,
  "references": {
    "complete": false,
    "observedAt": "2026-09-11T00:00:00.000Z",
    "releaseIds": [],
    "retirementOperations": [],
    "capsuleDigests": []
  }
}
```

示例故意使用 `complete=false`，直接运行必须全部保留；不能为通过预演而把未知引用填成空数组。
`archive_review` 仅是过保留期的人工归档审核建议，不是删除资格证明。
输出永远有 `cleanupAuthorized=false`，不提供 `delete`、`apply` 或 `--force`。
容量/退役观察陈旧告警仅被生成，`alertDelivery=not_attempted`；没有接入值班渠道。
`observerUnits=not_observed`，文件盘点不冒充 systemd 单元盘点。

### 归档及回读

归档只复制原字节，不删源、不补正坏 JSON。目标目录必须不存在且与源不相交；
新目录 0700、文件 0600，写入/回读均有界。保存带文件与目录清单的私有 Manifest，
完成文件、目录 fsync、逐字节摘要回读和源稳定性复核后，最后才写完成回执。
中断输出保留供排查，没有完成回执或出现篡改不得算作有效归档。
验证需传入盘点时独立保存的 snapshot digest，不接受“归档自己证明自己”。

**这是稳定受保护文件树的离线/维护工具，不是在线无锁清理器。** 调用方须有源及归档权限、
控制输入目录并协调现有主机锁及观察器写入。文件级检查不能替代对恶意并发写入的权限隔离。
归档目录含私有恢复材料，不能上传到公开 CI artifact、公共仓库或未批准的云盘。
本地复制不等于异地灾备。没有自动安装 timer、停止观察器或完成授权删除。

## H04 / T11 / F16：单独移交的故障摘要

收集器新增严格白名单的 `componentResults`，保留 ACS、App、Web 的
rollbackAttempted、rollbackVerified 和 before/target/mixed_or_unknown 状态。
缺失或矛盾证明返回 null，不把无证明解释成“未回滚”或“成功恢复”。

`promotion-detached-summary.test.mjs` 通过真实 reconcile 与 collector 生成摘要，
删除所有输入，再只读序列化后的摘要检查：ACS 已提交、App keep、Web 本地回滚、
最终矩阵、末尾资源 HEAD 的两次重试/124、预算、回滚范围与下一步动作。
未知外部副作用必须保留 needs_human，不能指示自动重试；不完整诊断不输出总体分位数。
这是**离线证据组合回归**，不是已执行真实 OSS/CDN 或整条工作流故障注入。
原 T01–T18 的完整云端验收继续按既有附录分别记录。

## 本地验证及执行边界

54 项回归在本地 Node 22.16.0 通过，无跳过：38 项维护工具、14 项回滚范围投影、2 项组合摘要。
所需的五个既有模块均按固定基线 Git blob 校验一致。原 collector 的两项组合回归失败；
恢复本地补丁后 54 项通过，日志保留。
本地没有完整仓库依赖，未运行完整 preflight；完整工作区验证交由本增量的正式 PR CI。
当前标准 `test:release-contracts` 的 `scripts/release/*.test.mjs` 会包含新增回归。
没有添加临时 workflow、提高环境变量预算、减少门禁或用测试标题替代实际断言。
后续只有成功提交并完成 CI 后，才可记录新的 head、受测 merge SHA、run/attempt 和结果。
旧 #644 的绿色结果不能用于证明本次增量。

用原 #47 ZIP 的三份退役原文件做离线复验：ZIP SHA-256 仍为
`dc34276833c868df431dfb432954633a5b61c2da9ddf0c9eee28b6fac1b7c199`；
旧观察时间仍是 `2026-09-11T09:29:32.183Z`，新工具将其判为 unverified 并保护。
扫描时间只是本次离线解析时间，不是主机新观察时间；未取得 #47 后续主机任务证据。

## H01–H08 本轮状态

| ID | 本轮进展 | 剩余边界 |
| --- | --- | --- |
| H01 | 保持原 #47 正常发布已核实 | 不证明此刻生产健康，不重复部署 |
| H02 | #644 最终 CI 成功且已合并，可关闭 | #648 的旧 RC 恢复属于独立增量 |
| H03 | 原退役文件离线复验；未知仍保护 | 未取得固定旧 generation 的线上后续材料 |
| H04 | 回滚范围摘要与离线移交回归 | 完整 T01–T18 云端/长任务/故障验收未完成 |
| H05 | 盘点、策略预演、复制归档、摘要回读及本地回归已实现 | 无线上政策批准、单元盘点、删除执行器、告警送达或灾备演练 |
| H06 | 六个原 workbench 分支仍存在且 head 与交接相同；五个正式源码入口仍在 | registry API 被连接器拒绝；未完成活动运行/依赖/完整证据归档核验，不删除 |
| H07 | 独立附录随增量提交，保留具体工具/测试及生产边界 | 最终 head 与 CI 结果见本 PR 验证评论，不借用历史结果 |
| H08 | 保留 #47 历史基线与 #644 的完整度判断 | 无同口径云端性能样本；SDK 复用等不盲目实施 |
