// release-migration: expand
//
// WP2b 组织目录变更流（规范 §3.6、附录 L）的治理库结构。
// 全部 expand-only：两张新表 CREATE TABLE / CREATE INDEX 均带 IF NOT EXISTS；
// 对既有对象的唯一改动是 tenant_memberships 追加一列 employee_no
// （ADD COLUMN IF NOT EXISTS，可空、带长度 CHECK），不删表、不删列、不改列类型。
//
// 为什么必须另建变更日志表而不是给现有表拼水位（锚点地图 A3 已核实）：
// - users 仍是 JSON 文件存储，没有任何单调序列；
// - directory_group_members 的投影写入是「DELETE 全量 + 重插」，成员移除不留痕，
//   没有删除墓碑，消费端无从得知「谁被移出了部门」；
// - tenant_memberships 的 version 是按行自增，跨行不可比较。
// 三个源没有统一事务，也没有跨表可比较的水位，只能由本表兜底。
export function governanceV42KyAppDirectoryStatements(prefix: string): string[] {
  const changeLog = `${prefix}_ky_app_directory_change_log`;
  const state = `${prefix}_ky_app_directory_state`;
  const memberships = `${prefix}_tenant_memberships`;
  return [
    // §3.6 变更流：全局单调 seq 是消费端续流的唯一游标，因此 seq 不按租户分段。
    // 空洞风险（「后申请者先提交」）由读侧的 LOCK TABLE ... IN SHARE MODE 消除，
    // 口径同 server/src/runtime/pgEventStore.ts 的 queryWithEventsShareLock。
    `CREATE TABLE IF NOT EXISTS ${changeLog} (
      seq BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE CHECK (char_length(event_id) BETWEEN 1 AND 64),
      tenant_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'governance' CHECK (source IN ('governance','dingtalk')),
      type TEXT NOT NULL CHECK (type IN (
        'user.upsert','user.remove','group.upsert','group.remove'
      )),
      entity_id TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS ${changeLog}_tenant_seq_idx
      ON ${changeLog} (tenant_id,seq)`,
    // 30 天保留清理按 occurred_at 扫描；同时用于计算保留期下界（早于下界 → 410 cursor_expired）。
    `CREATE INDEX IF NOT EXISTS ${changeLog}_retention_idx
      ON ${changeLog} (occurred_at)`,
    // 已投影的目录态。存在的意义有两个：
    // 1. 投影器靠它与源端期望态做差分，才能为「DELETE 全量重插」的成员表补出删除墓碑；
    // 2. Phase B 的快照分页直接读它，保证同一 snapshotSeq 下各页一致。
    `CREATE TABLE IF NOT EXISTS ${state} (
      tenant_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('user','group')),
      entity_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      digest TEXT NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
      updated_seq BIGINT NOT NULL CHECK (updated_seq >= 1),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id,entity_type,entity_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${state}_watermark_idx
      ON ${state} (tenant_id,updated_seq)`,
    // §3.6 附录 L 的 employeeNo：组织内工号，天然是「成员」属性而不是「账号」属性，
    // 因此落在 tenant_memberships 而不是 users（users 仍是 JSON 文件存储，无法建索引）。
    // 长度上限 32 与附录 L 的 maxLength 一致；可空，来源为 WP5 的 CSV 导入/管理界面录入。
    `ALTER TABLE ${memberships} ADD COLUMN IF NOT EXISTS employee_no TEXT
      CHECK (employee_no IS NULL OR char_length(employee_no) BETWEEN 1 AND 32)`,
    `CREATE INDEX IF NOT EXISTS ${memberships}_employee_no_idx
      ON ${memberships} (tenant_id,employee_no) WHERE employee_no IS NOT NULL`,
  ];
}
