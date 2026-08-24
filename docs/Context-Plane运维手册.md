# Context Plane 运维手册

## 1. 边界

- 所有同步、投影、检索和运维动作均按 `tenantId` 隔离。
- tenant/actor 只来自服务端认证；平台管理员读取内容时仍需目标租户 active membership、实时 entitlement、Assignment、current record、Evidence 与原生 ACL。
- 本手册不包含生产 migration、部署或数据删除命令。
- 派生层恢复采用**保留数据的幂等 replay**，不做 `TRUNCATE`/`DELETE` 式重建，避免丢失人工纠正与审核。

## 2. 健康度与失败可见性

组织管理 → 记忆与知识中的每个 Source/Collection 卡片展示：

- `lastSyncedAt`：最近一次完整 partition 的持久化时间；从未完整运行时为空。
- `watermarkLagSeconds`：优先使用 watermark 中的 `value`、`inventoryObservedAt`、`completedAt`、`observedAt`、`through`；没有时间型 watermark 时使用 partition heartbeat。
- `attention`：无 partition、失败/拒绝、等待重试，或完整 partition 已陈旧。
- `syncing`：至少一个 partition 正在同步。
- `healthy`：所有 partition 完整且 heartbeat 未陈旧。
- 陈旧阈值：Taskboard/Directory 5 分钟，DWS 2 小时，Azeroth 3 小时，未知 Source 24 小时。
- `retrying` 与 `nextRetryAt`：持久化 `retry_wait` 数量和最近重试时间。失败不会伪装成成功；当前实现没有把失败记录复制到第二套 DLQ，partition 本身就是可重试且可审计的 durable failure state。

收到告警时先核对 Source/Collection 是否 active、目标租户 entitlement、partition 的 `lastErrorCode`/`nextRetryAt`，再处理上游凭据或数据合同。不要通过跳过 ACL、手改 watermark 或清表“恢复”。

## 3. 派生投影安全 replay

### 3.1 Dry-run

```bash
DATABASE_URL='postgresql://...' pnpm -F server context:derived-replay -- \
  --tenant=<tenantId> \
  --table-prefix=<runtime table prefix>
```

Dry-run 只读取并打印：租户、consumer、当前 cursor、状态及 lease 是否活跃，不写数据库。

### 3.2 显式执行

先停止/隔离对应投影 worker，确保 dry-run 显示无 active lease；再使用刚看到的 cursor 做 CAS：

```bash
DATABASE_URL='postgresql://...' pnpm -F server context:derived-replay -- \
  --tenant=<tenantId> \
  --table-prefix=<runtime table prefix> \
  --expected-cursor=<dry-run cursor> \
  --confirm-tenant=<tenantId> \
  --apply
```

执行会将该租户 `context-deterministic-projector-v1` 的 cursor 重置为 `0`、提升 fence、清理旧 lease/error；不会删除实体、关系、派生项、纠正或审核。cursor 已变化、consumer disabled 或 lease 仍活跃时 fail closed。恢复 worker 后由现有有界批处理幂等重放。

## 4. 关系检索 A/B/C 评估

固定 dataset 使用 JSON：

```json
{
  "version": 1,
  "maxCandidatesPerVariant": 200,
  "thresholds": {
    "minRecallGain": 0.05,
    "minFollowupReduction": 0.10,
    "maxCitationPrecisionDrop": 0.01
  },
  "cases": [
    {
      "caseId": "project-owner",
      "relevantEntityIds": ["person-a"],
      "candidates": { "A": [], "B": ["person-a"], "C": ["person-a"] },
      "observations": {
        "A": { "citationValid": 1, "citationTotal": 1, "followupRequired": true, "latencyMs": 10, "aclLeaks": 0 },
        "B": { "citationValid": 1, "citationTotal": 1, "followupRequired": true, "latencyMs": 12, "aclLeaks": 0 },
        "C": { "citationValid": 1, "citationTotal": 1, "followupRequired": false, "latencyMs": 15, "aclLeaks": 0 }
      }
    }
  ]
}
```

- A：无关系扩展；B：一跳；C：最多二跳的 bounded adjacency。
- 每个 variant 的候选数受 dataset 上限约束，重复 `caseId`、超限候选或非法指标直接失败。
- B/C 必须都有 citation、follow-up、latency、ACL 样本；C 出现任何 ACL leak 均失败。

运行并保存可复现报告：

```bash
pnpm -F server context:relation-eval -- \
  --dataset=<fixed-dataset.json> \
  --output=<report.json>
```

报告包含 dataset SHA-256、A/B/C metrics 和增量门禁；通过退出码为 `0`，不满足阈值退出码为 `1`。报告不写运行时间，确保同一 dataset 生成相同结果。仓库内 `phase4-baseline-v1.json` 只是验证 runner、指标与 CI 门禁可工作的固定合同样本，不代表真实产品收益；关系扩展上线判断必须换成独立标注的真实评测集。

## 5. 合并前验证

```bash
pnpm -F server run typecheck
pnpm -F @agent/shared run typecheck
pnpm -F web run typecheck
pnpm check:ratchets
TEST_DATABASE_URL='postgresql://...' pnpm preflight:pr
```

PostgreSQL 合同测试必须在 PostgreSQL 16 上执行。合并只认 PR 精确 head 的权威 CI，不以本地跳过的 PG 测试代替。
