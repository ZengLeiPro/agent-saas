// release-migration: expand
//
// WP3 Capability Gateway（规范 §6.1）的会话工具快照表。
// 全部 expand-only：一张新表 + 两个索引，均带 IF NOT EXISTS，不动任何既有对象。
//
// 版本号取 43 而不是 42：42 已分配给并行的 WP2b（目录变更流），
// 两条线各自独立落库，合并前本分支的版本序列会缺 42 —— 迁移 runner 按
// 「已应用版本集合」判定（migrations.ts:975-978），缺号不影响补齐。
export function governanceV43KyAppSessionToolSnapshotStatements(prefix: string): string[] {
  const snapshots = `${prefix}_ky_app_session_tool_snapshots`;
  return [
    // §6.1 会话工具快照：会话首个 run 创建并写入，后续 run（含审批恢复 / 交互恢复 /
    // 后台任务，且跨进程）只读。snapshot_key = 排序后的 `installationId:registeredDigest`
    // 组合，digest 变化即 key 变化即重建；installation_ids 单独成列供 installation.* 事件失效。
    `CREATE TABLE IF NOT EXISTS ${snapshots} (
      session_id TEXT PRIMARY KEY CHECK (char_length(session_id) BETWEEN 1 AND 200),
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      snapshot_key TEXT NOT NULL,
      installation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- entries 存 **TEXT 不是 JSONB**：JSONB 会重排对象键，而 entries 里的
      -- inputSchema 会原样作为 parametersJsonSchema 送给模型 —— 键序一变，
      -- 模型看到的工具定义就变了，prompt_cache_key 随之失配。
      -- 这张表存在的唯一理由就是让跨进程的工具面逐字节相同，因此必须保序。
      -- installation_ids 是字符串数组、只用于 @> 包含查询，用 JSONB 没有这个问题。
      entries TEXT NOT NULL DEFAULT '[]',
      degraded BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // 租户清理（data/tenants/cleanup.ts 口径）与运维排查按 tenant 扫描。
    `CREATE INDEX IF NOT EXISTS ${snapshots}_tenant_idx
      ON ${snapshots} (tenant_id,created_at DESC)`,
    // installation.* 事件按安装实例批量失效，走 JSONB 包含查询。
    `CREATE INDEX IF NOT EXISTS ${snapshots}_installation_idx
      ON ${snapshots} USING GIN (installation_ids jsonb_path_ops)`,
  ];
}
