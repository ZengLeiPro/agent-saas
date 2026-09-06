/**
 * WP3 §6.4：把「本 run 用过哪些定制项目能力」带进 `usage-events`。
 *
 * 规范原文：「**不单独扣**；`usage-events` 增 `installationId`/`capabilityId`」——
 * 这两个字段只做归因与看板，不参与任何计费判定。
 *
 * 落法选 (a)**塞 `raw_usage_json`，零迁移**（锚点地图 D14 的建议）：
 * 加两列要改 `pgBillingStore` 的 DDL + INSERT 三处，而它在
 * `PRODUCTION_STARTUP_SCHEMA_ROOTS` 里，会触发一次没必要的生产迁移审核。
 * 聚合侧用 `raw_usage_json->'appCapabilities'` 取。
 *
 * **已知局限（进遗留清单）**：累加器是进程内的。能力调用发生在 API 进程、
 * 而计费投影可能在 runtime worker 进程跑，跨进程时这份归因会缺失。
 * 精确口径请用 `tool_audit` 的 `app_installation_id` / `app_capability_id`
 * 按 `run_id` 关联（WP3 已把这两列投影进 DuckDB），那份是逐调用落库的。
 */

/** 一个 run 内按 (installationId, capabilityId) 聚合的调用次数。 */
export interface AppCapabilityUsageEntry {
  installationId: string;
  capabilityId: string;
  calls: number;
}

/** run 数上限，防长跑进程无界增长；满了丢最早的一个 run。 */
const MAX_RUNS = 2_000;

const byRun = new Map<string, Map<string, AppCapabilityUsageEntry>>();

/** 每次能力调用（无论成败）记一次。失败也算用量归因，便于排查「一直在调但没成功」。 */
export function recordAppCapabilityUsage(
  runId: string | undefined,
  input: { installationId: string; capabilityId: string },
): void {
  if (!runId) return;
  let entries = byRun.get(runId);
  if (!entries) {
    if (byRun.size >= MAX_RUNS) {
      const oldest = byRun.keys().next();
      if (!oldest.done) byRun.delete(oldest.value);
    }
    entries = new Map();
    byRun.set(runId, entries);
  }
  const key = `${input.installationId}:${input.capabilityId}`;
  const existing = entries.get(key);
  if (existing) existing.calls += 1;
  else entries.set(key, { ...input, calls: 1 });
}

/** 读归因，按 `installationId` + `capabilityId` 排序，保证同一 run 每次读到同一序列。 */
export function readAppCapabilityUsage(runId: string | undefined): AppCapabilityUsageEntry[] {
  if (!runId) return [];
  const entries = byRun.get(runId);
  if (!entries) return [];
  return [...entries.values()].sort(
    (left, right) =>
      left.installationId.localeCompare(right.installationId) ||
      left.capabilityId.localeCompare(right.capabilityId),
  );
}

/** run 终态时回收（不调用也不会泄漏，`MAX_RUNS` 会兜住）。 */
export function forgetAppCapabilityUsage(runId: string): void {
  byRun.delete(runId);
}

/** 仅供测试。 */
export function resetAppCapabilityUsageForTest(): void {
  byRun.clear();
}
